import type {
  AgentRunHistory,
  AgentRunHistoryStatus,
  BrowserAction,
  ElementFingerprint,
  ElementLocator,
  ExecutionMode,
  RecordedBrowserAction,
} from "./domain";
import { RunHistoryRepository, runHistoryRepository } from "./run-history";
import { DemoStore, store } from "./store";

interface ActiveRun {
  id: string;
  disabled: boolean;
  nextSequence: number;
}

export interface RecordActionInput {
  action: BrowserAction;
  beforeUrl: string;
  afterUrl: string;
  beforeFrameRevision: number;
  afterFrameRevision: number;
  target?: ElementFingerprint;
  locator?: ElementLocator;
  startedAt: string;
  completedAt: string;
}

export class RunHistoryRecorder {
  private active: ActiveRun | null = null;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly repository: RunHistoryRepository = runHistoryRepository,
    private readonly appStore: DemoStore = store,
  ) {}

  async begin(prompt: string, executionMode: ExecutionMode, fallbackFromRunId?: string) {
    return this.serialize(async () => {
      if (!this.appStore.snapshot().profile.runHistoryCollection) {
        await this.discardActiveUnsafe();
        return null;
      }
      await this.discardActiveUnsafe();

      const run: AgentRunHistory = {
        id: crypto.randomUUID(),
        prompt,
        executionMode,
        startedAt: new Date().toISOString(),
        startUrl: this.appStore.snapshot().currentUrl,
        status: "running",
        containsTextInput: false,
        replayable: true,
        schemaVersion: 2,
        ...(fallbackFromRunId ? { fallbackFromRunId } : {}),
        actions: [],
      };
      await this.repository.create(run);
      this.active = { id: run.id, disabled: false, nextSequence: 1 };
      return run.id;
    });
  }

  async finish(id: string, status: Exclude<AgentRunHistoryStatus, "running">, reason?: string) {
    await this.serialize(async () => {
      const active = this.active;
      if (!active || active.id !== id || active.disabled) return;
      this.active = null;
      await this.repository.update(active.id, (run) => {
        run.status = status;
        run.completedAt = new Date().toISOString();
        run.endUrl = this.appStore.snapshot().currentUrl;
        if (reason) run.reason = reason;
      });
    });
  }

  async recordAction(input: RecordActionInput) {
    await this.serialize(async () => {
      const active = this.active;
      if (!active || active.disabled || input.action.actor !== "agent") return;
      if (!this.appStore.snapshot().profile.runHistoryCollection) {
        await this.discardActiveUnsafe();
        return;
      }
      if (input.action.type === "type") {
        if ((input.action.text?.trim() ?? "").length === 0) return;
        this.appStore.addProcessLog(
          "browser",
          "info",
          "文字入力を記録しました（値は保存しません）",
          input.target?.label ? `入力欄: ${input.target.label}` : "入力欄: 不明",
        );
        await this.repository.update(active.id, (run) => {
          run.containsTextInput = true;
          run.replayable = false;
          run.reason = "文字入力操作を含むためリプレイできません。";
        });
        return;
      }

      const action: RecordedBrowserAction = {
        id: crypto.randomUUID(),
        sequence: active.nextSequence,
        type: input.action.type,
        ...(input.action.x !== undefined ? { x: input.action.x } : {}),
        ...(input.action.y !== undefined ? { y: input.action.y } : {}),
        ...(input.action.deltaY !== undefined ? { deltaY: input.action.deltaY } : {}),
        ...(input.action.key !== undefined ? { key: input.action.key } : {}),
        ...(input.action.url !== undefined ? { url: input.action.url } : {}),
        beforeUrl: input.beforeUrl,
        afterUrl: input.afterUrl,
        beforeFrameRevision: input.beforeFrameRevision,
        afterFrameRevision: input.afterFrameRevision,
        ...(input.target ? { target: input.target } : {}),
        ...(input.locator ? { locator: input.locator } : {}),
        startedAt: input.startedAt,
        completedAt: input.completedAt,
      };
      await this.repository.appendAction(active.id, action);
      active.nextSequence += 1;
    });
  }

  async disableCollection() {
    await this.serialize(() => this.discardActiveUnsafe());
  }

  async discardFailedRun() {
    await this.serialize(() => this.discardActiveUnsafe());
  }

  isRecording() {
    return Boolean(this.active && !this.active.disabled);
  }

  currentRunId() {
    return this.active && !this.active.disabled ? this.active.id : null;
  }

  async finishActive(status: Exclude<AgentRunHistoryStatus, "running">, reason?: string) {
    const id = this.currentRunId();
    if (id) await this.finish(id, status, reason);
  }

  private async discardActiveUnsafe() {
    const active = this.active;
    if (!active) return;
    active.disabled = true;
    this.active = null;
    await this.repository.delete(active.id);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operationQueue.then(operation, operation);
    this.operationQueue = next.then(() => undefined, () => undefined);
    return next;
  }
}

declare global {
  var webpageVisionRunHistoryRecorder: RunHistoryRecorder | undefined;
}

export const runHistoryRecorder = globalThis.webpageVisionRunHistoryRecorder ?? new RunHistoryRecorder();
if (process.env.NODE_ENV !== "production") globalThis.webpageVisionRunHistoryRecorder = runHistoryRecorder;