import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentRunHistory, AgentRunHistorySummary, RecordedBrowserAction } from "./domain";

const DEFAULT_RETENTION_DAYS = 30;

interface RunHistoryFile {
  version: 1;
  runs: AgentRunHistory[];
}

export interface RunHistoryRepositoryOptions {
  filePath?: string;
  retentionDays?: number;
  now?: () => Date;
}

function summary(run: AgentRunHistory): AgentRunHistorySummary {
  const { actions, ...rest } = run;
  return { ...rest, actionCount: actions.length };
}

export class RunHistoryRepository {
  private readonly filePath: string;
  private readonly retentionDays: number;
  private readonly now: () => Date;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: RunHistoryRepositoryOptions = {}) {
    this.filePath = options.filePath ?? path.join(process.cwd(), ".data", "run-history.json");
    this.retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
    this.now = options.now ?? (() => new Date());
  }

  async list(): Promise<AgentRunHistorySummary[]> {
    const data = await this.read();
    return data.runs
      .slice()
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .map(summary);
  }

  async get(id: string): Promise<AgentRunHistory | null> {
    const data = await this.read();
    return data.runs.find((run) => run.id === id) ?? null;
  }

  async create(run: AgentRunHistory): Promise<void> {
    await this.mutate((data) => {
      if (data.runs.some((item) => item.id === run.id)) throw new Error(`Run history already exists: ${run.id}`);
      data.runs.push(structuredClone(run));
    });
  }

  async update(id: string, update: (run: AgentRunHistory) => void): Promise<AgentRunHistory | null> {
    let result: AgentRunHistory | null = null;
    await this.mutate((data) => {
      const run = data.runs.find((item) => item.id === id);
      if (!run) return;
      update(run);
      result = structuredClone(run);
    });
    return result;
  }

  async appendAction(id: string, action: RecordedBrowserAction): Promise<AgentRunHistory | null> {
    return this.update(id, (run) => {
      if (run.status !== "running") throw new Error(`Cannot append to finished run history: ${id}`);
      if (action.sequence !== run.actions.length + 1) throw new Error(`Invalid action sequence for run history: ${id}`);
      run.actions.push(structuredClone(action));
    });
  }

  async delete(id: string): Promise<boolean> {
    let deleted = false;
    await this.mutate((data) => {
      const next = data.runs.filter((run) => run.id !== id);
      deleted = next.length !== data.runs.length;
      data.runs = next;
    });
    return deleted;
  }

  async clear(): Promise<void> {
    await this.mutate((data) => {
      data.runs = [];
    });
  }

  async prune(): Promise<number> {
    let removed = 0;
    const cutoff = this.now().getTime() - this.retentionDays * 24 * 60 * 60 * 1000;
    await this.mutate((data) => {
      const retained = data.runs.filter((run) => Date.parse(run.startedAt) >= cutoff);
      removed = data.runs.length - retained.length;
      data.runs = retained;
    });
    return removed;
  }

  async removeFile(): Promise<void> {
    await this.enqueue(async () => {
      await rm(this.filePath, { force: true });
    });
  }

  private async read(): Promise<RunHistoryFile> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || (parsed as RunHistoryFile).version !== 1 || !Array.isArray((parsed as RunHistoryFile).runs)) {
        throw new Error("Unsupported run history file format");
      }
      return structuredClone(parsed as RunHistoryFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, runs: [] };
      throw new Error("Failed to read run history", { cause: error });
    }
  }

  private async mutate(update: (data: RunHistoryFile) => void): Promise<void> {
    await this.enqueue(async () => {
      const data = await this.read();
      update(data);
      await this.write(data);
    });
  }

  private async write(data: RunHistoryFile): Promise<void> {
    const directory = path.dirname(this.filePath);
    const temporaryPath = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(operation, operation);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }
}

declare global {
  var webpageVisionRunHistory: RunHistoryRepository | undefined;
}

export const runHistoryRepository = globalThis.webpageVisionRunHistory ?? new RunHistoryRepository();
if (process.env.NODE_ENV !== "production") globalThis.webpageVisionRunHistory = runHistoryRepository;