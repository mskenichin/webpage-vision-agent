import { browserManager } from "./browser";
import type { BrowserAction } from "./domain";
import { requestFoundryComputerStep, type ComputerStep } from "./foundry";
import { store, type PendingApproval } from "./store";

const MAX_STEPS = 20;
const RUN_TIMEOUT_MS = 120_000;
let activeRun: AbortController | null = null;

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
  };
}

async function runLoop(goal: string, progress: RunProgress, signal: AbortSignal) {
  const deployment = process.env.AZURE_COMPUTER_MODEL ?? process.env.AZURE_CHAT_MODEL ?? "gpt-5.4";
  if (!deployment) throw new Error("COMPUTER_USE_UNAVAILABLE");
  const seen = new Map<string, number>();
  let emptyPlans = 0;
  store.setBrowser("agent_running");

  try {
    while (progress.steps + progress.observations < MAX_STEPS) {
      if (signal.aborted) throw new Error("AGENT_STOPPED");
      const state = store.snapshot();
      const result = await requestFoundryComputerStep(
        emptyPlans > 0 ? `${goal}\nまだ目的を達成していません。画面を操作して目的のページを表示してください。` : goal,
        await browserManager.screenshot(),
        state.profile,
        deployment,
        progress.previous,
        signal,
        state.interests,
      );
      if (!result) {
        if (progress.steps === 0 && emptyPlans === 0) {
          emptyPlans += 1;
          progress.previous = undefined;
          continue;
        }
        if (progress.steps === 0) {
          const state = store.snapshot();
          return {
            ok: false,
            steps: 0,
            currentUrl: state.currentUrl,
            message: "該当箇所へ移動できませんでした。現在表示中の内容だけを案内します。",
          };
        }
        break;
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
        return { ok: false, awaitingApproval: true, approval: pending.request, steps: progress.steps, currentUrl: state.currentUrl };
      }
      const key = result.actions.map(actionKey).join("|");
      const repetitions = (seen.get(key) ?? 0) + 1;
      seen.set(key, repetitions);
      if (repetitions >= 3) throw new Error("COMPUTER_USE_REPEATED_ACTION");
      if (progress.steps + result.actions.length > MAX_STEPS) throw new Error("COMPUTER_USE_MAX_STEPS");
      for (const action of result.actions) {
        store.addProcessLog("browser", "info", `Computer Useステップ ${progress.steps + 1}`, actionDescription(action));
        await browserManager.execute(action, crypto.randomUUID());
        progress.steps += 1;
      }
    }
    const state = store.snapshot();
    return { ok: true, steps: progress.steps, currentUrl: state.currentUrl, message: progress.steps > 0 ? "ブラウザ操作を完了しました。" : "追加のブラウザ操作は不要でした。" };
  } catch (error) {
    if (signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("AGENT_STOPPED");
    }
    throw error;
  } finally {
    if (store.snapshot().browserStatus === "agent_running") store.setBrowser("ready");
  }
}

async function controlledRun<T>(task: (signal: AbortSignal) => Promise<T>) {
  activeRun?.abort();
  const controller = new AbortController();
  activeRun = controller;
  const timeout = setTimeout(() => controller.abort(new Error("AGENT_TIMEOUT")), RUN_TIMEOUT_MS);
  try {
    return await task(controller.signal);
  } finally {
    clearTimeout(timeout);
    if (activeRun === controller) activeRun = null;
  }
}

export async function runComputerUse(goal: string) {
  return controlledRun((signal) => runLoop(goal, { steps: 0, observations: 0 }, signal));
}

export async function approveComputerUse(id: string) {
  const pending = store.takeApproval(id);
  if (!pending) throw new Error("APPROVAL_EXPIRED");
  if (store.snapshot().currentUrl !== pending.request.targetUrl) throw new Error("APPROVAL_EXPIRED");
  for (const action of pending.actions) {
    await browserManager.execute(action, crypto.randomUUID());
  }
  return controlledRun((signal) => runLoop(pending.goal, {
    steps: pending.steps + pending.actions.length,
    observations: pending.observations,
    previous: {
      responseId: pending.responseId,
      callId: pending.callId,
      acknowledgedSafetyChecks: pending.safetyChecks.filter((check) => check.code !== "local_sensitive_action"),
    },
  }, signal));
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