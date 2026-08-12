import { browserManager } from "./browser";
import { runComputerUse } from "./computer-use";
import { store } from "./store";

export type VehicleModel = "LBX" | "UX" | "NX" | "RX" | "RZ" | "GX" | "LX" | "LM" | "LS" | "ES" | "IS" | "LC" | "RC";

const spokenModelNames: Array<[RegExp, VehicleModel]> = [
  [/エルビーエックス|エルビ―エックス|エルビックス/g, "LBX"],
  [/ユーエックス/g, "UX"], [/エヌエックス/g, "NX"], [/アールエックス/g, "RX"], [/アールゼット/g, "RZ"],
  [/ジーエックス/g, "GX"], [/エルエックス/g, "LX"], [/エルエム/g, "LM"], [/エルエス/g, "LS"],
  [/イーエス/g, "ES"], [/アイエス/g, "IS"], [/エルシー/g, "LC"], [/アールシー/g, "RC"],
];

const onPageAction = /にして|変更|変え|選ん|選択|クリック|押して|切り替|したい|進みたい|始めたい|やりたい/i;
const onPageTarget = /色|カラー|スウォッチ|オプション|グレード|パッケージ|タブ|ボタン|チェック|選択肢|見積|シミュレーション|試乗|予約|問い合わせ/i;

function requestsOnPageAction(prompt: string) {
  return onPageAction.test(prompt) && onPageTarget.test(prompt);
}

function normalizeSpokenModelNames(prompt: string) {
  return spokenModelNames.reduce((normalized, [pattern, model]) => normalized.replace(pattern, model), prompt);
}

function modelFromUrl(currentUrl?: string): VehicleModel | null {
  if (!currentUrl) return null;
  try {
    const match = new URL(currentUrl).pathname.match(/^\/models\/(lbx|ux|nx|rx|rz|gx|lx|lm|ls|es|is|lc|rc)(?:\/|$)/i);
    return match ? match[1].toUpperCase() as VehicleModel : null;
  } catch {
    return null;
  }
}

export function vehicleModelRequest(prompt: string): VehicleModel | null {
  if (!/見せ|開い|表示|ページ|サイト|知り|教え|確認|調べ|パッケージ|グレード|価格|装備|仕様|スペック|内装|外装|安全|走行|カラー|デザイン/i.test(prompt)) return null;
  const normalized = normalizeSpokenModelNames(prompt).toUpperCase();
  const matches = [...normalized.matchAll(/(?:^|[^A-Z])(LBX|UX|NX|RX|RZ|GX|LX|LM|LS|ES|IS|LC|RC)(?=$|[^A-Z])/g)]
    .map((match) => match[1] as VehicleModel);
  const models = [...new Set(matches)];
  return models.length === 1 ? models[0] : null;
}

export function vehicleModelUrl(model: VehicleModel) {
  return `https://lexus.jp/models/${model.toLowerCase()}/`;
}

export function browserTaskRequest(prompt: string, currentUrl?: string) {
  if (requestsOnPageAction(prompt)) return null;

  const explicitModel = vehicleModelRequest(prompt);
  const knownModelSection = /パッケージ|グレード|価格|内装|インテリア|外装|エクステリア|デザイン|安全|セーフティ|走行|走り|ドライビング/i.test(prompt);
  const currentModel = modelFromUrl(currentUrl);
  const model = explicitModel ?? (knownModelSection ? currentModel : null);
  if (!model) {
    if (currentModel && /特別仕様|限定|仕様|装備|スペック/i.test(prompt)) return null;
    const vehicleTopic = /SUV|セダン|ミニバン|クーペ|車|車種|モデル|電気自動車|EV|BEV|PHEV|ハイブリッド|燃費|家族|通勤|アウトドア|荷室|乗りやす|運転しやす|予算/i.test(prompt);
    const explorationIntent = /見せ|見たい|探し|検索|選び|候補|おすすめ|推薦|比較|知りたい|教えて|相談|ありますか|ある？/i.test(prompt);
    return vehicleTopic && explorationIntent
      ? { model: null, targetUrl: "https://lexus.jp/models/" }
      : null;
  }
  const baseUrl = vehicleModelUrl(model);
  let targetUrl = baseUrl;
  if (/パッケージ|グレード|価格/i.test(prompt)) targetUrl = `${baseUrl}features/price_package/`;
  else if (/内装|インテリア/i.test(prompt)) targetUrl = `${baseUrl}features/interior/`;
  else if (/外装|エクステリア|デザイン/i.test(prompt)) targetUrl = `${baseUrl}features/exterior/`;
  else if (/安全|セーフティ/i.test(prompt)) targetUrl = `${baseUrl}features/safety/`;
  else if (/走行|走り|ドライビング/i.test(prompt)) targetUrl = `${baseUrl}features/driving/`;
  return { model, targetUrl };
}

export function requiresBrowserTask(prompt: string, currentUrl?: string) {
  if (browserTaskRequest(prompt, currentUrl)) return true;
  const directNavigation = /見せ|開い|表示|探し|検索|ページ|サイト|モデル一覧|車種一覧|スクロール|戻って|進んで|再読み込み/i;
  return directNavigation.test(prompt) || requestsOnPageAction(prompt);
}

export async function runBrowserTask(goal: string) {
  const request = browserTaskRequest(goal, store.snapshot().currentUrl);
  if (!request) {
    return runComputerUse(goal);
  }

  const { model, targetUrl } = request;
  const alreadyAtTarget = store.snapshot().currentUrl === targetUrl;
  if (!alreadyAtTarget) {
    await browserManager.execute({ type: "navigate", url: targetUrl, actor: "agent" });
  }
  const currentUrl = store.snapshot().currentUrl;
  if (currentUrl !== targetUrl) throw new Error("BROWSER_NAVIGATION_INCOMPLETE");
  const focus = await browserManager.revealRelevantContent(goal);
  const subject = model ?? "Lexusのモデル一覧";
  const focusMessage = focus.found ? `「${focus.label}」付近を表示しています。` : "関連ページを表示しました。";
  return { ok: true, steps: alreadyAtTarget ? 0 : 1, currentUrl, message: `${subject}の${focusMessage}` };
}