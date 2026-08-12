import { NextResponse } from "next/server";
import { z } from "zod";
import { browserManager } from "@/lib/browser";
import { stopComputerUse } from "@/lib/computer-use";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const actionSchema = z.object({
  type: z.enum(["click", "double_click", "scroll", "type", "key", "wait", "back", "reload", "navigate"]),
  x: z.number().min(0).max(1440).optional(),
  y: z.number().min(0).max(900).optional(),
  deltaY: z.number().min(-3000).max(3000).optional(),
  text: z.string().max(2000).optional(),
  key: z.string().max(50).optional(),
  url: z.string().url().optional(),
  actor: z.enum(["user", "agent"]).default("user"),
  operationId: z.string().uuid().optional(),
  expectedFrameRevision: z.number().int().positive().optional(),
});

export async function GET() {
  try {
    const frame = await browserManager.captureFrame();
    return new NextResponse(new Uint8Array(frame.image), {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
        "X-Browser-Frame-Revision": String(frame.revision),
        "X-Browser-Frame-Width": "1440",
        "X-Browser-Frame-Height": "900",
      },
    });
  } catch (error) {
    return NextResponse.json(
      { code: "BROWSER_START_FAILED", message: error instanceof Error ? error.message : "画面を取得できませんでした。" },
      { status: 503 },
    );
  }
}

export async function POST(request: Request) {
  const parsed = actionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ code: "INVALID_ACTION", issues: parsed.error.issues }, { status: 400 });
  }

  const { operationId, expectedFrameRevision, ...action } = parsed.data;
  try {
    if (action.actor === "user") stopComputerUse();
    await browserManager.execute(action, operationId, expectedFrameRevision);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "操作できませんでした。";
    const frameStale = message.includes("BROWSER_FRAME_STALE");
    const domainNotAllowed = message.includes("DOMAIN_NOT_ALLOWED");
    return NextResponse.json(
      {
        code: frameStale ? "BROWSER_FRAME_STALE" : domainNotAllowed ? "DOMAIN_NOT_ALLOWED" : "BROWSER_ACTION_FAILED",
        message: frameStale
          ? "画面が更新されました。最新の画面でもう一度操作してください。"
          : domainNotAllowed ? "Lexus公式サイト内のURLを入力してください。" : message,
      },
      { status: 409 },
    );
  }
}