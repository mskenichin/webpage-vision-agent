import { browserManager } from "./browser";
import type { BrowserAction } from "./domain";
import { browserTaskRequest, requiresBrowserTask, runBrowserTask } from "./browser-task";
import { runComputerUse } from "./computer-use";
import { delegateComplexQuery } from "./delegation";
import { requestFoundryResponse } from "./foundry";
import { runHistoryRecorder } from "./run-history-recorder";
import { store } from "./store";
import { runTaskMode } from "./task-mode";
import type { ExecutionMode } from "./domain";

export const TASK_CONTINUATION_MESSAGE = "TASK_CONTINUATION_REQUIRED";

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

async function runAgentCore(prompt: string, executionMode: ExecutionMode) {
  store.addProcessLog("agent", "info", `テキスト要求の処理を開始しました (${executionMode === "task" ? "タスクモード" : "通常モード"})`);
  store.setBrowser("agent_running");
  const state = store.snapshot();
  let action: BrowserAction | null = null;
  let usedFoundry = false;
  const explicitModel = browserTaskRequest(prompt, state.currentUrl);
  const browserIntent = requiresBrowserTask(prompt, state.currentUrl);

  if (executionMode === "task" && browserIntent) {
    store.addProcessLog("agent", "info", "タスクモードで要求を分解しています");
    const result = await runTaskMode(prompt);
    usedFoundry = result.steps > 0;
    action = { type: "navigate", url: store.snapshot().currentUrl, actor: "agent" };
    if ("awaitingApproval" in result && result.awaitingApproval) {
      return "タスクを続けるには、画面に表示された内容を確認して承認または拒否してください。";
    }
    if ("continuationRequired" in result && result.continuationRequired) return TASK_CONTINUATION_MESSAGE;
    return result.message ?? "タスクの全条件を画面上で確認しました。";
  }

  if (executionMode === "normal" && browserIntent && explicitModel) {
    store.addProcessLog("browser", "info", "関連ページを探索しています", explicitModel.targetUrl);
    await runBrowserTask(prompt);
    action = { type: "navigate", url: store.snapshot().currentUrl, actor: "agent" };
    store.addProcessLog("browser", "success", "関連ページを表示しました", store.snapshot().currentUrl);
  }

  if (executionMode === "normal" && state.agentMode === "foundry" && browserIntent && !action) {
    try {
      store.addProcessLog("browser", "info", "Computer Useを開始しました");
      const result = await runComputerUse(prompt);
      usedFoundry = result.steps > 0;
      store.addProcessLog("browser", "success", "Computer Useが完了しました", `${result.steps}ステップ実行`);
      if (result.awaitingApproval) return "操作を続けるには、画面に表示された内容を確認して承認または拒否してください。";
      if (result.continuationRequired) return TASK_CONTINUATION_MESSAGE;
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

export async function runAgent(
  prompt: string,
  executionMode: ExecutionMode = "normal",
  fallbackFromRunId?: string,
  continueHistory = false,
  recordHistory = true,
) {
  const runId = recordHistory
    ? (continueHistory ? runHistoryRecorder.currentRunId() : null) ?? await runHistoryRecorder.begin(prompt, executionMode, fallbackFromRunId).catch((error) => {
    store.addProcessLog("system", "error", "操作履歴の記録を開始できませんでした", error instanceof Error ? error.message : undefined);
    return null;
    })
    : null;
  try {
    const result = await runAgentCore(prompt, executionMode);
    const remainsActive = result === TASK_CONTINUATION_MESSAGE || store.snapshot().browserStatus === "awaiting_approval";
    if (runId && !remainsActive) {
      await runHistoryRecorder.finish(runId, "completed").catch((error) => {
        store.addProcessLog("system", "error", "操作履歴を確定できませんでした", error instanceof Error ? error.message : undefined);
      });
    }
    return result;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "UNKNOWN_ERROR";
    if (runId) {
      await runHistoryRecorder.finish(runId, reason === "AGENT_STOPPED" ? "stopped" : "failed", reason).catch((historyError) => {
        store.addProcessLog("system", "error", "失敗した操作履歴を確定できませんでした", historyError instanceof Error ? historyError.message : undefined);
      });
    }
    throw error;
  }
}