import { describe, expect, it } from "vitest";
import { requiresRiskInspection } from "./browser";

describe("requiresRiskInspection", () => {
  it("inspects actions that can enter or submit sensitive data", () => {
    expect(requiresRiskInspection({ type: "click", x: 10, y: 10, actor: "agent" })).toBe(true);
    expect(requiresRiskInspection({ type: "type", text: "value", actor: "agent" })).toBe(true);
    expect(requiresRiskInspection({ type: "key", key: "Enter", actor: "agent" })).toBe(true);
  });

  it("does not require approval inspection for observation and navigation controls", () => {
    expect(requiresRiskInspection({ type: "scroll", deltaY: 600, actor: "agent" })).toBe(false);
    expect(requiresRiskInspection({ type: "key", key: "ArrowDown", actor: "agent" })).toBe(false);
    expect(requiresRiskInspection({ type: "back", actor: "agent" })).toBe(false);
  });
});