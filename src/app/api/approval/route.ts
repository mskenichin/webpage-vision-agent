import { NextResponse } from "next/server";
import { z } from "zod";
import { approveComputerUse, rejectComputerUse } from "@/lib/computer-use";
import { runHistoryRecorder } from "@/lib/run-history-recorder";
import { store } from "@/lib/store";
import { cancelTaskMode, resumeTaskModeAfterApproval } from "@/lib/task-mode";

export const runtime = "nodejs";
export const maxDuration = 120;

const approvalSchema = z.object({
  id: z.string().uuid(),
  decision: z.enum(["approve", "reject"]),
});

function resultFlag(result: unknown, key: "awaitingApproval" | "continuationRequired") {
  return typeof result === "object" && result !== null && key in result
    && (result as Record<string, unknown>)[key] === true;
}

function resultMessage(result: unknown) {
  if (typeof result !== "object" || result === null || !("message" in result)) return "";
  const message = (result as Record<string, unknown>).message;
  return typeof message === "string" ? message : "";
}

export async function POST(request: Request) {
  const parsed = approvalSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ code: "INVALID_APPROVAL" }, { status: 400 });
  try {
    const result = parsed.data.decision === "approve"
      ? await resumeTaskModeAfterApproval(await approveComputerUse(parsed.data.id))
      : rejectComputerUse(parsed.data.id);
    if (parsed.data.decision === "reject") cancelTaskMode();
    const awaitingApproval = resultFlag(result, "awaitingApproval");
    const taskContinuation = resultFlag(result, "continuationRequired");
    const message = resultMessage(result);
    if (parsed.data.decision === "reject") {
      await runHistoryRecorder.finishActive("stopped", "APPROVAL_REJECTED");
    } else if (!awaitingApproval && !taskContinuation) {
      await runHistoryRecorder.finishActive("completed");
    }
    if (parsed.data.decision === "approve" && !awaitingApproval && !taskContinuation && message) {
      store.addMessage("assistant", message);
    }
    return NextResponse.json({ result, state: store.snapshot(), taskContinuation });
  } catch (error) {
    await runHistoryRecorder.finishActive("failed", error instanceof Error ? error.message : "APPROVAL_RESUME_FAILED").catch(() => undefined);
    const code = error instanceof Error && error.message === "APPROVAL_EXPIRED" ? "APPROVAL_EXPIRED" : "AGENT_FAILED";
    return NextResponse.json({ code, message: code === "APPROVAL_EXPIRED" ? "承認要求の有効期限が切れました。" : "操作を再開できませんでした。" }, { status: code === "APPROVAL_EXPIRED" ? 409 : 502 });
  }
}