// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { openGithubPrTabViaHost } from "./github-panel";

/** Stands in for bb's thread view, which passes its opener down as a prop. */
function Host(props: { openThreadPanel: (options: unknown) => boolean; children: ReactNode }) {
  return <div>{props.children}</div>;
}

afterEach(cleanup);

describe("openGithubPrTabViaHost", () => {
  it("calls the nearest opener that accepts the github panel", () => {
    const host = vi.fn(() => true);
    // A plugin-facing wrapper closer to the button declines.
    const wrapper = vi.fn(() => false);
    const { getByRole } = render(
      <Host openThreadPanel={host}>
        <Host openThreadPanel={wrapper}>
          <button type="button">#1</button>
        </Host>
      </Host>,
    );
    expect(openGithubPrTabViaHost(getByRole("button"))).toBe(true);
    expect(wrapper).toHaveBeenCalledOnce();
    expect(host).toHaveBeenCalledWith({ pluginId: "github", actionId: "pull", title: "GitHub PR" });
  });

  it("reports false when no opener is reachable", () => {
    const { getByRole } = render(<button type="button">#1</button>);
    expect(openGithubPrTabViaHost(getByRole("button"))).toBe(false);
  });
});
