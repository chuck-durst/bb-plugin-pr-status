import { describe, expect, it } from "vitest";
import { resolveDisplay, type DisplayCapabilities } from "./display";

/** bb 0.49: still accepts the plugin's slot, and has the shared button. */
const both: DisplayCapabilities = { pluginSlot: true, sharedButton: true };
/** bb 0.46: the plugin's slot only. */
const pluginOnly: DisplayCapabilities = { pluginSlot: true, sharedButton: false };
/** A later bb that dropped the plugin's slot. */
const sharedOnly: DisplayCapabilities = { pluginSlot: false, sharedButton: true };

describe("resolveDisplay", () => {
  it("auto keeps the plugin's own header while bb accepts it", () => {
    expect(resolveDisplay("auto", both)).toEqual({ requested: "auto", display: "plugin", fallback: null });
    expect(resolveDisplay("auto", pluginOnly).display).toBe("plugin");
  });

  it("auto switches to bb's shared button once the slot is gone, without calling it a fallback", () => {
    expect(resolveDisplay("auto", sharedOnly)).toEqual({ requested: "auto", display: "bb", fallback: null });
  });

  it("plugin forces the plugin's own header, falling back to bb's when it is gone", () => {
    expect(resolveDisplay("plugin", both)).toEqual({ requested: "plugin", display: "plugin", fallback: null });
    const choice = resolveDisplay("plugin", sharedOnly);
    expect(choice.display).toBe("bb");
    expect(choice.fallback).toMatch(/no longer accepts/);
  });

  it("bb forces the shared button, falling back to the plugin's on bb 0.46", () => {
    expect(resolveDisplay("bb", both)).toEqual({ requested: "bb", display: "bb", fallback: null });
    const choice = resolveDisplay("bb", pluginOnly);
    expect(choice.display).toBe("plugin");
    expect(choice.fallback).toMatch(/no shared header button/);
  });

  it("reads a missing or unknown value as auto", () => {
    expect(resolveDisplay(undefined, both).requested).toBe("auto");
    expect(resolveDisplay("tinted", both)).toMatchObject({ requested: "auto", display: "plugin" });
  });

  it("shows nothing when bb offers neither", () => {
    expect(resolveDisplay("bb", { pluginSlot: false, sharedButton: false }).display).toBeNull();
  });
});
