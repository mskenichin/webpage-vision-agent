import { beforeEach, describe, expect, it } from "vitest";
import { runModelOperation } from "./model-operation";
import { store } from "./store";

describe("runModelOperation", () => {
  beforeEach(() => store.clearConversation());

  it("records a successful primary attempt", async () => {
    await expect(runModelOperation({
      operation: "Verifier",
      primary: { model: "primary-model", timeoutMs: 100 },
      fallback: { model: "fallback-model", timeoutMs: 100 },
      request: async (model) => model,
    })).resolves.toBe("primary-model");

    expect(store.snapshot().processLogs.map((log) => log.detail)).toEqual([
      "attempt=primary model=primary-model timeoutMs=100",
      expect.stringMatching(/^attempt=primary model=primary-model durationMs=\d+$/),
    ]);
  });

  it("records the primary failure before using the fallback", async () => {
    await expect(runModelOperation({
      operation: "Goal Planner",
      primary: { model: "primary-model", timeoutMs: 100 },
      fallback: { model: "fallback-model", timeoutMs: 100 },
      request: async (model) => {
        if (model === "primary-model") throw new Error("MODEL_UNAVAILABLE:503");
        return model;
      },
    })).resolves.toBe("fallback-model");

    expect(store.snapshot().processLogs.some((log) =>
      log.level === "error" && log.detail?.includes("attempt=primary model=primary-model") && log.detail.includes("error=MODEL_UNAVAILABLE:503")
    )).toBe(true);
  });

  it("retries the primary once on timeout before falling back", async () => {
    let primaryAttempts = 0;
    await expect(runModelOperation({
      operation: "Verifier",
      primary: { model: "primary-model", timeoutMs: 50 },
      fallback: { model: "fallback-model", timeoutMs: 100 },
      request: async (model, signal) => {
        if (model === "primary-model") {
          primaryAttempts += 1;
          if (primaryAttempts === 1) {
            return new Promise<string>((_, reject) => signal.addEventListener("abort", () => reject(new Error("OPERATION_TIMEOUT"))));
          }
        }
        return model;
      },
    })).resolves.toBe("primary-model");

    expect(primaryAttempts).toBe(2);
    expect(store.snapshot().processLogs.some((log) => log.detail?.includes("attempt=primary-retry"))).toBe(true);
  });

  it("reports the operation and both failures when all attempts time out", async () => {
    await expect(runModelOperation({
      operation: "Next-Step Planner",
      primary: { model: "primary-model", timeoutMs: 5 },
      fallback: { model: "fallback-model", timeoutMs: 5 },
      request: () => new Promise(() => {}),
    })).rejects.toThrow("MODEL_OPERATION_FAILED:Next-Step Planner:primary=OPERATION_TIMEOUT:fallback=OPERATION_TIMEOUT");

    const failures = store.snapshot().processLogs.filter((log) => log.level === "error");
    expect(failures).toHaveLength(3);
    expect(failures.at(-1)?.detail).toMatch(/attempt=fallback model=fallback-model timeoutMs=5 durationMs=\d+ error=OPERATION_TIMEOUT/);
    expect(failures.some((log) => log.detail?.includes("attempt=primary-retry"))).toBe(true);
  });
});