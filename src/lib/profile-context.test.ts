import { describe, expect, it } from "vitest";
import type { Interest, Profile } from "./domain";
import { profileInstructions } from "./profile-context";

const profile: Profile = {
  displayName: "デモユーザー",
  region: "東京都",
  language: "ja-JP",
  budget: "700万円以下",
  usage: "家族利用",
  bodyType: "SUV",
  passengers: 5,
  priorities: "安全性、燃費",
  activityCollection: true,
};

function interest(name: string, score: number, category: Interest["category"] = "model"): Interest {
  return { id: name, key: name, name, category, score, evidenceIds: [], updatedAt: "2026-08-12T00:00:00.000Z" };
}

describe("profileInstructions", () => {
  it("回答の前提と主要なプロファイル情報をモデルへ伝える", () => {
    const instructions = profileInstructions(profile);

    expect(instructions).toContain("基本情報として理解し、回答の前提");
    expect(instructions).toContain("現在の発言、明示入力されたプロファイル、閲覧から推定した興味の順");
    expect(instructions).toContain("予算: 700万円以下");
    expect(instructions).toContain("主な用途: 家族利用");
    expect(instructions).toContain("希望ボディタイプ: SUV");
    expect(instructions).toContain("乗車人数: 5人");
    expect(instructions).toContain("重視点: 安全性、燃費");
  });

  it("空欄や回答に不要な収集設定を含めない", () => {
    const instructions = profileInstructions({ ...profile, bodyType: "", budget: "" });

    expect(instructions).not.toContain("希望ボディタイプ:");
    expect(instructions).not.toContain("予算:");
    expect(instructions).not.toContain("activityCollection");
  });

  it("閲覧由来の興味をスコア順で最大5件含める", () => {
    const instructions = profileInstructions(profile, [
      interest("IS", 0.4), interest("NX", 0.9), interest("RX", 0.8),
      interest("SUV", 0.7, "body"), interest("安全装備", 0.6, "feature"), interest("UX", 0.5),
    ]);

    expect(instructions).toContain("閲覧から推定した興味（明示された希望ではありません）");
    expect(instructions).toContain("- NX（車種、関心度 0.90）");
    expect(instructions.indexOf("- NX")).toBeLessThan(instructions.indexOf("- RX"));
    expect(instructions).not.toContain("- IS");
    expect(instructions).not.toContain("evidenceIds");
  });
});