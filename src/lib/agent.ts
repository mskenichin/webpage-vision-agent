import { browserManager } from "./browser";
import type { BrowserAction } from "./domain";
import { runBrowserTask, vehicleModelRequest } from "./browser-task";
import { runComputerUse } from "./computer-use";
import { delegateComplexQuery } from "./delegation";
import { requestFoundryResponse } from "./foundry";
import { store } from "./store";

function demoAction(prompt: string): BrowserAction | null {
  const normalized = prompt.toUpperCase();
  const models = ["LBX", "UX", "NX", "RX", "RZ", "GX", "LX", "LM", "LS", "ES", "IS", "LC", "RC"];
  const model = models.find((name) => normalized.includes(name));
  if (model) return { type: "navigate", url: `https://lexus.jp/models/${model.toLowerCase()}/`, actor: "agent" };
  if (/SUV|モデル|車種|おすすめ/.test(normalized)) {
    return { type: "navigate", url: "https://lexus.jp/models/", actor: "agent" };
  }
  return null;
}

function profileContext() {
  const state = store.snapshot();
  const interests = state.interests.slice(0, 3).map((interest) => interest.name);
  if (interests.length > 0) return `${interests.join("、")}への関心も踏まえています。`;
  if (state.profile.usage) return `${state.profile.usage}というご用途を踏まえています。`;
  return "ご希望に合う情報をLexus公式サイトで探します。";
}

export async function runAgent(prompt: string) {
  store.setBrowser("agent_running");
  const state = store.snapshot();
  let action: BrowserAction | null = null;
  let usedFoundry = false;
  const browserIntent = /見せ|開い|表示|探し|検索|ページ|サイト|モデル一覧|車種一覧/i.test(prompt);
  const explicitModel = vehicleModelRequest(prompt);

  if (browserIntent && explicitModel) {
    await runBrowserTask(prompt);
    action = { type: "navigate", url: store.snapshot().currentUrl, actor: "agent" };
  }

  if (state.agentMode === "foundry" && browserIntent && !action) {
    try {
      const result = await runComputerUse(prompt);
      usedFoundry = result.steps > 0;
      if (result.awaitingApproval) return "操作を続けるには、画面に表示された内容を確認して承認または拒否してください。";
    } catch (error) {
      if (error instanceof Error && ["AGENT_STOPPED", "AGENT_TIMEOUT"].includes(error.message)) throw error;
      action = null;
    }
  }

  if (!usedFoundry && browserIntent && !action) {
    action = demoAction(prompt);
    if (action) await browserManager.execute(action);
  }
  if (store.snapshot().browserStatus === "agent_running") store.setBrowser("ready");

  try {
    if (/比較|おすすめ|推薦|違い|条件|どちら|メリット|デメリット/i.test(prompt)) {
      return (await delegateComplexQuery(prompt, state.profile, state.messages, store.snapshot().currentUrl)).text;
    }
    return await requestFoundryResponse(prompt, state.profile, state.messages, store.snapshot().currentUrl);
  } catch {
    const operation = action
      ? "左のブラウザを更新しました。"
      : "具体的なモデル名や「SUVを見たい」のような条件を教えてください。";
    const mode = usedFoundry ? "Microsoft Foundryで" : "デモナビゲーションで";
    return `${mode}${operation} ${profileContext()}`;
  }
}