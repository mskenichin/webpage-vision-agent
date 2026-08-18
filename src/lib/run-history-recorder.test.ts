import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { BrowserAction } from "./domain";
import { RunHistoryRepository } from "./run-history";
import { RunHistoryRecorder } from "./run-history-recorder";
import { DemoStore } from "./store";

const directories: string[] = [];

async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "webpage-vision-recorder-"));
  directories.push(directory);
  const filePath = path.join(directory, "run-history.json");
  const repository = new RunHistoryRepository({ filePath });
  const store = new DemoStore();
  store.setBrowser("ready", "https://lexus.jp/");
  return { filePath, repository, store, recorder: new RunHistoryRecorder(repository, store) };
}

function recordInput(action: BrowserAction) {
  return {
    action,
    beforeUrl: "https://lexus.jp/",
    afterUrl: "https://lexus.jp/models/nx/",
    beforeFrameRevision: 1,
    afterFrameRevision: 2,
    startedAt: "2026-08-16T10:00:01.000Z",
    completedAt: "2026-08-16T10:00:02.000Z",
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("RunHistoryRecorder", () => {
  test("does not create runs while collection is off", async () => {
    const context = await setup();
    context.store.updateProfile({ runHistoryCollection: false });

    expect(await context.recorder.begin("NXを見せて", "normal")).toBeNull();
    expect(await context.repository.list()).toEqual([]);
  });

  test("deletes the active partial run when collection is disabled", async () => {
    const context = await setup();
    const runId = await context.recorder.begin("NXを見せて", "normal");
    await context.recorder.recordAction(recordInput({ type: "click", x: 100, y: 200, actor: "agent" }));
    context.store.updateProfile({ runHistoryCollection: false });

    await context.recorder.disableCollection();

    expect(runId).not.toBeNull();
    expect(await context.repository.get(runId!)).toBeNull();
  });

  test("marks text-input runs non-replayable without persisting the input value", async () => {
    const context = await setup();
    const runId = await context.recorder.begin("検索して", "normal");
    await context.recorder.recordAction(recordInput({ type: "type", text: "secret@example.com", actor: "agent" }));
    await context.recorder.finish(runId!, "completed");

    expect(await context.repository.get(runId!)).toMatchObject({ containsTextInput: true, replayable: false, actions: [] });
    expect(await readFile(context.filePath, "utf8")).not.toContain("secret@example.com");
  });

  test("does not flag empty text input as a real input", async () => {
    const context = await setup();
    const runId = await context.recorder.begin("検索して", "normal");
    await context.recorder.recordAction(recordInput({ type: "type", text: "   ", actor: "agent" }));
    await context.recorder.finish(runId!, "completed");

    expect(await context.repository.get(runId!)).toMatchObject({ containsTextInput: false, replayable: true });
  });

  test("keeps an active run available for approval or chunk continuation", async () => {
    const context = await setup();
    const runId = await context.recorder.begin("購入手続きを進めて", "task");

    expect(context.recorder.currentRunId()).toBe(runId);
    await context.recorder.finishActive("completed");

    expect(context.recorder.currentRunId()).toBeNull();
    expect(await context.repository.get(runId!)).toMatchObject({ status: "completed" });
  });
});