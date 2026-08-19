import { runAgent } from "./agent";
import { actionRisk, browserManager, isAllowedUrl } from "./browser";
import type { AgentRunHistory, BrowserAction, ElementFingerprint, ElementLocator, ReplayResult } from "./domain";
import { runHistoryRepository } from "./run-history";
import { store } from "./store";

interface ReplayBrowser {
  currentRevision(): number;
  locateByFingerprint(target: ElementFingerprint): Promise<{ x: number; y: number } | null>;
  clickByLocator(locator: ElementLocator, actionType: "click" | "double_click"): Promise<boolean>;
  execute(action: BrowserAction, operationId?: string, expectedFrameRevision?: number, options?: { recordHistory?: boolean; recordActivity?: boolean }): Promise<unknown>;
  settle(): Promise<unknown>;
}

export interface ReplayDependencies {
  browser: ReplayBrowser;
  getRun(id: string): Promise<AgentRunHistory | null>;
  fallback(prompt: string, executionMode: AgentRunHistory["executionMode"], runId: string, recordHistory: boolean): Promise<string>;
}

const defaultDependencies: ReplayDependencies = {
  browser: browserManager,
  getRun: (id) => runHistoryRepository.get(id),
  fallback: (prompt, executionMode, runId, recordHistory) => runAgent(prompt, executionMode, runId, false, recordHistory),
};

let replayAbortController: AbortController | null = null;

function normalizedUrl(value: string) {
  const url = new URL(value);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
  }
  return url.href.replace(/\/$/, "");
}

function sameUrl(left: string, right: string) {
  try {
    return normalizedUrl(left) === normalizedUrl(right);
  } catch {
    return false;
  }
}

function samePath(left: string, right: string) {
  try {
    const a = new URL(left);
    const b = new URL(right);
    return a.origin === b.origin && a.pathname.replace(/\/$/, "") === b.pathname.replace(/\/$/, "");
  } catch {
    return false;
  }
}

function normalizedLabel(value?: string) {
  return value?.trim().replace(/\s+/g, " ").toLocaleLowerCase() ?? "";
}

export function fingerprintsMatch(expected: ElementFingerprint, actual?: ElementFingerprint) {
  if (!actual || expected.tag !== actual.tag) return false;
  if (expected.href && (!actual.href || !sameUrl(expected.href, actual.href))) return false;
  if (expected.label && normalizedLabel(expected.label) !== normalizedLabel(actual.label)) return false;
  return true;
}

function toBrowserAction(action: AgentRunHistory["actions"][number]): BrowserAction {
  return {
    type: action.type,
    actor: "agent",
    ...(action.x !== undefined ? { x: action.x } : {}),
    ...(action.y !== undefined ? { y: action.y } : {}),
    ...(action.deltaY !== undefined ? { deltaY: action.deltaY } : {}),
    ...(action.key !== undefined ? { key: action.key } : {}),
    ...(action.url !== undefined ? { url: action.url } : {}),
  };
}

function stoppedResult(completedSteps: number): ReplayResult {
  return { ok: false, status: "stopped", completedSteps, reason: "ユーザーがリプレイを停止しました。" };
}

function bridgeGoal(recorded: AgentRunHistory["actions"][number]) {
  const label = recorded.locator?.name || recorded.target?.label || "";
  const control = label ? `画面内の「${label}」` : "画面内の該当する操作";
  return `${control}を操作して次の段階へ進めてください。ページ内のボタンやリンクだけを使い、アドレスバーやURLの直接入力、文字入力は行わないでください。外部送信、購入、予約、問い合わせ、個人情報入力もしないでください。`;
}

export function stopReplay() {
  replayAbortController?.abort();
}

export async function replayRun(runId: string, dependencies: ReplayDependencies = defaultDependencies): Promise<ReplayResult> {
  if (replayAbortController) throw new Error("REPLAY_ALREADY_RUNNING");
  const run = await dependencies.getRun(runId);
  if (!run) throw new Error("RUN_HISTORY_NOT_FOUND");
  if (!run.replayable || run.containsTextInput) throw new Error("RUN_HISTORY_NOT_REPLAYABLE");
  if (!isAllowedUrl(run.startUrl) || run.actions.some((action) => !isAllowedUrl(action.beforeUrl) || !isAllowedUrl(action.afterUrl))) {
    throw new Error("DOMAIN_NOT_ALLOWED");
  }

  const controller = new AbortController();
  replayAbortController = controller;
  let completedSteps = 0;
  store.setReplay({ runId, status: "running", currentStep: 0, totalSteps: run.actions.length, message: "開始ページを開いています" });
  store.setBrowser("agent_running");

  try {
    await dependencies.browser.execute(
      { type: "navigate", url: run.startUrl, actor: "agent" },
      crypto.randomUUID(),
      undefined,
      { recordHistory: false, recordActivity: false },
    );
    await dependencies.browser.settle();

    const performStep = async (recorded: AgentRunHistory["actions"][number]) => {
      const currentUrl = store.snapshot().currentUrl;
      if (!samePath(currentUrl, recorded.beforeUrl) && !sameUrl(currentUrl, recorded.beforeUrl)) {
        store.addProcessLog("browser", "error", `リプレイ #${recorded.sequence}: 開始URLが一致しません`, `expected=${recorded.beforeUrl} actual=${currentUrl}`);
        throw new Error("REPLAY_URL_MISMATCH");
      }

      const riskLabel = recorded.locator?.name ?? recorded.target?.label ?? "";
      if ((recorded.type === "click" || recorded.type === "double_click") && actionRisk(riskLabel)) {
        store.addProcessLog("browser", "info", `リプレイ #${recorded.sequence}: 重要操作のため承認が必要です`, riskLabel);
        throw new Error("REPLAY_APPROVAL_REQUIRED");
      }

      store.setReplay({
        runId,
        status: "running",
        currentStep: recorded.sequence,
        totalSteps: run.actions.length,
        currentAction: recorded.type,
      });

      const isNavigation = !sameUrl(recorded.beforeUrl, recorded.afterUrl);
      if (recorded.type === "click" || recorded.type === "double_click") {
        let handled = false;
        if (recorded.locator) {
          handled = await dependencies.browser.clickByLocator(recorded.locator, recorded.type);
          if (handled) {
            store.addProcessLog("browser", "info", `リプレイ #${recorded.sequence}: ロケータで操作しました`, `${recorded.locator.role ?? recorded.locator.tag}${recorded.locator.name ? ` / ${recorded.locator.name}` : ""}`);
          }
        }
        if (!handled) {
          const point = recorded.target && recorded.x !== undefined && recorded.y !== undefined
            ? await dependencies.browser.locateByFingerprint(recorded.target)
            : null;
          const action: BrowserAction = point
            ? { type: recorded.type, actor: "agent", x: point.x, y: point.y }
            : toBrowserAction(recorded);
          store.addProcessLog("browser", "info", `リプレイ #${recorded.sequence}: ${point ? "要素を検出しました" : "記録座標で再生します"}`, point ? `(${Math.round(point.x)}, ${Math.round(point.y)})` : `(${Math.round(recorded.x ?? 0)}, ${Math.round(recorded.y ?? 0)})`);
          await dependencies.browser.execute(action, crypto.randomUUID(), dependencies.browser.currentRevision(), { recordHistory: false, recordActivity: false });
        }
      } else {
        await dependencies.browser.execute(toBrowserAction(recorded), crypto.randomUUID(), dependencies.browser.currentRevision(), { recordHistory: false, recordActivity: false });
      }

      await dependencies.browser.settle();
      completedSteps += 1;

      if (isNavigation && !samePath(store.snapshot().currentUrl, recorded.afterUrl)) {
        store.addProcessLog("browser", "error", `リプレイ #${recorded.sequence}: 遷移先が一致しません`, `expected=${recorded.afterUrl} actual=${store.snapshot().currentUrl}`);
        throw new Error("REPLAY_RESULT_MISMATCH");
      }
    };

    const MAX_BRIDGES = 3;
    let bridges = 0;
    let index = 0;
    while (index < run.actions.length) {
      if (controller.signal.aborted) throw new Error("REPLAY_STOPPED");
      const recorded = run.actions[index];
      try {
        await performStep(recorded);
        index += 1;
      } catch (stepError) {
        if (controller.signal.aborted) throw stepError;
        const reason = stepError instanceof Error ? stepError.message : "REPLAY_FAILED";
        if (reason !== "REPLAY_RESULT_MISMATCH" || bridges >= MAX_BRIDGES || !isAllowedUrl(recorded.afterUrl)) throw stepError;

        bridges += 1;
        store.addProcessLog("browser", "info", `リプレイ #${recorded.sequence}: AIに1手だけ引き継ぎます`, recorded.afterUrl);
        store.setReplay({ runId, status: "falling_back", currentStep: recorded.sequence, totalSteps: run.actions.length, message: `AIがステップ${recorded.sequence}を補助しています` });
        await dependencies.fallback(bridgeGoal(recorded), "normal", run.id, false).catch(() => undefined);
        store.clearApproval();
        await dependencies.browser.settle();
        if (!samePath(store.snapshot().currentUrl, recorded.afterUrl)) {
          store.addProcessLog("browser", "error", `リプレイ #${recorded.sequence}: AI補助後も遷移先に到達できません`, `expected=${recorded.afterUrl} actual=${store.snapshot().currentUrl}`);
          throw stepError;
        }
        store.addProcessLog("browser", "success", `リプレイ #${recorded.sequence}: AI補助で到達し、リプレイを再開します`, `次は #${recorded.sequence + 1}`);
        index += 1;
      }
    }

    const result: ReplayResult = { ok: true, status: "completed", completedSteps };
    store.setReplay({ runId, status: "completed", currentStep: completedSteps, totalSteps: run.actions.length, message: "リプレイが完了しました" });
    store.setBrowser("ready", store.snapshot().currentUrl);
    return result;
  } catch (error) {
    if (controller.signal.aborted) {
      const result = stoppedResult(completedSteps);
      store.setReplay({ runId, status: "stopped", currentStep: completedSteps, totalSteps: run.actions.length, message: result.reason });
      store.setBrowser("ready", store.snapshot().currentUrl);
      return result;
    }

    const reason = error instanceof Error ? error.message : "REPLAY_FAILED";
    store.addProcessLog("browser", "error", "保存した操作を継続できないためAIへ引き継ぎます", reason);
    store.setReplay({ runId, status: "falling_back", currentStep: completedSteps, totalSteps: run.actions.length, message: "現在画面からAIが操作を引き継いでいます" });
    let fallbackMessage = "AIによる引き継ぎが完了しました";
    try {
      await dependencies.fallback(run.prompt, run.executionMode, run.id, false);
    } catch (fallbackError) {
      fallbackMessage = "AIによる引き継ぎも完了できませんでした";
      store.addProcessLog("agent", "error", fallbackMessage, fallbackError instanceof Error ? fallbackError.message : undefined);
    }
    const result: ReplayResult = { ok: false, status: "failed", completedSteps, reason };
    store.setReplay({ runId, status: "failed", currentStep: completedSteps, totalSteps: run.actions.length, message: fallbackMessage });
    return result;
  } finally {
    replayAbortController = null;
    if (store.snapshot().browserStatus === "agent_running") store.setBrowser("ready", store.snapshot().currentUrl);
  }
}