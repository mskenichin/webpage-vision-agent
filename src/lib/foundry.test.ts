import { describe, expect, it, vi } from "vitest";
import { computerCompletion, computerCompletionReportsFailure, computerKeyChord, requestModelWithRetry } from "./foundry";

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
    })).toEqual({ completed: true, responseId: "response-1", message: "目的の画面を確認しました。", goalAchieved: true });
  });

  it("does not complete while a computer call remains", () => {
    expect(computerCompletion({ id: "response-1", output: [{ type: "computer_call", call_id: "call-1" }] })).toBeNull();
  });

  it("preserves an explicit unmet result instead of reporting completion", () => {
    const message = "最終確認したところ、現在の見積もり画面では成功条件を満たしていません。白ではない状態です。";
    expect(computerCompletionReportsFailure(message)).toBe(true);
    expect(computerCompletion({
      id: "response-2",
      output: [{ type: "message", content: [{ type: "output_text", text: message }] }],
    })).toMatchObject({ completed: true, goalAchieved: false, message });
  });

  it("does not mistake a successful no-remaining-items report for failure", () => {
    expect(computerCompletionReportsFailure("未選択で残っている項目はなく、成功条件を満たしています。")).toBe(false);
  });
});

describe("requestModelWithRetry", () => {
  it("retries a transient server error and returns the next successful response", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 500, headers: { "x-request-id": "request-1" } }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    await expect(requestModelWithRetry(request, undefined, 3, 0)).resolves.toMatchObject({ status: 200 });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-transient client error", async () => {
    const request = vi.fn().mockResolvedValue(new Response("invalid", { status: 400 }));

    await expect(requestModelWithRetry(request, undefined, 3, 0)).rejects.toThrow("MODEL_UNAVAILABLE:400:invalid");
    expect(request).toHaveBeenCalledTimes(1);
  });
});