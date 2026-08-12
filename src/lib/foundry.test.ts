import { describe, expect, it } from "vitest";
import { computerKeyChord } from "./foundry";

describe("computerKeyChord", () => {
  it("normalizes Computer Use key names for Playwright", () => {
    expect(computerKeyChord(["ALT"])).toBe("Alt");
    expect(computerKeyChord(["ENTER"])).toBe("Enter");
    expect(computerKeyChord(["DOWN"])).toBe("ArrowDown");
  });

  it("preserves all keys in a keypress chord", () => {
    expect(computerKeyChord(["CTRL", "L"])).toBe("Control+L");
    expect(computerKeyChord(["ALT", "LEFT"])).toBe("Alt+ArrowLeft");
  });
});