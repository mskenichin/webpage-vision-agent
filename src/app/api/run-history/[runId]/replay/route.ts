import { NextResponse } from "next/server";
import { replayRun, stopReplay } from "@/lib/replay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

interface RouteContext {
  params: Promise<{ runId: string }>;
}

function replayError(error: unknown) {
  const message = error instanceof Error ? error.message : "REPLAY_FAILED";
  const status = message === "RUN_HISTORY_NOT_FOUND" ? 404 : message === "REPLAY_ALREADY_RUNNING" ? 409 : 400;
  return NextResponse.json({ code: message, message: "履歴をリプレイできませんでした。" }, { status });
}

export async function POST(_request: Request, { params }: RouteContext) {
  const { runId } = await params;
  try {
    return NextResponse.json(await replayRun(runId));
  } catch (error) {
    return replayError(error);
  }
}

export async function DELETE() {
  stopReplay();
  return NextResponse.json({ ok: true });
}