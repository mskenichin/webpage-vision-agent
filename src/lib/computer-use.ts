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
  const operation = result.action?.type === "type"
    ? `「${result.action.text?.slice(0, 80) ?? "入力内容"}」を入力`
    : `${result.action?.type ?? "操作"}を実行`;
  return {
    request: {
      id: crypto.randomUUID(),
      operation,
      targetUrl: store.snapshot().currentUrl,
      impact: result.safetyChecks.map((check) => check.message).join(" ") || "外部サービスまたは現在のページへ影響する操作です。",
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    },
    goal,
    action: result.action!,
    responseId: result.responseId,
    callId: result.callId,
    safetyChecks: result.safetyChecks,
    steps: progress.steps,
    observations: progress.observations,
  };
}

async function runLoop(goal: string, progress: RunProgress, signal: AbortSignal) {
  const deployment = process.env.AZURE_FOUNDRY_MODEL ?? "computer-use-preview";
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
      );
      if (!result) {
        if (progress.steps === 0 && emptyPlans === 0) {
          emptyPlans += 1;
          progress.previous = undefined;
          continue;
        }
        if (progress.steps === 0) throw new Error("COMPUTER_USE_NO_ACTION");
        break;
      }
      progress.previous = { responseId: result.responseId, callId: result.callId };
      if (result.observationOnly) {
        progress.observations += 1;
        continue;
      }
      if (!result.action) break;
      const localRisk = await browserManager.inspectActionRisk(result.action);
      if (localRisk) {
        result.safetyChecks.push({ id: crypto.randomUUID(), code: "local_sensitive_action", message: localRisk });
      }
      if (result.safetyChecks.length > 0) {
        const pending = approvalFor(goal, result, progress);
        store.setApproval(pending);
        return { ok: false, awaitingApproval: true, approval: pending.request, steps: progress.steps, currentUrl: state.currentUrl };
      }
      const key = actionKey(result.action);
      const repetitions = (seen.get(key) ?? 0) + 1;
      seen.set(key, repetitions);
      if (repetitions >= 3) throw new Error("COMPUTER_USE_REPEATED_ACTION");
      await browserManager.execute(result.action, crypto.randomUUID());
      progress.steps += 1;
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
  await browserManager.execute(pending.action, crypto.randomUUID());
  return controlledRun((signal) => runLoop(pending.goal, {
    steps: pending.steps + 1,
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