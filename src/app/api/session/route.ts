import { NextResponse } from "next/server";
import { browserManager } from "@/lib/browser";
import { store } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(store.snapshot());
}

export async function POST() {
  try {
    await browserManager.start();
    return NextResponse.json(store.snapshot());
  } catch (error) {
    return NextResponse.json(
      { code: "BROWSER_START_FAILED", message: error instanceof Error ? error.message : "ブラウザを開始できませんでした。" },
      { status: 503 },
    );
  }
}

export async function DELETE() {
  await browserManager.close();
  return new NextResponse(null, { status: 204 });
}