import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { Actor, BrowserAction } from "./domain";
import { store } from "./store";

const START_URL = "https://lexus.jp/";
const VIEWPORT = { width: 1440, height: 900 };

function isAllowedUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "lexus.jp" || url.hostname.endsWith(".lexus.jp"));
  } catch {
    return false;
  }
}

class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private startPromise: Promise<void> | null = null;
  private activeActor: Actor = "user";
  private activeOperationId = crypto.randomUUID();

  async start() {
    if (this.page && !this.page.isClosed()) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.launch().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async launch() {
    store.setBrowser("starting");
    try {
      this.browser = await chromium.launch({ headless: true });
      this.context = await this.browser.newContext({
        viewport: VIEWPORT,
        locale: "ja-JP",
        colorScheme: "light",
        acceptDownloads: false,
      });
      this.page = await this.context.newPage();
      this.page.on("framenavigated", (frame) => {
        if (frame !== this.page?.mainFrame()) return;
        const url = frame.url();
        if (!isAllowedUrl(url)) return;
        void this.recordPageView(url, this.activeActor, `${this.activeOperationId}:view`);
      });
      await this.page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
      store.setBrowser("ready", this.page.url());
    } catch (error) {
      store.setBrowser("failed");
      await this.close();
      throw error;
    }
  }

  async close() {
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.page = null;
    this.context = null;
    this.browser = null;
  }

  async screenshot() {
    await this.start();
    if (!this.page) throw new Error("Browser session is not available");
    return this.page.screenshot({ type: "jpeg", quality: 72, animations: "disabled" });
  }

  async execute(action: BrowserAction, operationId = crypto.randomUUID()) {
    await this.start();
    if (!this.page) throw new Error("Browser session is not available");

    this.activeActor = action.actor;
    this.activeOperationId = operationId;
    store.setBrowser(action.actor === "agent" ? "agent_running" : "user_controlled");

    try {
      switch (action.type) {
        case "click":
          await this.click(action.x ?? 0, action.y ?? 0, action.actor, operationId);
          break;
        case "scroll":
          await this.page.mouse.wheel(0, action.deltaY ?? 600);
          break;
        case "type":
          await this.page.keyboard.insertText(action.text ?? "");
          break;
        case "key":
          await this.page.keyboard.press(action.key ?? "Enter");
          break;
        case "back":
          await this.page.goBack({ waitUntil: "domcontentloaded", timeout: 30_000 });
          break;
        case "reload":
          await this.page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
          break;
        case "navigate":
          if (!action.url || !isAllowedUrl(action.url)) throw new Error("DOMAIN_NOT_ALLOWED");
          await this.page.goto(action.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
          break;
      }
      store.setBrowser("ready", this.page.url());
    } catch (error) {
      store.setBrowser("ready", this.page.url());
      throw error;
    }
  }

  private async click(x: number, y: number, actor: Actor, operationId: string) {
    if (!this.page) return;
    const link = await this.page.evaluate(({ clickX, clickY }) => {
      const element = document.elementFromPoint(clickX, clickY);
      const anchor = element?.closest("a");
      if (!(anchor instanceof HTMLAnchorElement)) return null;
      return {
        title: (anchor.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 160),
        url: anchor.href,
      };
    }, { clickX: x, clickY: y });

    if (link && !isAllowedUrl(link.url)) throw new Error("DOMAIN_NOT_ALLOWED");
    const sourceUrl = this.page.url();
    await this.page.mouse.click(x, y);

    if (link) {
      store.addActivity({
        sessionId: store.snapshot().sessionId,
        operationId,
        type: "link_clicked",
        actor,
        title: link.title || "リンク",
        url: link.url,
        sourceUrl,
      });
    }
  }

  private async recordPageView(url: string, actor: Actor, operationId: string) {
    const title = await this.page?.title().catch(() => "Lexus") ?? "Lexus";
    store.setBrowser("ready", url);
    store.addActivity({
      sessionId: store.snapshot().sessionId,
      operationId,
      type: "page_viewed",
      actor,
      title,
      url,
    });
  }
}

declare global {
  var webpageVisionBrowser: BrowserManager | undefined;
}

export const browserManager = globalThis.webpageVisionBrowser ?? new BrowserManager();
if (process.env.NODE_ENV !== "production") globalThis.webpageVisionBrowser = browserManager;

export { START_URL, VIEWPORT };