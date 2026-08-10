import { NextResponse } from "next/server";
import { z } from "zod";
import { browserManager } from "@/lib/browser";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const actionSchema = z.object({
  type: z.enum(["click", "scroll", "type", "key", "back", "reload", "navigate"]),
  x: z.number().min(0).max(1440).optional(),
  y: z.number().min(0).max(900).optional(),
  deltaY: z.number().min(-3000).max(3000).optional(),
  text: z.string().max(2000).optional(),
  key: z.string().max(50).optional(),
  url: z.string().url().optional(),
  actor: z.enum(["user", "agent"]).default("user"),
  operationId: z.string().uuid().optional(),
});

export async function GET() {
  try {
    const image = await browserManager.screenshot();
    return new NextResponse(new Uint8Array(image), {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
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

  const { operationId, ...action } = parsed.data;
  try {
    await browserManager.execute(action, operationId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "操作できませんでした。";
    return NextResponse.json(
      { code: message.includes("DOMAIN_NOT_ALLOWED") ? "DOMAIN_NOT_ALLOWED" : "BROWSER_ACTION_FAILED", message },
      { status: 409 },
    );
  }
}