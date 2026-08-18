import { runWithTimeout } from "./abort-timeout";
import { store } from "./store";

interface ModelAttempt {
  model: string;
  timeoutMs: number;
}

interface ModelOperationOptions<T> {
  operation: string;
  primary: ModelAttempt;
  fallback: ModelAttempt;
  request: (model: string, signal: AbortSignal) => Promise<T>;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isTimeout(error: unknown) {
  return error instanceof Error && error.message.includes("OPERATION_TIMEOUT");
}

async function runAttempt<T>(operation: string, attempt: string, config: ModelAttempt, request: ModelOperationOptions<T>["request"]) {
  const startedAt = Date.now();
  store.addProcessLog("agent", "info", `${operation}: モデル呼び出しを開始しました`, `attempt=${attempt} model=${config.model} timeoutMs=${config.timeoutMs}`);
  try {
    const result = await runWithTimeout(config.timeoutMs, (signal) => request(config.model, signal));
    store.addProcessLog("agent", "success", `${operation}: モデル呼び出しが完了しました`, `attempt=${attempt} model=${config.model} durationMs=${Date.now() - startedAt}`);
    return result;
  } catch (error) {
    store.addProcessLog("agent", "error", `${operation}: モデル呼び出しに失敗しました`, `attempt=${attempt} model=${config.model} timeoutMs=${config.timeoutMs} durationMs=${Date.now() - startedAt} error=${errorMessage(error)}`);
    throw error;
  }
}

async function runPrimaryWithRetry<T>(options: ModelOperationOptions<T>) {
  try {
    return await runAttempt(options.operation, "primary", options.primary, options.request);
  } catch (error) {
    if (!isTimeout(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 500));
    return runAttempt(options.operation, "primary-retry", options.primary, options.request);
  }
}

export async function runModelOperation<T>(options: ModelOperationOptions<T>) {
  try {
    return await runPrimaryWithRetry(options);
  } catch (primaryError) {
    try {
      return await runAttempt(options.operation, "fallback", options.fallback, options.request);
    } catch (fallbackError) {
      throw new Error(
        `MODEL_OPERATION_FAILED:${options.operation}:primary=${errorMessage(primaryError)}:fallback=${errorMessage(fallbackError)}`,
        { cause: fallbackError },
      );
    }
  }
}