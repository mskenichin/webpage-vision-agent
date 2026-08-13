import { describe, expect, it } from "vitest";
import type { BrowserAction } from "./domain";
import { computerActionsWithinLimit } from "./computer-use";

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