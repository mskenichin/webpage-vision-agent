import { describe, expect, it } from "vitest";
import type { PendingApproval } from "./store";
import { DemoStore } from "./store";

function pendingApproval(): PendingApproval {
  return {
    request: {
      id: "14f08cb7-4fc7-47d7-b63e-b416840e725d",
      operation: "送信を実行",
      targetUrl: "https://lexus.jp/contact/",
      impact: "問い合わせを送信します。",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    goal: "問い合わせを送信する",
    action: { type: "click", x: 100, y: 100, actor: "agent" },
    responseId: "response-1",
    callId: "call-1",
    safetyChecks: [{ id: "check-1", code: "external_side_effect", message: "送信操作です。" }],
    steps: 2,
    observations: 1,
  };
}

describe("DemoStore approvals", () => {
  it("exposes an approval without exposing continuation details", () => {
    const store = new DemoStore();
    store.setApproval(pendingApproval());

    expect(store.snapshot()).toMatchObject({
      browserStatus: "awaiting_approval",
      approval: { operation: "送信を実行", targetUrl: "https://lexus.jp/contact/" },
    });
    expect(store.snapshot().approval).not.toHaveProperty("responseId");
  });

  it("consumes an approval once and rejects a mismatched id", () => {
    const store = new DemoStore();
    const pending = pendingApproval();
    store.setApproval(pending);

    expect(store.takeApproval("70d7a91e-0715-472e-a465-c4558393231d")).toBeNull();
    expect(store.takeApproval(pending.request.id)).toMatchObject({ callId: "call-1" });
    expect(store.takeApproval(pending.request.id)).toBeNull();
  });

  it("clears the awaiting state when rejected", () => {
    const store = new DemoStore();
    const pending = pendingApproval();
    store.setApproval(pending);

    expect(store.clearApproval(pending.request.id)).toBe(true);
    expect(store.snapshot()).toMatchObject({ browserStatus: "ready", approval: null });
  });
});