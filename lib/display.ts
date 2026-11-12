// Which header the plugin draws: its own split button (tinted, right-click
// menu) or bb's shared header button (thread actions, label and icon only).
//
// bb 0.49 still accepts the plugin's own header slot, so `auto` keeps it while
// it exists and only switches when bb drops it. The `display` setting forces
// either one; a forced display bb does not offer falls back to the other.

export const DISPLAY_SETTINGS = ["auto", "plugin", "bb"] as const;
export type DisplaySetting = (typeof DISPLAY_SETTINGS)[number];
export type Display = "plugin" | "bb";

/** What the running bb offers. */
export interface DisplayCapabilities {
  /** bb still has the plugin's own header slot (see lib/app-api.ts). */
  pluginSlot: boolean;
  /** Thread actions take `placement: "header"` (bb 0.49+). */
  sharedButton: boolean;
}

export interface DisplayChoice {
  requested: DisplaySetting;
  /** Null when bb offers neither. */
  display: Display | null;
  /** Why `display` differs from a forced `requested`; null otherwise. */
  fallback: string | null;
}

export function parseDisplaySetting(value: unknown): DisplaySetting {
  return DISPLAY_SETTINGS.includes(value as DisplaySetting) ? (value as DisplaySetting) : "auto";
}

export function resolveDisplay(value: unknown, capabilities: DisplayCapabilities): DisplayChoice {
  const requested = parseDisplaySetting(value);
  const { pluginSlot, sharedButton } = capabilities;
  if (requested === "bb") {
    if (sharedButton) return { requested, display: "bb", fallback: null };
    return {
      requested,
      display: pluginSlot ? "plugin" : null,
      fallback: "this bb has no shared header button (thread actions with placement \"header\")",
    };
  }
  if (pluginSlot) return { requested, display: "plugin", fallback: null };
  return {
    requested,
    display: sharedButton ? "bb" : null,
    fallback:
      requested === "plugin" ? "this bb no longer accepts the plugin's own header slot" : null,
  };
}
