import { NextResponse } from "next/server";
import { browserManager } from "@/lib/browser";
import { createRealtimeSession } from "@/lib/realtime";
import { store } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const state = store.snapshot();
  try {
    const pageContext = await browserManager.pageContext();
    return NextResponse.json(await createRealtimeSession(state.profile, pageContext.url, state.interests, pageContext), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("Realtime session creation failed", error);
    return NextResponse.json({ code: "VOICE_UNAVAILABLE", message: "音声セッションを開始できませんでした。" }, { status: 502 });
  }
}