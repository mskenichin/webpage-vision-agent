import type { Interest, Profile } from "./domain";

const interestCategoryLabels: Record<Interest["category"], string> = {
  model: "車種",
  body: "ボディタイプ",
  feature: "装備・機能",
  price: "価格帯",
  usage: "利用シーン",
  design: "デザイン嗜好",
};

export function profileInstructions(profile: Profile, interests: Interest[] = []) {
  const facts = [
    profile.displayName && `表示名: ${profile.displayName}`,
    profile.region && `居住地域: ${profile.region}`,
    `言語: ${profile.language}`,
    profile.budget && `予算: ${profile.budget}`,
    profile.usage && `主な用途: ${profile.usage}`,
    profile.bodyType && `希望ボディタイプ: ${profile.bodyType}`,
    profile.passengers > 0 && `乗車人数: ${profile.passengers}人`,
    profile.priorities && `重視点: ${profile.priorities}`,
  ].filter(Boolean);

  const inferredInterests = [...interests]
    .sort((left, right) => right.score - left.score)
    .slice(0, 5)
    .map((interest) => `- ${interest.name}（${interestCategoryLabels[interest.category]}、関心度 ${interest.score.toFixed(2)}）`);

  return [
    "以下のプロファイルをユーザーの基本情報として理解し、回答の前提にしてください。",
    "質問に関連する項目を回答、比較、推薦へ自然に反映してください。毎回プロファイルを列挙する必要はありません。",
    "優先順位は、現在の発言、明示入力されたプロファイル、閲覧から推定した興味の順です。空欄の情報は推測しないでください。",
    ...facts,
    ...(inferredInterests.length > 0 ? [
      "閲覧から推定した興味（明示された希望ではありません）:",
      ...inferredInterests,
    ] : []),
  ].join("\n");
}