import { browserManager } from "./browser";
import type { BrowserAction } from "./domain";
import { requestFoundryComputerStep, type ComputerStep } from "./foundry";
import { store, type PendingApproval } from "./store";

const MAX_STEPS = 20;
const MAX_OBSERVATIONS = 20;
const RUN_TIMEOUT_MS = 75_000;
let activeRun: AbortController | null = null;

export function computerActionsWithinLimit(actions: BrowserAction[], completedSteps: number, maxSteps = MAX_STEPS) {
  return actions.slice(0, Math.max(0, maxSteps - completedSteps));
}

function actionKey(action: BrowserAction | null) {
  return action ? JSON.stringify({ type: action.type, x: action.x, y: action.y, deltaY: action.deltaY, text: action.text, key: action.key, url: action.url }) : "done";
}

function actionDescription(action: BrowserAction) {
  switch (action.type) {
    case "click": return `クリック (${Math.round(action.x ?? 0)}, ${Math.round(action.y ?? 0)})`;
    case "double_click": return `ダブルクリック (${Math.round(action.x ?? 0)}, ${Math.round(action.y ?? 0)})`;
    case "scroll": return `スクロール (${Math.round(action.deltaY ?? 0)})`;
    case "type": return "テキストを入力";
    case "key": return `キー入力 (${action.key ?? "不明"})`;
    case "wait": return "画面の更新を待機";
    case "navigate": return action.url ?? "ページへ移動";
    case "back": return "前のページへ戻る";
    case "reload": return "ページを再読み込み";
  }
}

interface RunProgress {
  steps: number;
  observations: number;
  modelCalls: number;
  modelDurationMs: number;
  screenshotDurationMs: number;
  previous?: {
    responseId: string;
    callId: string;
    acknowledgedSafetyChecks?: PendingApproval["safetyChecks"];
  };
}

function approvalFor(goal: string, result: ComputerStep, progress: RunProgress): PendingApproval {
  const firstAction = result.actions[0];
  const operation = firstAction?.type === "type"
    ? `「${firstAction.text?.slice(0, 80) ?? "入力内容"}」を入力`
    : result.actions.map(actionDescription).join("、") || "操作を実行";
  return {
    request: {
      id: crypto.randomUUID(),
      operation,
      targetUrl: store.snapshot().currentUrl,
      impact: result.safetyChecks.map((check) => check.message).join(" ") || "外部サービスまたは現在のページへ影響する操作です。",
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    },
    goal,
    actions: result.actions,
    responseId: result.responseId,
    callId: result.callId,
    safetyChecks: result.safetyChecks,
    steps: progress.steps,
    observations: progress.observations,
    modelCalls: progress.modelCalls,
    modelDurationMs: progress.modelDurationMs,
    screenshotDurationMs: progress.screenshotDurationMs,
  };
}

function logRunLatency(progress: RunProgress, deployment: string) {
  store.addProcessLog(
    "browser",
    "info",
    `Computer Use: ${progress.modelCalls}回 / ${progress.modelDurationMs + progress.screenshotDurationMs}ms`,
    JSON.stringify({
      model: deployment,
      modelCalls: progress.modelCalls,
      modelDurationMs: progress.modelDurationMs,
      screenshotDurationMs: progress.screenshotDurationMs,
      steps: progress.steps,
      observations: progress.observations,
    }, null, 2),
  );
}

async function runLoop(goal: string, progress: RunProgress, signal: AbortSignal) {
  const deployment = process.env.AZURE_COMPUTER_MODEL ?? process.env.AZURE_CHAT_MODEL ?? "gpt-5.4";
  if (!deployment) throw new Error("COMPUTER_USE_UNAVAILABLE");
  const seen = new Map<string, number>();
  store.setBrowser("agent_running");

  try {
    while (progress.steps < MAX_STEPS && progress.observations < MAX_OBSERVATIONS) {
      if (signal.aborted) throw new Error("AGENT_STOPPED");
      const state = store.snapshot();
      const screenshotStartedAt = Date.now();
      const screenshot = await browserManager.computerScreenshot();
      progress.screenshotDurationMs += Date.now() - screenshotStartedAt;
      const modelStartedAt = Date.now();
      const result = await requestFoundryComputerStep(
        goal,
        screenshot,
        state.profile,
        deployment,
        progress.previous,
        signal,
        state.interests,
      );
      progress.modelCalls += 1;
      progress.modelDurationMs += Date.now() - modelStartedAt;
      if (result.completed) {
        logRunLatency(progress, deployment);
        const completedState = store.snapshot();
        if (!result.goalAchieved) {
          return {
            ok: false,
            conditionUnmet: true,
            steps: progress.steps,
            currentUrl: completedState.currentUrl,
            message: result.message ?? "画面上で成功条件を確認できませんでした。",
          };
        }
        return {
          ok: true,
          steps: progress.steps,
          currentUrl: completedState.currentUrl,
          message: progress.steps > 0 ? "ブラウザ操作と表示確認を完了しました。" : "現在の画面で目的の内容を確認しました。",
        };
      }
      progress.previous = { responseId: result.responseId, callId: result.callId };
      if (result.observationOnly) {
        progress.observations += 1;
        continue;
      }
      if (result.actions.length === 0) break;
      if (signal.aborted) throw new Error("AGENT_STOPPED");
      for (const action of result.actions) {
        const localRisk = await browserManager.inspectActionRisk(action);
        if (signal.aborted) throw new Error("AGENT_STOPPED");
        if (localRisk) {
          result.safetyChecks.push({ id: crypto.randomUUID(), code: "local_sensitive_action", message: localRisk });
        }
      }
      if (result.safetyChecks.length > 0) {
        const pending = approvalFor(goal, result, progress);
        store.setApproval(pending);
        store.addProcessLog("browser", "info", "Computer Useが承認を待っています", result.actions.map(actionDescription).join("、"));
        logRunLatency(progress, deployment);
        return { ok: false, awaitingApproval: true, approval: pending.request, steps: progress.steps, currentUrl: state.currentUrl };
      }
      const key = result.actions.map(actionKey).join("|");
      const repetitions = (seen.get(key) ?? 0) + 1;
      seen.set(key, repetitions);
      if (repetitions >= 3) throw new Error("COMPUTER_USE_REPEATED_ACTION");
      const remainingActions = computerActionsWithinLimit(result.actions, progress.steps);
      for (const action of remainingActions) {
        if (action.type === "type" && ((action.text ?? "").trim().length === 0 || !(await browserManager.canAcceptTextInput()))) {
          store.addProcessLog("browser", "info", "不要な文字入力をスキップしました", "編集可能な入力欄が対象ではありません");
          continue;
        }
        store.addProcessLog("browser", "info", `Computer Useステップ ${progress.steps + 1}`, actionDescription(action));
        await browserManager.execute(action, crypto.randomUUID());
        progress.steps += 1;
      }
      if (remainingActions.length < result.actions.length) break;
    }
    const state = store.snapshot();
    logRunLatency(progress, deployment);
    return {
      ok: false,
      continuationRequired: true,
      steps: progress.steps,
      currentUrl: state.currentUrl,
      message: "操作上限ごとに画面状態を保存し、次の実行へ継続します。",
    };
  } catch (error) {
    if (signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("AGENT_STOPPED");
    }
    throw error;
  } finally {
    if (store.snapshot().browserStatus === "agent_running") store.setBrowser("ready");
  }
}

export async function controlledRun<T>(task: (signal: AbortSignal) => Promise<T>, timeoutMs = RUN_TIMEOUT_MS) {
  activeRun?.abort(new Error("AGENT_STOPPED"));
  const controller = new AbortController();
  activeRun = controller;
  const timeout = setTimeout(() => controller.abort(new Error("COMPUTER_USE_CHUNK_TIMEOUT")), timeoutMs);
  let removeAbortListener = () => {};
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => reject(controller.signal.reason instanceof Error ? controller.signal.reason : new Error("AGENT_STOPPED"));
    controller.signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => controller.signal.removeEventListener("abort", onAbort);
  });
  try {
    return await Promise.race([task(controller.signal), aborted]);
  } catch (error) {
    if (isComputerUseChunkTimeout(error, controller.signal)) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timeout);
    removeAbortListener();
    if (activeRun === controller) activeRun = null;
  }
}

export function isComputerUseChunkTimeout(error: unknown, signal?: AbortSignal) {
  if (signal?.aborted && signal.reason instanceof Error
    && signal.reason.message === "COMPUTER_USE_CHUNK_TIMEOUT") return true;
  return error instanceof Error && error.message === "COMPUTER_USE_CHUNK_TIMEOUT";
}

function chunkContinuation(progress: RunProgress) {
  const state = store.snapshot();
  const deployment = process.env.AZURE_COMPUTER_MODEL ?? process.env.AZURE_CHAT_MODEL ?? "gpt-5.4";
  logRunLatency(progress, deployment);
  return {
    ok: false,
    awaitingApproval: false,
    continuationRequired: true,
    steps: progress.steps,
    currentUrl: state.currentUrl,
    message: "操作時間ごとに画面状態を保存し、次の実行へ継続します。",
  };
}

export async function runComputerUse(goal: string) {
  const progress = { steps: 0, observations: 0, modelCalls: 0, modelDurationMs: 0, screenshotDurationMs: 0 };
  try {
    return await controlledRun((signal) => runLoop(goal, progress, signal));
  } catch (error) {
    if (!isComputerUseChunkTimeout(error)) throw error;
    return chunkContinuation(progress);
  }
}

export async function approveComputerUse(id: string) {
  const pending = store.takeApproval(id);
  if (!pending) throw new Error("APPROVAL_EXPIRED");
  if (store.snapshot().currentUrl !== pending.request.targetUrl) throw new Error("APPROVAL_EXPIRED");
  for (const action of pending.actions) {
    await browserManager.execute(action, crypto.randomUUID());
  }
  const progress = {
    steps: pending.steps + pending.actions.length,
    observations: pending.observations,
    previous: {
      responseId: pending.responseId,
      callId: pending.callId,
      acknowledgedSafetyChecks: pending.safetyChecks.filter((check) => check.code !== "local_sensitive_action"),
    },
    modelCalls: pending.modelCalls,
    modelDurationMs: pending.modelDurationMs,
    screenshotDurationMs: pending.screenshotDurationMs,
  };
  try {
    return await controlledRun((signal) => runLoop(pending.goal, progress, signal));
  } catch (error) {
    if (!isComputerUseChunkTimeout(error)) throw error;
    return chunkContinuation(progress);
  }
}

export function rejectComputerUse(id: string) {
  if (!store.clearApproval(id)) throw new Error("APPROVAL_EXPIRED");
  return { ok: true, rejected: true };
}

export function stopComputerUse() {
  activeRun?.abort(new Error("AGENT_STOPPED"));
  activeRun = null;
  store.clearApproval();
  store.setBrowser("ready");
}