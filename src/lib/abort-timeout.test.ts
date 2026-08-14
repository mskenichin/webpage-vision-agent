import { describe, expect, it } from "vitest";
import { runWithTimeout } from "./abort-timeout";

describe("runWithTimeout", () => {
  it("rejects at the deadline even when the task ignores abort", async () => {
    await expect(runWithTimeout(5, () => new Promise(() => {}))).rejects.toThrow("OPERATION_TIMEOUT");
  });

  it("returns a result completed before the deadline", async () => {
    await expect(runWithTimeout(100, async () => "done")).resolves.toBe("done");
  });
});
