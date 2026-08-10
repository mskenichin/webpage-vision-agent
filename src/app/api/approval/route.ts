import { NextResponse } from "next/server";
import { z } from "zod";
import { approveComputerUse, rejectComputerUse } from "@/lib/computer-use";
import { store } from "@/lib/store";

export const runtime = "nodejs";
export const maxDuration = 120;

const approvalSchema = z.object({
  id: z.string().uuid(),
  decision: z.enum(["approve", "reject"]),
});

export async function POST(request: Request) {
  const parsed = approvalSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ code: "INVALID_APPROVAL" }, { status: 400 });
  try {
    const result = parsed.data.decision === "approve"
      ? await approveComputerUse(parsed.data.id)
      : rejectComputerUse(parsed.data.id);
    return NextResponse.json({ result, state: store.snapshot() });
  } catch (error) {
    const code = error instanceof Error && error.message === "APPROVAL_EXPIRED" ? "APPROVAL_EXPIRED" : "AGENT_FAILED";
    return NextResponse.json({ code, message: code === "APPROVAL_EXPIRED" ? "承認要求の有効期限が切れました。" : "操作を再開できませんでした。" }, { status: code === "APPROVAL_EXPIRED" ? 409 : 502 });
  }
}