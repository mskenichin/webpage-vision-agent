interface AgentErrorResponse {
  code: string;
  message: string;
  status: number;
}

export function agentErrorResponse(error: unknown): AgentErrorResponse {
  const detail = error instanceof Error ? error.message : String(error);
  if (detail.includes("OPERATION_TIMEOUT")) {
    return {
      code: "MODEL_OPERATION_TIMEOUT",
      message: "モデル応答が制限時間を超えました。処理ログを確認してから再試行してください。",
      status: 504,
    };
  }
  if (detail.includes("MODEL_UNAVAILABLE")) {
    return {
      code: "MODEL_UNAVAILABLE",
      message: "モデルを利用できませんでした。しばらく待ってから再試行してください。",
      status: 502,
    };
  }
  return { code: "AGENT_FAILED", message: "操作を完了できませんでした。", status: 502 };
}