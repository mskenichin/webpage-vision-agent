import { describe, expect, it } from "vitest";
import type { BrowserAction } from "./domain";
import { computerActionsWithinLimit, controlledRun, isComputerUseChunkTimeout } from "./computer-use";

describe("computerActionsWithinLimit", () => {
  const actions: BrowserAction[] = Array.from({ length: 8 }, (_, index) => ({
    type: "click",
    x: index,
    y: index,
    actor: "agent",
  }));

  it("executes only actions that fit in the remaining step budget", () => {
    expect(computerActionsWithinLimit(actions, 14)).toHaveLength(6);
  });

  it("returns no actions after the step budget is exhausted", () => {
    expect(computerActionsWithinLimit(actions, 20)).toEqual([]);
  });
});

describe("isComputerUseChunkTimeout", () => {
  it("recognizes only the resumable chunk timeout", () => {
    expect(isComputerUseChunkTimeout(new Error("COMPUTER_USE_CHUNK_TIMEOUT"))).toBe(true);
    expect(isComputerUseChunkTimeout(new Error("AGENT_STOPPED"))).toBe(false);
    expect(isComputerUseChunkTimeout("COMPUTER_USE_CHUNK_TIMEOUT")).toBe(false);
  });

  it("uses the signal reason when fetch returns a generic AbortError", () => {
    const controller = new AbortController();
    controller.abort(new Error("COMPUTER_USE_CHUNK_TIMEOUT"));

    expect(isComputerUseChunkTimeout(new DOMException("This operation was aborted", "AbortError"), controller.signal)).toBe(true);
  });
});

describe("controlledRun", () => {
  it("rejects at the chunk deadline even when the task does not settle after abort", async () => {
    await expect(controlledRun(() => new Promise(() => {}), 5)).rejects.toThrow("COMPUTER_USE_CHUNK_TIMEOUT");
  });
});