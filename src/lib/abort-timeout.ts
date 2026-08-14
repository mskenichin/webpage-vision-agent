export async function runWithTimeout<T>(milliseconds: number, task: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController();
  const timeoutReason = new Error("OPERATION_TIMEOUT");
  let removeAbortListener = () => {};
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => reject(controller.signal.reason instanceof Error ? controller.signal.reason : timeoutReason);
    controller.signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => controller.signal.removeEventListener("abort", onAbort);
  });
  const timer = setTimeout(() => controller.abort(timeoutReason), milliseconds);
  try {
    return await Promise.race([task(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
    removeAbortListener();
  }
}
