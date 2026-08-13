import { describe, expect, it } from "vitest";
import { actionRisk, isAllowedUrl, isWebNavigationUrl, requiresRiskInspection, revealQueryText } from "./browser";

describe("isAllowedUrl", () => {
  it("allows only HTTPS URLs on Lexus domains", () => {
    expect(isAllowedUrl("https://lexus.jp/models/is/")).toBe(true);
    expect(isAllowedUrl("https://www.lexus.jp/models/is/")).toBe(true);
    expect(isAllowedUrl("http://lexus.jp/models/is/")).toBe(false);
    expect(isAllowedUrl("https://example.com/")).toBe(false);
    expect(isAllowedUrl("https://lexus.jp.example.com/")).toBe(false);
  });
});

describe("isWebNavigationUrl", () => {
  it("only classifies HTTP links as web navigation", () => {
    expect(isWebNavigationUrl("https://lexus.jp/request/estimate_sim/option")).toBe(true);
    expect(isWebNavigationUrl("javascript:void(0)")).toBe(false);
  });
});

describe("revealQueryText", () => {
  it("adds English page-heading aliases for Japanese vehicle types", () => {
    expect(revealQueryText("セダンタイプを見せて")).toContain("sedan");
    expect(revealQueryText("ミニバンを探して")).toContain("minivan");
    expect(revealQueryText("電気自動車について教えて")).toContain("BEV");
  });
});

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

describe("actionRisk", () => {
  it("does not treat an ordinary choice inside a sensitive form as the final action", () => {
    expect(actionRisk("IS F SPORT モデルを選択")).toBeNull();
    expect(actionRisk("次へ", "submit")).toBeNull();
  });

  it("requires approval for explicit sensitive actions and personal fields", () => {
    expect(actionRisk("試乗予約を申し込む")).toContain("外部へ影響");
    expect(actionRisk("メールアドレス", "email")).toContain("個人情報");
    expect(actionRisk("ファイルを選択", "file")).toContain("個人情報");
  });
});