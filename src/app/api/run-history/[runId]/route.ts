import { NextResponse } from "next/server";
import { runHistoryRepository } from "@/lib/run-history";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ runId: string }>;
}

export async function GET(_request: Request, { params }: RouteContext) {
  const { runId } = await params;
  const run = await runHistoryRepository.get(runId).catch(() => null);
  if (!run) return NextResponse.json({ code: "RUN_HISTORY_NOT_FOUND" }, { status: 404 });
  return NextResponse.json({ run });
}

export async function DELETE(_request: Request, { params }: RouteContext) {
  const { runId } = await params;
  try {
    const deleted = await runHistoryRepository.delete(runId);
    if (!deleted) return NextResponse.json({ code: "RUN_HISTORY_NOT_FOUND" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { code: "RUN_HISTORY_DELETE_FAILED", message: error instanceof Error ? error.message : "履歴を削除できませんでした。" },
      { status: 500 },
    );
  }
}