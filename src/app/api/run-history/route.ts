import { NextResponse } from "next/server";
import { runHistoryRepository } from "@/lib/run-history";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await runHistoryRepository.prune();
    return NextResponse.json({ runs: await runHistoryRepository.list() });
  } catch (error) {
    return NextResponse.json(
      { code: "RUN_HISTORY_READ_FAILED", message: error instanceof Error ? error.message : "履歴を取得できませんでした。" },
      { status: 500 },
    );
  }
}

export async function DELETE() {
  try {
    await runHistoryRepository.clear();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { code: "RUN_HISTORY_DELETE_FAILED", message: error instanceof Error ? error.message : "履歴を削除できませんでした。" },
      { status: 500 },
    );
  }
}