import { NextResponse } from "next/server";
import { z } from "zod";
import { synthesizeSpeech } from "@/lib/speech";

export const runtime = "nodejs";
export const maxDuration = 120;

const speechSchema = z.object({ text: z.string().trim().min(1).max(4000) });

export async function POST(request: Request) {
  const parsed = speechSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ code: "INVALID_SPEECH_TEXT", message: "読み上げる文章を確認してください。" }, { status: 400 });
  }

  try {
    const speech = await synthesizeSpeech(parsed.data.text);
    return new Response(speech.body, {
      headers: {
        "Content-Type": speech.headers.get("Content-Type") ?? "audio/mpeg",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("Speech synthesis failed", error);
    return NextResponse.json({ code: "SPEECH_UNAVAILABLE", message: "音声を生成できませんでした。" }, { status: 502 });
  }
}