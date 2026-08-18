import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { AgentRunHistory, RecordedBrowserAction } from "./domain";
import { RunHistoryRepository } from "./run-history";

const directories: string[] = [];

async function repository(now = new Date("2026-08-16T12:00:00.000Z")) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "webpage-vision-history-"));
  directories.push(directory);
  const filePath = path.join(directory, "run-history.json");
  return { filePath, repository: new RunHistoryRepository({ filePath, now: () => now }) };
}

function run(id: string, startedAt = "2026-08-16T10:00:00.000Z"): AgentRunHistory {
  return {
    id,
    prompt: "NXのページを開いて",
    executionMode: "normal",
    startedAt,
    startUrl: "https://lexus.jp/",
    status: "running",
    containsTextInput: false,
    replayable: true,
    actions: [],
  };
}

function action(sequence: number): RecordedBrowserAction {
  return {
    id: crypto.randomUUID(),
    sequence,
    type: "click",
    x: 120,
    y: 240,
    beforeUrl: "https://lexus.jp/",
    afterUrl: "https://lexus.jp/models/nx/",
    beforeFrameRevision: 1,
    afterFrameRevision: 2,
    target: { tag: "a", label: "NX", href: "https://lexus.jp/models/nx/" },
    startedAt: "2026-08-16T10:00:01.000Z",
    completedAt: "2026-08-16T10:00:02.000Z",
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("RunHistoryRepository", () => {
  test("persists runs and returns newest summaries first", async () => {
    const { repository: history } = await repository();
    await history.create(run("older", "2026-08-15T10:00:00.000Z"));
    await history.create(run("newer"));
    await history.appendAction("newer", action(1));

    expect(await history.list()).toEqual([
      expect.objectContaining({ id: "newer", actionCount: 1 }),
      expect.objectContaining({ id: "older", actionCount: 0 }),
    ]);
    expect((await history.get("newer"))?.actions).toHaveLength(1);
  });

  test("serializes concurrent writes without losing runs", async () => {
    const { repository: history } = await repository();
    await Promise.all(Array.from({ length: 10 }, (_, index) => history.create(run(`run-${index}`))));
    expect(await history.list()).toHaveLength(10);
  });

  test("prunes expired runs and supports deletion", async () => {
    const { repository: history } = await repository();
    await history.create(run("expired", "2026-06-01T00:00:00.000Z"));
    await history.create(run("current"));

    expect(await history.prune()).toBe(1);
    expect(await history.delete("current")).toBe(true);
    expect(await history.list()).toEqual([]);
  });

  test("never persists browser text input values", async () => {
    const { filePath, repository: history } = await repository();
    const item = run("sensitive");
    item.containsTextInput = true;
    item.replayable = false;
    await history.create(item);

    const raw = await readFile(filePath, "utf8");
    expect(raw).not.toContain("text");
    expect(raw).not.toContain("secret@example.com");
  });

  test("reports corrupt files instead of silently replacing them", async () => {
    const { filePath, repository: history } = await repository();
    await writeFile(filePath, "not-json", "utf8");
    await expect(history.list()).rejects.toThrow("Failed to read run history");
  });
});