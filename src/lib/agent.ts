import { browserManager } from "./browser";
import type { BrowserAction } from "./domain";
import { requestFoundryAction, requestFoundryResponse } from "./foundry";
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

  if (state.agentMode === "foundry") {
    try {
      action = await requestFoundryAction(prompt, await browserManager.screenshot(), state.profile);
      usedFoundry = Boolean(action);
    } catch {
      action = null;
    }
  }

  action ??= demoAction(prompt);
  if (action) await browserManager.execute(action);
  else store.setBrowser("ready");

  try {
    return await requestFoundryResponse(prompt, state.profile, state.messages, store.snapshot().currentUrl);
  } catch {
    const operation = action
      ? "左のブラウザを更新しました。"
      : "具体的なモデル名や「SUVを見たい」のような条件を教えてください。";
    const mode = usedFoundry ? "Microsoft Foundryで" : "デモナビゲーションで";
    return `${mode}${operation} ${profileContext()}`;
  }
}