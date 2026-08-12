import { describe, expect, it } from "vitest";
import { computerCompletion, computerKeyChord } from "./foundry";

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

describe("computerCompletion", () => {
  it("treats a response without a computer call as a completed observation", () => {
    expect(computerCompletion({
      id: "response-1",
      output: [{ type: "message", content: [{ type: "output_text", text: "目的の画面を確認しました。" }] }],
    })).toEqual({ completed: true, responseId: "response-1", message: "目的の画面を確認しました。" });
  });

  it("does not complete while a computer call remains", () => {
    expect(computerCompletion({ id: "response-1", output: [{ type: "computer_call", call_id: "call-1" }] })).toBeNull();
  });
});