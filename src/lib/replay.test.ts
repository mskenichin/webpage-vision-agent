import { describe, expect, test, vi } from "vitest";
import type { AgentRunHistory, BrowserAction, ElementLocator, RecordedBrowserAction } from "./domain";
import { fingerprintsMatch, replayRun, type ReplayDependencies } from "./replay";
import { store } from "./store";

function baseAction(overrides: Partial<RecordedBrowserAction> = {}): RecordedBrowserAction {
  return {
    id: "action-1",
    sequence: 1,
    type: "click",
    x: 100,
    y: 200,
    beforeUrl: "https://lexus.jp/",
    afterUrl: "https://lexus.jp/models/nx/",
    beforeFrameRevision: 1,
    afterFrameRevision: 2,
    target: { tag: "a", label: "NX", href: "https://lexus.jp/models/nx/" },
    locator: { tag: "a", role: "link", name: "NX", href: "https://lexus.jp/models/nx/" },
    startedAt: "2026-08-16T10:00:01.000Z",
    completedAt: "2026-08-16T10:00:02.000Z",
    ...overrides,
  };
}

function history(overrides: Partial<AgentRunHistory> = {}): AgentRunHistory {
  return {
    id: "run-1",
    prompt: "NXのページを開いて",
    executionMode: "normal",
    startedAt: "2026-08-16T10:00:00.000Z",
    completedAt: "2026-08-16T10:00:03.000Z",
    startUrl: "https://lexus.jp/",
    endUrl: "https://lexus.jp/models/nx/",
    status: "completed",
    containsTextInput: false,
    replayable: true,
    schemaVersion: 2,
    actions: [baseAction()],
    ...overrides,
  };
}

function inPageHistory(locator?: ElementLocator): AgentRunHistory {
  return history({
    startUrl: "https://lexus.jp/models/is/",
    endUrl: "https://lexus.jp/models/is/",
    actions: [baseAction({
      id: "action-inpage",
      x: 288,
      y: 823,
      beforeUrl: "https://lexus.jp/models/is/",
      afterUrl: "https://lexus.jp/models/is/",
      target: { tag: "div", label: "見積りシミュレーション" },
      locator,
    })],
  });
}

interface DependencyOptions {
  locatorClicks?: boolean;
  locatePoint?: { x: number; y: number } | null;
  clickResultUrl?: string;
}

function dependencies(run: AgentRunHistory, options: DependencyOptions = {}) {
  const { locatorClicks = true, locatePoint = null, clickResultUrl } = options;
  let revision = 1;
  const setResultUrl = (action?: BrowserAction) => {
    if (action?.type === "navigate") store.setBrowser("ready", action.url);
    else store.setBrowser("ready", clickResultUrl ?? run.actions[0].afterUrl);
  };
  const execute = vi.fn(async (action: BrowserAction, _operationId?: string, _expectedRevision?: number, options?: { recordHistory?: boolean; recordActivity?: boolean }) => {
    expect(options?.recordHistory).toBe(false);
    expect(options?.recordActivity).toBe(false);
    revision += 1;
    setResultUrl(action);
  });
  const clickByLocator = vi.fn(async () => {
    if (!locatorClicks) return false;
    revision += 1;
    setResultUrl();
    return true;
  });
  const locateByFingerprint = vi.fn(async () => locatePoint);
  const settle = vi.fn(async () => undefined);
  const fallback = vi.fn(async () => "引き継ぎ完了");
  const result: ReplayDependencies = {
    browser: {
      currentRevision: () => revision,
      locateByFingerprint,
      clickByLocator,
      execute,
      settle,
    },
    getRun: vi.fn(async () => run),
    fallback,
  };
  return { dependencies: result, execute, fallback, settle, locateByFingerprint, clickByLocator };
}

describe("replayRun", () => {
  test("replays a navigation click via the recorded locator", async () => {
    const run = history();
    const testDependencies = dependencies(run);

    await expect(replayRun(run.id, testDependencies.dependencies)).resolves.toMatchObject({
      ok: true,
      status: "completed",
      completedSteps: 1,
    });
    expect(testDependencies.clickByLocator).toHaveBeenCalledWith(run.actions[0].locator, "click");
    expect(testDependencies.locateByFingerprint).not.toHaveBeenCalled();
    expect(testDependencies.fallback).not.toHaveBeenCalled();
  });

  test("falls back to the fingerprint point when the locator click fails", async () => {
    const run = inPageHistory({ tag: "div", role: "button", name: "見積りシミュレーション" });
    const testDependencies = dependencies(run, { locatorClicks: false, locatePoint: { x: 640, y: 480 } });

    await expect(replayRun(run.id, testDependencies.dependencies)).resolves.toMatchObject({ ok: true, status: "completed" });
    expect(testDependencies.clickByLocator).toHaveBeenCalled();
    const clickCall = testDependencies.execute.mock.calls.find(([action]) => action.type === "click");
    expect(clickCall?.[0]).toMatchObject({ x: 640, y: 480 });
  });

  test("falls back to the recorded coordinate when locator and fingerprint fail", async () => {
    const run = inPageHistory({ tag: "div", role: "button", name: "見積りシミュレーション" });
    const testDependencies = dependencies(run, { locatorClicks: false, locatePoint: null });

    await expect(replayRun(run.id, testDependencies.dependencies)).resolves.toMatchObject({ ok: true, status: "completed" });
    const clickCall = testDependencies.execute.mock.calls.find(([action]) => action.type === "click");
    expect(clickCall?.[0]).toMatchObject({ x: run.actions[0].x, y: run.actions[0].y });
    expect(testDependencies.fallback).not.toHaveBeenCalled();
  });

  test("does not verify the URL for in-page clicks", async () => {
    const run = inPageHistory({ tag: "div", role: "button", name: "オプションを閉じる" });
    const testDependencies = dependencies(run, { clickResultUrl: "https://lexus.jp/request/estimate_sim/" });

    await expect(replayRun(run.id, testDependencies.dependencies)).resolves.toMatchObject({ ok: true, status: "completed" });
    expect(testDependencies.fallback).not.toHaveBeenCalled();
  });

  test("accepts a navigation whose query differs but path matches", async () => {
    const run = history();
    const testDependencies = dependencies(run, { clickResultUrl: "https://lexus.jp/models/nx/?utm_source=x" });

    await expect(replayRun(run.id, testDependencies.dependencies)).resolves.toMatchObject({ ok: true, status: "completed" });
    expect(testDependencies.fallback).not.toHaveBeenCalled();
  });

  test("hands off once when a navigation reaches a different path", async () => {
    const run = history();
    const testDependencies = dependencies(run, { clickResultUrl: "https://lexus.jp/models/is/" });

    await expect(replayRun(run.id, testDependencies.dependencies)).resolves.toMatchObject({
      ok: false,
      reason: "REPLAY_RESULT_MISMATCH",
      completedSteps: 1,
    });
    expect(testDependencies.fallback).toHaveBeenCalledWith(run.prompt, run.executionMode, run.id, false);
  });

  test("hands off once when a recorded action is a sensitive operation", async () => {
    const run = history({
      startUrl: "https://lexus.jp/models/is/",
      endUrl: "https://lexus.jp/models/is/",
      actions: [baseAction({
        id: "action-risky",
        beforeUrl: "https://lexus.jp/models/is/",
        afterUrl: "https://lexus.jp/models/is/",
        target: { tag: "button", label: "ログインして送信" },
        locator: { tag: "button", role: "button", name: "ログインして送信" },
      })],
    });
    const testDependencies = dependencies(run);

    await expect(replayRun(run.id, testDependencies.dependencies)).resolves.toMatchObject({
      ok: false,
      reason: "REPLAY_APPROVAL_REQUIRED",
      completedSteps: 0,
    });
    expect(testDependencies.fallback).toHaveBeenCalledWith(run.prompt, run.executionMode, run.id, false);
  });

  test("does not require approval for a benign recorded control such as Close", async () => {
    const run = history({
      startUrl: "https://lexus.jp/request/estimate_sim/option",
      endUrl: "https://lexus.jp/request/estimate_sim/option",
      actions: [baseAction({
        id: "action-close",
        x: 1317,
        y: 61,
        beforeUrl: "https://lexus.jp/request/estimate_sim/option",
        afterUrl: "https://lexus.jp/request/estimate_sim/option",
        target: { tag: "button", label: "Close" },
        locator: { tag: "button", role: "button", name: "Close" },
      })],
    });
    const testDependencies = dependencies(run);

    await expect(replayRun(run.id, testDependencies.dependencies)).resolves.toMatchObject({ ok: true, status: "completed", completedSteps: 1 });
    expect(testDependencies.fallback).not.toHaveBeenCalled();
  });

  test("resumes replay from the next step after a targeted AI bridge", async () => {
    const versionUrl = "https://lexus.jp/request/estimate_sim/version?car_name_en=IS300h";
    const optionUrl = "https://lexus.jp/request/estimate_sim/option";
    const run = history({
      startUrl: versionUrl,
      endUrl: optionUrl,
      actions: [
        baseAction({ id: "select", sequence: 1, type: "click", beforeUrl: versionUrl, afterUrl: optionUrl, target: { tag: "button", label: "選択" }, locator: { tag: "button", role: "button", name: "選択" } }),
        baseAction({ id: "wait", sequence: 2, type: "wait", x: undefined, y: undefined, beforeUrl: optionUrl, afterUrl: optionUrl, target: undefined, locator: undefined }),
      ],
    });

    let revision = 1;
    const execute = vi.fn(async (action: BrowserAction) => {
      revision += 1;
      if (action.type === "navigate") store.setBrowser("ready", action.url);
    });
    const clickByLocator = vi.fn(async () => { revision += 1; store.setBrowser("ready", versionUrl); return true; });
    const locateByFingerprint = vi.fn(async () => null);
    const settle = vi.fn(async () => undefined);
    const fallback = vi.fn(async () => { store.setBrowser("ready", optionUrl); return "bridge"; });
    const deps: ReplayDependencies = {
      browser: { currentRevision: () => revision, locateByFingerprint, clickByLocator, execute, settle },
      getRun: vi.fn(async () => run),
      fallback,
    };

    await expect(replayRun(run.id, deps)).resolves.toMatchObject({ ok: true, status: "completed", completedSteps: 2 });
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(fallback.mock.calls[0][0]).toContain(optionUrl);
    expect(fallback.mock.calls[0][1]).toBe("normal");
  });

  test("rejects runs containing text input before operating the browser", async () => {
    const run = history({ containsTextInput: true, replayable: false });
    const testDependencies = dependencies(run);

    await expect(replayRun(run.id, testDependencies.dependencies)).rejects.toThrow("RUN_HISTORY_NOT_REPLAYABLE");
    expect(testDependencies.execute).not.toHaveBeenCalled();
  });
});

describe("fingerprintsMatch", () => {
  test("normalizes labels and tracking parameters", () => {
    expect(fingerprintsMatch(
      { tag: "a", label: "LEXUS NX", href: "https://lexus.jp/models/nx/?utm_source=test" },
      { tag: "a", label: "  lexus   nx ", href: "https://lexus.jp/models/nx/" },
    )).toBe(true);
  });
});