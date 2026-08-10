import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "./domain";
import { mergeInterests } from "./interests";

function event(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: "event-1",
    sessionId: "session-1",
    operationId: "operation-1",
    type: "page_viewed",
    actor: "user",
    occurredAt: "2026-08-10T00:00:00.000Z",
    title: "LEXUS NX | SUV",
    url: "https://lexus.jp/models/nx/",
    ...overrides,
  };
}

describe("mergeInterests", () => {
  it("extracts model and body interests from a page view", () => {
    const interests = mergeInterests([], event());
    expect(interests).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "model:nx", name: "NX", category: "model" }),
      expect.objectContaining({ key: "body:suv", name: "SUV", category: "body" }),
    ]));
  });

  it("merges repeated evidence without duplicating an interest", () => {
    const first = mergeInterests([], event());
    const second = mergeInterests(first, event({ id: "event-2", operationId: "operation-2" }));
    const nx = second.filter((interest) => interest.key === "model:nx");
    expect(nx).toHaveLength(1);
    expect(nx[0].evidenceIds).toEqual(["event-1", "event-2"]);
    expect(nx[0].score).toBeGreaterThan(first.find((interest) => interest.key === "model:nx")!.score);
  });

  it("does not count the same evidence twice", () => {
    const first = mergeInterests([], event());
    expect(mergeInterests(first, event())).toEqual(first);
  });
});