import { browserManager, type BrowserStreamFrame } from "@/lib/browser";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();

export async function GET(request: Request) {
  let unsubscribe: (() => void) | null = null;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const close = () => {
        unsubscribe?.();
        unsubscribe = null;
        try {
          controller.close();
        } catch {}
      };
      request.signal.addEventListener("abort", close, { once: true });
      try {
        unsubscribe = await browserManager.subscribeFrames((frame: BrowserStreamFrame) => {
          if (controller.desiredSize !== null && controller.desiredSize <= 0) return;
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
          } catch {
            close();
          }
        });
        if (request.signal.aborted) close();
      } catch (error) {
        controller.error(error);
      }
    },
    cancel() {
      unsubscribe?.();
      unsubscribe = null;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    },
  });
}