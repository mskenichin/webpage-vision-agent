import { describe, expect, it } from "vitest";
import { agentErrorResponse } from "./agent-error";

describe("agentErrorResponse", () => {
  it("classifies wrapped model operation timeouts as gateway timeouts", () => {
    expect(agentErrorResponse(new Error("MODEL_OPERATION_FAILED:Verifier:primary=OPERATION_TIMEOUT:fallback=OPERATION_TIMEOUT"))).toEqual({
      code: "MODEL_OPERATION_TIMEOUT",
      message: "モデル応答が制限時間を超えました。処理ログを確認してから再試行してください。",
      status: 504,
    });
  });

  it("does not expose model error details to the client", () => {
    expect(agentErrorResponse(new Error("MODEL_UNAVAILABLE:503:private upstream detail"))).toEqual({
      code: "MODEL_UNAVAILABLE",
      message: "モデルを利用できませんでした。しばらく待ってから再試行してください。",
      status: 502,
    });
  });
});