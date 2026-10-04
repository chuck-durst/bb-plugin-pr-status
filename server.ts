// bb-plugin-pr-status — the pull request of a thread's branch, always in
// view, with the next step one click away (the way Conductor does it).
//
// bb already knows each environment's PR (`sdk.environments.pullRequest`),
// so that is the source of truth. The plugin caches one snapshot per thread,
// re-reads the threads someone is looking at on a slow timer, and publishes
// PR_CHANGED when a snapshot changes so the header button refetches. `gh` is
// only used for what bb does not expose: the failing checks and their logs,
// unresolved review threads, and the repository's merge method.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { derivePrKind, type PrAttention, type PrKind } from "./lib/pr-state";

/** Realtime channel; the payload is `{ threadId }`. */
export const PR_CHANGED = "pr-changed";

const prSchema = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.enum(["open", "draft", "merged", "closed"]),
  attention: z.string(),
  kind: z.string(),
  baseRefName: z.string(),
  headRefName: z.string(),
  autoMerge: z.boolean(),
  checks: z.object({
    state: z.string(),
    failedCount: z.number(),
    passedCount: z.number(),
    pendingCount: z.number(),
    totalCount: z.number(),
  }),
  review: z.object({ state: z.string(), reviewRequestCount: z.number() }),
  mergeability: z.object({ state: z.string(), mergeStateStatus: z.string().nullable() }),
  inMergeQueue: z.boolean().nullable(),
});
export type PrInfo = Omit<z.infer<typeof prSchema>, "attention" | "kind"> & {
  attention: PrAttention;
  kind: PrKind;
};

const snapshotSchema = z.object({
  /**
   * `pr`: there is one. `none`: the branch has no PR (`canCreate` says
   * whether offering one makes sense). `unavailable`: no workspace, not a
   * GitHub repo, `gh` not signed in…
   */
  outcome: z.enum(["pr", "none", "unavailable"]),
  pr: prSchema.nullable(),
  canCreate: z.boolean(),
  message: z.string().nullable(),
  fetchedAt: z.number(),
});
export type PrSnapshot = Omit<z.infer<typeof snapshotSchema>, "pr"> & { pr: PrInfo | null };

const threadInput = z.object({ threadId: z.string().min(1) });

export const rpcContract = defineRpcContract({
  pr_get: {
    input: z.object({ threadId: z.string().min(1), force: z.boolean().optional() }),
    output: snapshotSchema,
  },
  pr_mark_ready: {
    input: threadInput,
    output: z.object({ message: z.string() }),
  },
  pr_update_branch: {
    input: threadInput,
    output: z.object({ message: z.string() }),
  },
  pr_merge: {
    input: threadInput,
    output: z.object({ message: z.string(), method: z.string() }),
  },
  pr_prompt: {
    input: z.object({
      threadId: z.string().min(1),
      action: z.enum(["create", "fix_checks", "fix_conflicts", "address_review"]),
    }),
    output: z.object({ prompt: z.string() }),
  },
});

/** A thread stays watched this long after the app last asked about it. */
const WATCH_TTL_MS = 10 * 60_000;
const TICK_MS = 10_000;
/** How old a snapshot may get before the poller re-reads it. */
const REFRESH_CHECKING_MS = 10_000;
const REFRESH_PENDING_MS = 30_000;
const REFRESH_OPEN_MS = 60_000;
const REFRESH_DONE_MS = 5 * 60_000;
const REFRESH_NONE_MS = 2 * 60_000;
/** RPC reads return the cached snapshot when it is this fresh. */
const CACHE_FRESH_MS = 15_000;

const GH_TIMEOUT_MS = 20_000;
const MAX_FAILED_CHECKS = 5;
const MAX_LOG_LINES = 60;
const MAX_LOG_CHARS = 4_000;
const MAX_REVIEW_THREADS = 30;
const MAX_COMMENT_CHARS = 1_500;

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** `{ repo: "owner/name", number }` from a GitHub PR URL. */
function parsePrUrl(url: string): { repo: string; number: number } | null {
  const match = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  if (match === null) return null;
  return { repo: `${match[1]}/${match[2]}`, number: Number(match[3]) };
}

// The bb server is started by the desktop app, whose PATH rarely includes
// Homebrew. Look in the usual places before trusting PATH.
const GH_BINARY =
  ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"].find((path) => existsSync(path)) ??
  "gh";

/**
 * Run `gh` and return stdout. Some commands (`gh pr checks`) exit non-zero
 * to report a state rather than a failure; `allowFailure` keeps their output.
 */
function gh(args: string[], options: { allowFailure?: boolean } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      GH_BINARY,
      args,
      {
        timeout: GH_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
      },
      (error, stdout, stderr) => {
        if (error !== null && !(options.allowFailure && stdout.trim() !== "")) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function sameSnapshot(a: PrSnapshot | undefined, b: PrSnapshot): boolean {
  if (a === undefined) return false;
  return JSON.stringify({ ...a, fetchedAt: 0 }) === JSON.stringify({ ...b, fetchedAt: 0 });
}

function refreshAge(snapshot: PrSnapshot): number {
  if (snapshot.pr === null) return REFRESH_NONE_MS;
  const { kind } = snapshot.pr;
  if (kind === "merged" || kind === "closed") return REFRESH_DONE_MS;
  if (kind === "checking") return REFRESH_CHECKING_MS;
  if (kind === "checks_pending" || kind === "queued") return REFRESH_PENDING_MS;
  return REFRESH_OPEN_MS;
}

export default async function plugin(bb: BbPluginApi) {
  const snapshots = new Map<string, PrSnapshot>();
  const watched = new Map<string, number>();
  const inFlight = new Map<string, Promise<PrSnapshot>>();
  const mergeMethods = new Map<string, { method: "merge" | "squash" | "rebase"; at: number }>();

  async function environmentOf(threadId: string): Promise<string | null> {
    const thread = await bb.sdk.threads.get({ threadId });
    return thread.environmentId;
  }

  async function requireEnvironment(threadId: string): Promise<string> {
    const environmentId = await environmentOf(threadId);
    if (environmentId === null) throw new Error("This thread has no workspace.");
    return environmentId;
  }

  /** Whether a branch without a PR is worth offering "Create PR" for. */
  async function canCreatePr(environmentId: string): Promise<boolean> {
    try {
      const status = await bb.sdk.environments.status({ environmentId });
      if (status.outcome !== "available") return false;
      const { currentBranch, defaultBranch } = status.workspace.branch;
      return currentBranch !== null && currentBranch !== defaultBranch;
    } catch {
      return false;
    }
  }

  async function readSnapshot(threadId: string): Promise<PrSnapshot> {
    const base = { pr: null, canCreate: false, message: null, fetchedAt: Date.now() };
    let environmentId: string | null;
    try {
      environmentId = await environmentOf(threadId);
    } catch (cause) {
      return { ...base, outcome: "unavailable", message: errorMessage(cause) };
    }
    if (environmentId === null) {
      return { ...base, outcome: "unavailable", message: "This thread has no workspace." };
    }
    let result: Awaited<ReturnType<typeof bb.sdk.environments.pullRequest>>;
    try {
      result = await bb.sdk.environments.pullRequest({ environmentId });
    } catch (cause) {
      return { ...base, outcome: "unavailable", message: errorMessage(cause) };
    }
    if (result.outcome === "unavailable") {
      return { ...base, outcome: "unavailable", message: result.message };
    }
    if (result.outcome === "absent") {
      return { ...base, outcome: "none", canCreate: await canCreatePr(environmentId) };
    }
    const pr = result.pullRequest;
    return {
      ...base,
      outcome: "pr",
      pr: {
        number: pr.number,
        title: pr.title,
        url: pr.url,
        state: pr.state,
        attention: pr.attention,
        kind: derivePrKind({
          state: pr.state,
          checks: pr.checks.state,
          review: pr.review.state,
          mergeability: pr.mergeability.state,
          mergeStateStatus: pr.mergeability.mergeStateStatus,
          inMergeQueue: pr.inMergeQueue,
        }),
        baseRefName: pr.baseRefName,
        headRefName: pr.headRefName,
        autoMerge: pr.autoMerge,
        checks: {
          state: pr.checks.state,
          failedCount: pr.checks.failedCount,
          passedCount: pr.checks.passedCount,
          pendingCount: pr.checks.pendingCount,
          totalCount: pr.checks.totalCount,
        },
        review: { state: pr.review.state, reviewRequestCount: pr.review.reviewRequestCount },
        mergeability: {
          state: pr.mergeability.state,
          mergeStateStatus: pr.mergeability.mergeStateStatus,
        },
        inMergeQueue: pr.inMergeQueue,
      },
    };
  }

  /** Re-read one thread (one read at a time per thread) and signal changes. */
  function refresh(threadId: string): Promise<PrSnapshot> {
    const pending = inFlight.get(threadId);
    if (pending !== undefined) return pending;
    const next = readSnapshot(threadId)
      .then((snapshot) => {
        const changed = !sameSnapshot(snapshots.get(threadId), snapshot);
        snapshots.set(threadId, snapshot);
        if (changed) bb.realtime.publish(PR_CHANGED, { threadId });
        return snapshot;
      })
      .finally(() => inFlight.delete(threadId));
    inFlight.set(threadId, next);
    return next;
  }

  /**
   * Re-read after an action. GitHub can report the old state for a few
   * seconds after a merge or "ready", so look again shortly after.
   */
  async function settle(threadId: string): Promise<void> {
    await refresh(threadId).catch(() => undefined);
    for (const delay of [3_000, 10_000]) {
      setTimeout(() => void refresh(threadId).catch(() => undefined), delay);
    }
  }

  async function currentPr(threadId: string): Promise<{ environmentId: string; pr: PrInfo }> {
    const environmentId = await requireEnvironment(threadId);
    const snapshot = await refresh(threadId);
    if (snapshot.pr === null) {
      throw new Error(snapshot.message ?? "This branch has no pull request.");
    }
    return { environmentId, pr: snapshot.pr };
  }

  /**
   * The merge method to use for a repository: the viewer's default when the
   * repo allows it, else the first allowed one. bb's merge call needs it
   * explicitly, and a disallowed method fails on GitHub's side.
   */
  async function mergeMethodFor(repo: string): Promise<"merge" | "squash" | "rebase"> {
    const cached = mergeMethods.get(repo);
    if (cached !== undefined && Date.now() - cached.at < 10 * 60_000) return cached.method;
    const json = JSON.parse(
      await gh([
        "repo",
        "view",
        repo,
        "--json",
        "mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed,viewerDefaultMergeMethod",
      ]),
    ) as {
      mergeCommitAllowed?: boolean;
      squashMergeAllowed?: boolean;
      rebaseMergeAllowed?: boolean;
      viewerDefaultMergeMethod?: string;
    };
    const allowed = {
      merge: json.mergeCommitAllowed === true,
      squash: json.squashMergeAllowed === true,
      rebase: json.rebaseMergeAllowed === true,
    };
    const preferred = json.viewerDefaultMergeMethod?.toLowerCase();
    const chosen =
      (preferred === "merge" || preferred === "squash" || preferred === "rebase") &&
      allowed[preferred]
        ? preferred
        : (["squash", "merge", "rebase"] as const).find((candidate) => allowed[candidate]);
    if (chosen === undefined) throw new Error(`${repo} allows no merge method.`);
    mergeMethods.set(repo, { method: chosen, at: Date.now() });
    return chosen;
  }

  // -------------------------------------------------------------------------
  // Prompts sent to the thread's agent
  // -------------------------------------------------------------------------

  /** The failed part of a GitHub Actions job log, trimmed for a prompt. */
  async function failedJobLog(repo: string, link: string): Promise<string | null> {
    const match = /\/actions\/runs\/(\d+)\/job\/(\d+)/.exec(link);
    if (match === null) return null;
    try {
      const log = await gh([
        "run",
        "view",
        match[1]!,
        "--job",
        match[2]!,
        "--log-failed",
        "-R",
        repo,
      ]);
      // Lines read "<job>\t<step>\t<timestamp> <text>"; keep the text.
      const lines = log
        .split("\n")
        .map((line) => line.split("\t").slice(2).join("\t") || line)
        .map((line) => line.replace(/^\uFEFF/, ""))
        .map((line) => line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, ""))
        .map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""))
        .filter((line) => line.trim() !== "");
      if (lines.length === 0) return null;
      // Post-job cleanup follows the failure; end at the last error marker.
      const errorAt = lines.map((line) => line.startsWith("##[error]")).lastIndexOf(true);
      const relevant = errorAt === -1 ? lines : lines.slice(0, errorAt + 1);
      const tail = relevant.slice(-MAX_LOG_LINES).join("\n");
      return tail.length > MAX_LOG_CHARS ? `…${tail.slice(-MAX_LOG_CHARS)}` : tail;
    } catch {
      return null;
    }
  }

  async function fixChecksPrompt(pr: PrInfo): Promise<string> {
    const head = `Les checks CI de la PR #${pr.number} (${pr.url}) échouent (${pr.checks.failedCount}/${pr.checks.totalCount}).`;
    const fallback = `${head}\nRécupère la liste des checks en échec et leurs logs (\`gh pr checks ${pr.number}\`, puis \`gh run view <run-id> --log-failed\`), identifie la cause, corrige-la, vérifie en local si possible, puis commit et push.`;
    const parsed = parsePrUrl(pr.url);
    if (parsed === null) return fallback;
    let checks: { name: string; bucket: string; link: string; workflow: string; description: string }[];
    try {
      checks = JSON.parse(
        await gh(
          [
            "pr",
            "checks",
            String(parsed.number),
            "-R",
            parsed.repo,
            "--json",
            "name,bucket,link,workflow,description",
          ],
          { allowFailure: true },
        ),
      );
    } catch {
      return fallback;
    }
    const failed = checks.filter((check) => check.bucket === "fail");
    if (failed.length === 0) return fallback;
    const sections: string[] = [];
    for (const check of failed.slice(0, MAX_FAILED_CHECKS)) {
      const name = check.workflow ? `${check.workflow} / ${check.name}` : check.name;
      const log = check.link ? await failedJobLog(parsed.repo, check.link) : null;
      sections.push(
        [
          `### ${name}`,
          check.link ? `Lien : ${check.link}` : null,
          check.description ? `Description : ${check.description}` : null,
          log !== null
            ? `Extrait des logs (fin) :\n\`\`\`\n${log}\n\`\`\``
            : "Logs non récupérés : lis-les avec `gh run view <run-id> --log-failed`.",
        ]
          .filter((line) => line !== null)
          .join("\n"),
      );
    }
    const more =
      failed.length > MAX_FAILED_CHECKS
        ? `\n(${failed.length - MAX_FAILED_CHECKS} autre(s) check(s) en échec : \`gh pr checks ${pr.number}\`.)`
        : "";
    return `${head}\n\n${sections.join("\n\n")}${more}\n\nAnalyse ces échecs, corrige la cause (pas juste le symptôme), vérifie en local si possible, puis commit et push.`;
  }

  function fixConflictsPrompt(pr: PrInfo): string {
    return [
      `La PR #${pr.number} (${pr.url}) a des conflits avec \`${pr.baseRefName}\`.`,
      `Fais un \`git fetch\`, puis rebase la branche \`${pr.headRefName}\` sur \`origin/${pr.baseRefName}\` (ou merge \`origin/${pr.baseRefName}\` si la branche est partagée).`,
      "Résous chaque conflit en préservant l'intention des deux côtés, vérifie que le projet build et que les tests passent, puis pousse (`--force-with-lease` après un rebase).",
    ].join("\n");
  }

  async function addressReviewPrompt(pr: PrInfo): Promise<string> {
    const head = `Des changements ont été demandés en review sur la PR #${pr.number} (${pr.url}).`;
    const outro =
      "Traite chaque retour (corrige, ou explique pourquoi pas si un retour te semble discutable), vérifie que tout build et que les tests passent, puis commit et push. Ne résous pas les conversations GitHub toi-même.";
    const fallback = `${head}\nLis les reviews et les commentaires non résolus (\`gh pr view ${pr.number} --comments\`, \`gh api repos/{owner}/{repo}/pulls/${pr.number}/comments\`).\n${outro}`;
    const parsed = parsePrUrl(pr.url);
    if (parsed === null) return fallback;
    const [owner, name] = parsed.repo.split("/");
    const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){
      reviews(last:10,states:CHANGES_REQUESTED){nodes{author{login} body}}
      reviewThreads(first:100){nodes{isResolved isOutdated path line comments(first:10){nodes{author{login} body}}}}}}}`;
    type Comment = { author: { login: string } | null; body: string };
    type PullData = {
      reviews: { nodes: Comment[] };
      reviewThreads: {
        nodes: {
          isResolved: boolean;
          isOutdated: boolean;
          path: string;
          line: number | null;
          comments: { nodes: Comment[] };
        }[];
      };
    };
    let pull: PullData | undefined;
    try {
      const data = JSON.parse(
        await gh([
          "api",
          "graphql",
          "-f",
          `query=${query}`,
          "-F",
          `owner=${owner}`,
          "-F",
          `name=${name}`,
          "-F",
          `number=${parsed.number}`,
        ]),
      ) as { data?: { repository?: { pullRequest?: PullData } } };
      pull = data.data?.repository?.pullRequest;
    } catch {
      return fallback;
    }
    if (pull === undefined) return fallback;
    const quote = (comment: Comment) =>
      `@${comment.author?.login ?? "?"} : ${truncate(comment.body.trim(), MAX_COMMENT_CHARS)}`;
    const reviews = pull.reviews.nodes
      .filter((review) => review.body.trim() !== "")
      .map((review) => `- ${quote(review)}`);
    const threads = pull.reviewThreads.nodes
      .filter((thread) => !thread.isResolved)
      .slice(0, MAX_REVIEW_THREADS)
      .map((thread) => {
        const where = `\`${thread.path}${thread.line !== null ? `:${thread.line}` : ""}\`${thread.isOutdated ? " (outdated)" : ""}`;
        const comments = thread.comments.nodes.map((comment) => `  - ${quote(comment)}`).join("\n");
        return `- ${where}\n${comments}`;
      });
    if (reviews.length === 0 && threads.length === 0) return fallback;
    return [
      head,
      reviews.length > 0 ? `\n## Reviews\n${reviews.join("\n")}` : null,
      threads.length > 0 ? `\n## Commentaires non résolus\n${threads.join("\n")}` : null,
      `\n${outro}`,
    ]
      .filter((part) => part !== null)
      .join("\n");
  }

  /**
   * Target the environment's merge base when bb knows one (a worktree started
   * from a feature branch), else the repository's default branch.
   */
  async function createPrompt(threadId: string): Promise<string> {
    let target = "la branche par défaut";
    try {
      const environment = await bb.sdk.environments.get({
        environmentId: await requireEnvironment(threadId),
      });
      const base = environment.mergeBaseBranch ?? environment.defaultBranch;
      if (base) target = `\`${base.replace(/^origin\//, "")}\``;
    } catch {
      // Keep the generic target.
    }
    return `Crée une pull request pour la branche courante vers ${target} : commit et push si nécessaire, avec un titre et une description clairs.`;
  }

  // -------------------------------------------------------------------------
  // RPC
  // -------------------------------------------------------------------------

  bb.rpc.register(rpcContract, {
    pr_get: async ({ threadId, force }) => {
      watched.set(threadId, Date.now());
      const cached = snapshots.get(threadId);
      if (!force && cached !== undefined && Date.now() - cached.fetchedAt < CACHE_FRESH_MS) {
        return cached;
      }
      return refresh(threadId);
    },
    pr_mark_ready: async ({ threadId }) => {
      const environmentId = await requireEnvironment(threadId);
      const result = await bb.sdk.environments.markPullRequestReady({ environmentId });
      await settle(threadId);
      return { message: result.message };
    },
    pr_merge: async ({ threadId }) => {
      const { environmentId, pr } = await currentPr(threadId);
      if (pr.state !== "open") throw new Error(`PR #${pr.number} is ${pr.state}.`);
      const parsed = parsePrUrl(pr.url);
      if (parsed === null) throw new Error(`Not a GitHub pull request: ${pr.url}`);
      const method = await mergeMethodFor(parsed.repo);
      // bb's merge refuses anything it does not call "mergeable", including
      // GitHub's HAS_HOOKS state, which GitHub does merge.
      if (pr.mergeability.state !== "mergeable") {
        await gh(["pr", "merge", String(parsed.number), "-R", parsed.repo, `--${method}`]);
        await settle(threadId);
        return { message: `Merged #${parsed.number}`, method };
      }
      const result = await bb.sdk.environments.mergePullRequest({ environmentId, method });
      await settle(threadId);
      return { message: result.message, method: result.method };
    },
    pr_update_branch: async ({ threadId }) => {
      const { pr } = await currentPr(threadId);
      const parsed = parsePrUrl(pr.url);
      if (parsed === null) throw new Error(`Not a GitHub pull request: ${pr.url}`);
      // Merges the base into the PR branch on GitHub, like its "Update branch"
      // button. The agent's checkout needs a pull afterwards.
      await gh(["pr", "update-branch", String(parsed.number), "-R", parsed.repo]);
      await settle(threadId);
      return { message: `Updated ${pr.headRefName} with ${pr.baseRefName}` };
    },
    pr_prompt: async ({ threadId, action }) => {
      if (action === "create") return { prompt: await createPrompt(threadId) };
      const { pr } = await currentPr(threadId);
      if (action === "fix_checks") return { prompt: await fixChecksPrompt(pr) };
      if (action === "fix_conflicts") return { prompt: fixConflictsPrompt(pr) };
      return { prompt: await addressReviewPrompt(pr) };
    },
  });

  // An agent turn often ends with a push or a new PR: re-read right away
  // rather than waiting for the timer.
  bb.events.on("thread.idle", ({ thread }) => {
    if (watched.has(thread.id)) void refresh(thread.id).catch(() => undefined);
  });
  bb.events.on("thread.archived", ({ thread }) => {
    watched.delete(thread.id);
    snapshots.delete(thread.id);
  });

  // Re-read only the threads the app asked about recently, each at a pace
  // that matches its state, so idle threads cost GitHub nothing.
  bb.background.service("pr-poller", {
    async start(signal) {
      while (!signal.aborted) {
        const now = Date.now();
        for (const [threadId, seenAt] of watched) {
          if (now - seenAt > WATCH_TTL_MS) {
            watched.delete(threadId);
            continue;
          }
          const snapshot = snapshots.get(threadId);
          if (snapshot !== undefined && now - snapshot.fetchedAt < refreshAge(snapshot)) continue;
          try {
            await refresh(threadId);
          } catch (cause) {
            bb.log.warn(`refresh ${threadId} failed: ${errorMessage(cause)}`);
          }
        }
        await sleep(TICK_MS, signal);
      }
    },
  });
}
