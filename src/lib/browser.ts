import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "playwright";
import type { Actor, BrowserAction, PageContext } from "./domain";
import { normalizePageText } from "./page-context";
import { store } from "./store";

const START_URL = "https://lexus.jp/";
const VIEWPORT = { width: 1440, height: 900 };

export interface BrowserStreamFrame {
  data: string;
  width: number;
  height: number;
  sequence: number;
  revision: number;
}

export function isAllowedUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "lexus.jp" || url.hostname.endsWith(".lexus.jp"));
  } catch {
    return false;
  }
}

export function requiresRiskInspection(action: BrowserAction) {
  return action.type === "click" || action.type === "double_click" || action.type === "type" || (action.type === "key" && action.key === "Enter");
}

export function revealQueryText(query: string) {
  const aliases: Array<[RegExp, string]> = [
    [/セダン(?:タイプ)?/i, "sedan"],
    [/ミニバン/i, "minivan"],
    [/クーペ/i, "coupe"],
    [/電気自動車/i, "BEV"],
  ];
  return aliases.reduce(
    (expanded, [pattern, alias]) => pattern.test(query) ? `${expanded} ${alias}` : expanded,
    query,
  );
}

class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private startPromise: Promise<void> | null = null;
  private operationTail: Promise<void> = Promise.resolve();
  private frameRevision = 0;
  private streamSequence = 0;
  private cdpSession: CDPSession | null = null;
  private streamSubscribers = new Set<(frame: BrowserStreamFrame) => void>();
  private activeActor: Actor = "user";
  private activeOperationId = crypto.randomUUID();

  private async serialize<T>(operation: () => Promise<T>) {
    const previous = this.operationTail;
    let release: () => void = () => undefined;
    this.operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

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
      if (this.streamSubscribers.size > 0) await this.startScreencast();
      this.frameRevision += 1;
      store.setBrowser("ready", this.page.url());
    } catch (error) {
      store.setBrowser("failed");
      await this.close();
      throw error;
    }
  }

  async close() {
    await this.stopScreencast();
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.page = null;
    this.context = null;
    this.browser = null;
  }

  async captureFrame() {
    return this.serialize(async () => {
      await this.start();
      if (!this.page) throw new Error("Browser session is not available");
      let image: Buffer;
      try {
        image = await this.page.screenshot({ type: "jpeg", quality: 72, animations: "disabled" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/Target (?:page, context or browser has been closed|crashed)/i.test(message)) throw error;
        await this.close();
        await this.start();
        if (!this.page) throw new Error("Browser session is not available");
        image = await this.page.screenshot({ type: "jpeg", quality: 72, animations: "disabled" });
      }
      return { image, revision: this.frameRevision };
    });
  }

  async screenshot() {
    return (await this.captureFrame()).image;
  }

  async computerScreenshot() {
    return this.serialize(async () => {
      await this.start();
      if (!this.page) throw new Error("Browser session is not available");
      await this.page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => undefined);
      await this.page.waitForTimeout(500);
      await this.page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      }).catch(() => undefined);
      return this.page.screenshot({ type: "jpeg", quality: 72, animations: "disabled" });
    });
  }

  async subscribeFrames(subscriber: (frame: BrowserStreamFrame) => void) {
    this.ensureStreamState();
    this.streamSubscribers.add(subscriber);
    await this.start();
    await this.startScreencast();
    return () => {
      this.streamSubscribers.delete(subscriber);
      if (this.streamSubscribers.size === 0) void this.stopScreencast();
    };
  }

  private async startScreencast() {
    this.ensureStreamState();
    if (this.cdpSession || !this.context || !this.page || this.page.isClosed()) return;
    const session = await this.context.newCDPSession(this.page);
    this.cdpSession = session;
    session.on("Page.screencastFrame", (event: {
      data: string;
      sessionId: number;
      metadata?: { deviceWidth?: number; deviceHeight?: number };
    }) => {
      void session.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => undefined);
      const frame: BrowserStreamFrame = {
        data: event.data,
        width: event.metadata?.deviceWidth ?? VIEWPORT.width,
        height: event.metadata?.deviceHeight ?? VIEWPORT.height,
        sequence: ++this.streamSequence,
        revision: this.frameRevision,
      };
      this.streamSubscribers.forEach((subscriber) => subscriber(frame));
    });
    session.on("close", () => {
      if (this.cdpSession === session) this.cdpSession = null;
    });
    await session.send("Page.startScreencast", {
      format: "jpeg",
      quality: 72,
      maxWidth: VIEWPORT.width,
      maxHeight: VIEWPORT.height,
      everyNthFrame: 1,
    });
  }

  private async stopScreencast() {
    this.ensureStreamState();
    const session = this.cdpSession;
    this.cdpSession = null;
    if (!session) return;
    await session.send("Page.stopScreencast").catch(() => undefined);
    await session.detach().catch(() => undefined);
  }

  private ensureStreamState() {
    this.streamSequence ??= 0;
    this.cdpSession ??= null;
    this.streamSubscribers ??= new Set();
  }

  async pageContext(query?: string, visibleOnly = false): Promise<PageContext> {
    return this.serialize(async () => {
      await this.start();
      if (!this.page) throw new Error("Browser session is not available");
      const page = this.page;
      const text = await page.evaluate((viewportOnly) => {
        const root = document.querySelector("main") ?? document.body;
        if (viewportOnly) {
          const selectors = "h1, h2, h3, h4, h5, h6, p, li, dt, dd, figcaption, summary, a, button, [role=heading], [role=tab]";
          const visibleText = [...root.querySelectorAll<HTMLElement>(selectors)]
            .filter((element) => {
              const rect = element.getBoundingClientRect();
              const style = getComputedStyle(element);
              return element.offsetParent !== null
                && style.visibility !== "hidden"
                && Number(style.opacity) > 0
                && rect.width > 0
                && rect.height > 0
                && rect.bottom > 0
                && rect.top < innerHeight
                && rect.right > 0
                && rect.left < innerWidth;
            })
            .map((element) => (element.innerText || element.getAttribute("aria-label") || "").trim())
            .filter(Boolean);
          return [...new Set(visibleText)].join("\n");
        }
        return root?.innerText ?? "";
      }, visibleOnly);
      return {
        url: page.url(),
        title: await page.title().catch(() => "Lexus"),
        text: normalizePageText(text, query),
        scope: visibleOnly ? "viewport" : "page",
      };
    });
  }

  async revealRelevantContent(query: string) {
    return this.serialize(async () => {
      await this.start();
      if (!this.page) throw new Error("Browser session is not available");
      const result = await this.page.evaluate(async (rawQuery) => {
        const queryText = rawQuery
          .replace(/について|を教えて|教えて|を知りたい|知りたい|を見せて|見せて|を表示して|表示して|ください/g, "")
          .toLocaleLowerCase("ja-JP")
          .replace(/[\s\p{P}\p{S}]/gu, "");
        const pairs = (text: string) => {
          const compact = text.toLocaleLowerCase("ja-JP").replace(/[\s\p{P}\p{S}]/gu, "");
          return new Set(Array.from({ length: Math.max(0, compact.length - 1) }, (_, index) => compact.slice(index, index + 2)));
        };
        const queryPairs = pairs(queryText);
        const root = document.querySelector("main") ?? document.body;
        const candidates = [...root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, p, li, a, button, summary, [role=tab]")]
          .map((element) => {
            const text = (element.innerText || element.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ");
            const overlap = [...pairs(text)].filter((pair) => queryPairs.has(pair)).length;
            const headingBonus = /^H[1-4]$/.test(element.tagName) && overlap > 0 ? 2 : 0;
            return { element, text, score: overlap + headingBonus };
          })
          .filter(({ element, text, score }) => score > 0 && text.length >= 2 && text.length <= 500 && element.offsetParent !== null)
          .sort((left, right) => right.score - left.score);
        const match = candidates[0];
        if (!match) return { found: false as const };
        const scrollBehavior = document.documentElement.style.scrollBehavior;
        document.documentElement.style.scrollBehavior = "auto";
        match.element.scrollIntoView({ block: "center", inline: "nearest" });
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        document.documentElement.style.scrollBehavior = scrollBehavior;
        return { found: true as const, label: match.text.slice(0, 160) };
      }, revealQueryText(query));
      if (result.found) this.frameRevision += 1;
      return result;
    });
  }

  async inspectActionRisk(action: BrowserAction) {
    await this.start();
    if (!this.page || action.actor !== "agent") return null;
    if (!requiresRiskInspection(action)) return null;
    return this.page.evaluate(({ type, x, y }) => {
      const sensitive = /送信|確定|完了|購入|契約|申し込|申込|ログイン|アカウント作成|同意|アップロード|ダウンロード/i;
      const personal = /氏名|名前|住所|メール|電話|郵便|生年月日|認証コード/i;
      const target = type === "click" ? document.elementFromPoint(x ?? 0, y ?? 0) : document.activeElement;
      if (!(target instanceof Element)) return null;
      const control = target.closest("button, a, input, select, textarea, [role=button]") ?? target;
      const form = control.closest("form");
      const label = [
        control.textContent,
        control.getAttribute("aria-label"),
        control.getAttribute("title"),
        control.getAttribute("name"),
        control.getAttribute("placeholder"),
        form?.textContent,
      ].filter(Boolean).join(" ").replace(/\s+/g, " ").slice(0, 500);
      const inputType = control instanceof HTMLInputElement ? control.type : "";
      if (personal.test(label) || ["email", "tel", "password", "file"].includes(inputType)) {
        return "個人情報またはファイルを入力・送信する可能性があります。";
      }
      if (sensitive.test(label) || inputType === "submit") {
        return "問い合わせ、予約、ログイン、同意、購入など外部へ影響する操作の可能性があります。";
      }
      return null;
    }, { type: action.type, x: action.x, y: action.y });
  }

  async execute(action: BrowserAction, operationId = crypto.randomUUID(), expectedFrameRevision?: number) {
    return this.serialize(async () => {
      await this.start();
      if (!this.page) throw new Error("Browser session is not available");
      if (expectedFrameRevision !== undefined && expectedFrameRevision !== this.frameRevision) {
        throw new Error("BROWSER_FRAME_STALE");
      }

      this.activeActor = action.actor;
      this.activeOperationId = operationId;
      store.setBrowser(action.actor === "agent" ? "agent_running" : "user_controlled");

      try {
        switch (action.type) {
          case "click":
            await this.click(action.x ?? 0, action.y ?? 0, action.actor, operationId);
            break;
          case "double_click":
            await this.page.mouse.dblclick(action.x ?? 0, action.y ?? 0);
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
          case "wait":
            await this.page.waitForTimeout(1_000);
            break;
          case "back":
            await this.page.goBack({ waitUntil: "domcontentloaded", timeout: 30_000 });
            break;
          case "reload":
            await this.page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
            break;
          case "navigate":
            if (!action.url || !isAllowedUrl(action.url)) throw new Error("DOMAIN_NOT_ALLOWED");
            if (!await this.clickMatchingLink(action.url, action.actor, operationId)) {
              await this.page.goto(action.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
            }
            break;
        }
        this.frameRevision += 1;
        store.setBrowser("ready", this.page.url());
      } catch (error) {
        store.setBrowser("ready", this.page.url());
        throw error;
      }
    });
  }

  private async click(x: number, y: number, actor: Actor, operationId: string) {
    if (!this.page) return;
    const target = await this.page.evaluate(({ clickX, clickY }) => {
      const element = document.elementFromPoint(clickX, clickY);
      const anchor = element?.closest("a");
      return {
        tag: element?.tagName.toLocaleLowerCase() ?? "unknown",
        label: (element?.getAttribute("aria-label") || element?.getAttribute("title") || "").trim().slice(0, 120),
        link: anchor instanceof HTMLAnchorElement ? {
          title: (anchor.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 160),
          url: anchor.href,
        } : null,
      };
    }, { clickX: x, clickY: y });

    const link = target.link;
    if (link && !isAllowedUrl(link.url)) throw new Error("DOMAIN_NOT_ALLOWED");
    store.addProcessLog("browser", "info", "ブラウザ上の要素をクリックしました", target.label ? `${target.tag}: ${target.label}` : target.tag);
    const sourceUrl = this.page.url();
    await this.page.mouse.click(x, y);
    await this.page.waitForTimeout(150);

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

  private async clickMatchingLink(targetUrl: string, actor: Actor, operationId: string) {
    if (!this.page) return false;
    const point = await this.page.evaluate((target) => {
      const normalized = (value: string) => {
        const url = new URL(value, location.href);
        url.hash = "";
        return url.href.replace(/\/$/, "");
      };
      const expected = normalized(target);
      const anchor = [...document.querySelectorAll<HTMLAnchorElement>("a[href]")].find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return candidate.offsetParent !== null && rect.width > 0 && rect.height > 0 && normalized(candidate.href) === expected;
      });
      if (!anchor) return null;
      anchor.scrollIntoView({ block: "center", inline: "nearest" });
      const rect = anchor.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }, targetUrl);
    if (!point) return false;
    await this.click(point.x, point.y, actor, operationId);
    await this.page.waitForURL((url) => url.href.replace(/\/$/, "") === targetUrl.replace(/\/$/, ""), { timeout: 5_000 }).catch(() => undefined);
    return this.page.url().replace(/\/$/, "") === targetUrl.replace(/\/$/, "");
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

const existingBrowserManager = globalThis.webpageVisionBrowser;
if (existingBrowserManager) Object.setPrototypeOf(existingBrowserManager, BrowserManager.prototype);
export const browserManager = existingBrowserManager ?? new BrowserManager();
if (process.env.NODE_ENV !== "production") globalThis.webpageVisionBrowser = browserManager;

export { START_URL, VIEWPORT };