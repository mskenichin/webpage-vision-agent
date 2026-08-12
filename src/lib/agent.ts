import { browserManager } from "./browser";
import type { BrowserAction } from "./domain";
import { browserTaskRequest, requiresBrowserTask, runBrowserTask } from "./browser-task";
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
  store.addProcessLog("agent", "info", "テキスト要求の処理を開始しました");
  store.setBrowser("agent_running");
  const state = store.snapshot();
  let action: BrowserAction | null = null;
  let usedFoundry = false;
  const explicitModel = browserTaskRequest(prompt, state.currentUrl);
  const browserIntent = requiresBrowserTask(prompt, state.currentUrl);

  if (browserIntent && explicitModel) {
    store.addProcessLog("browser", "info", "関連ページを探索しています", explicitModel.targetUrl);
    await runBrowserTask(prompt);
    action = { type: "navigate", url: store.snapshot().currentUrl, actor: "agent" };
    store.addProcessLog("browser", "success", "関連ページを表示しました", store.snapshot().currentUrl);
  }

  if (state.agentMode === "foundry" && browserIntent && !action) {
    try {
      store.addProcessLog("browser", "info", "Computer Useを開始しました");
      const result = await runComputerUse(prompt);
      usedFoundry = result.steps > 0;
      store.addProcessLog("browser", "success", "Computer Useが完了しました", `${result.steps}ステップ実行`);
      if (result.awaitingApproval) return "操作を続けるには、画面に表示された内容を確認して承認または拒否してください。";
    } catch (error) {
      if (error instanceof Error && ["AGENT_STOPPED", "AGENT_TIMEOUT"].includes(error.message)) throw error;
      store.addProcessLog("browser", "error", "Computer Useを完了できませんでした");
      action = null;
    }
  }

  if (!usedFoundry && browserIntent && !action) {
    action = demoAction(prompt);
    if (action) await browserManager.execute(action);
  }
  if (store.snapshot().browserStatus === "agent_running") store.setBrowser("ready");

  try {
    const responseState = store.snapshot();
    const pageContext = await browserManager.pageContext();
    if (/比較|おすすめ|推薦|違い|条件|どちら|メリット|デメリット/i.test(prompt)) {
      store.addProcessLog("agent", "info", "専門モデルへ判断を委譲しています");
      const result = await delegateComplexQuery(prompt, responseState.profile, responseState.messages, pageContext.url, responseState.interests, pageContext);
      store.addProcessLog("agent", "success", `LLM応答を生成しました (${result.model})`, result.text);
      return result.text;
    }
    const model = process.env.AZURE_CHAT_MODEL ?? "gpt-5.4";
    store.addProcessLog("agent", "info", `LLM応答を生成しています (${model})`);
    const response = await requestFoundryResponse(prompt, responseState.profile, responseState.messages, pageContext.url, responseState.interests, pageContext);
    store.addProcessLog("agent", "success", `LLM応答を生成しました (${model})`, response);
    return response;
  } catch {
    const operation = action
      ? "左のブラウザを更新しました。"
      : "具体的なモデル名や「SUVを見たい」のような条件を教えてください。";
    const mode = usedFoundry ? "Microsoft Foundryで" : "デモナビゲーションで";
    const response = `${mode}${operation} ${profileContext()}`;
    store.addProcessLog("agent", "error", "LLM応答を取得できなかったため代替応答を生成しました", response);
    return response;
  }
}