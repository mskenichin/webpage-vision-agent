import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright";
import type { Actor, BrowserAction, ElementFingerprint, ElementLocator, PageContext } from "./domain";
import { normalizePageText } from "./page-context";
import { runHistoryRecorder } from "./run-history-recorder";
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

export interface TaskBrowserObservation {
  image: Buffer;
  pageContext: PageContext;
  revision: number;
  capturedAt: string;
}

export interface BrowserExecutionOptions {
  recordHistory?: boolean;
  recordActivity?: boolean;
}

export function isAllowedUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "lexus.jp" || url.hostname.endsWith(".lexus.jp"));
  } catch {
    return false;
  }
}

export function isWebNavigationUrl(value: string) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

export function requiresRiskInspection(action: BrowserAction) {
  return action.type === "click" || action.type === "double_click" || action.type === "type" || (action.type === "key" && action.key === "Enter");
}

export function actionRisk(label: string, inputType = "") {
  const sensitive = /送信|確定|完了|購入|契約|申し込|申込|ログイン|アカウント作成|同意|アップロード|ダウンロード/i;
  const personal = /氏名|名前|住所|メール|電話|郵便|生年月日|認証コード/i;
  if (personal.test(label) || ["email", "tel", "password", "file"].includes(inputType)) {
    return "個人情報またはファイルを入力・送信する可能性があります。";
  }
  if (sensitive.test(label)) {
    return "問い合わせ、予約、ログイン、同意、購入など外部へ影響する操作の可能性があります。";
  }
  return null;
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

export function remainingStabilizationDelay(lastMutationAt: number, now = Date.now(), stabilizationMs = 250) {
  if (lastMutationAt <= 0) return 0;
  return Math.max(0, stabilizationMs - (now - lastMutationAt));
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
  private lastMutationAt = 0;
  private suppressActivity = false;

  currentRevision() {
    return this.frameRevision;
  }

  async elementFingerprint(x: number, y: number): Promise<ElementFingerprint | undefined> {
    return this.serialize(async () => {
      await this.start();
      if (!this.page) return undefined;
      return this.page.evaluate(({ pointX, pointY }) => {
        const element = document.elementFromPoint(pointX, pointY);
        if (!(element instanceof Element)) return undefined;
        const control = element.closest("button, a, input, select, textarea, [role=button]") ?? element;
        const anchor = control.closest("a");
        const label = [
          control.getAttribute("aria-label"),
          control.getAttribute("title"),
          control.textContent,
        ].filter(Boolean).join(" ").trim().replace(/\s+/g, " ").slice(0, 160);
        return {
          tag: control.tagName.toLocaleLowerCase(),
          ...(label ? { label } : {}),
          ...(anchor instanceof HTMLAnchorElement ? { href: anchor.href } : {}),
        };
      }, { pointX: x, pointY: y });
    });
  }

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
        if (this.suppressActivity) return;
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
        image = await this.page.screenshot({ type: "jpeg", quality: 72, animations: "disabled", timeout: 10_000 });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/Timeout|Target (?:page, context or browser has been closed|crashed)/i.test(message)) throw error;
        store.setBrowser("recovering");
        await this.close();
        await this.start();
        if (!this.page) throw new Error("Browser session is not available");
        image = await this.page.screenshot({ type: "jpeg", quality: 72, animations: "disabled", timeout: 10_000 });
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
      const stabilizationDelay = remainingStabilizationDelay(this.lastMutationAt);
      if (stabilizationDelay > 0) await this.page.waitForTimeout(stabilizationDelay);
      await this.page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      }).catch(() => undefined);
      return this.page.screenshot({ type: "jpeg", quality: 72, animations: "disabled" });
    });
  }

  async taskObservation(query?: string): Promise<TaskBrowserObservation> {
    return this.serialize(async () => {
      await this.start();
      if (!this.page) throw new Error("Browser session is not available");
      const page = this.page;
      await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => undefined);
      const stabilizationDelay = remainingStabilizationDelay(this.lastMutationAt);
      if (stabilizationDelay > 0) await page.waitForTimeout(stabilizationDelay);
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      }).catch(() => undefined);
      const [image, text, title] = await Promise.all([
        page.screenshot({ type: "jpeg", quality: 55, animations: "disabled", timeout: 10_000 }),
        page.evaluate(() => (document.querySelector("main") ?? document.body)?.innerText ?? ""),
        page.title().catch(() => "Lexus"),
      ]);
      return {
        image,
        pageContext: {
          url: page.url(),
          title,
          text: normalizePageText(text, query),
          scope: "page" as const,
        },
        revision: this.frameRevision,
        capturedAt: new Date().toISOString(),
      };
    });
  }

  async settle(timeoutMs = 5_000) {
    return this.serialize(async () => {
      if (!this.page) return;
      await this.page.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => undefined);
      const stabilizationDelay = remainingStabilizationDelay(this.lastMutationAt);
      if (stabilizationDelay > 0) await this.page.waitForTimeout(stabilizationDelay);
      await this.page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      }).catch(() => undefined);
      store.setBrowser("ready", this.page.url());
    });
  }

  async locateByFingerprint(target: ElementFingerprint) {
    return this.serialize(async () => {
      await this.start();
      if (!this.page) return null;
      return this.page.evaluate((fingerprint) => {
        const collapse = (value: string) => value.trim().replace(/\s+/g, " ");
        const normalizeLabel = (value: string) => collapse(value).toLocaleLowerCase();
        const normalizeUrl = (value: string) => {
          try {
            const url = new URL(value, location.href);
            url.hash = "";
            return url.href.replace(/\/$/, "");
          } catch {
            return "";
          }
        };
        const expectedLabel = fingerprint.label ? normalizeLabel(fingerprint.label) : null;
        const expectedUrl = fingerprint.href ? normalizeUrl(fingerprint.href) : null;
        const match = [...document.querySelectorAll(fingerprint.tag)].find((element) => {
          if (!(element instanceof HTMLElement)) return false;
          const rect = element.getBoundingClientRect();
          if (element.offsetParent === null || rect.width === 0 || rect.height === 0) return false;
          if (expectedUrl !== null) {
            const anchor = element.closest("a");
            const href = anchor instanceof HTMLAnchorElement ? anchor.href : "";
            if (!href || normalizeUrl(href) !== expectedUrl) return false;
          }
          if (expectedLabel !== null) {
            const label = [
              element.getAttribute("aria-label"),
              element.getAttribute("title"),
              element.textContent,
            ].filter(Boolean).join(" ").trim().replace(/\s+/g, " ").slice(0, 160);
            if (normalizeLabel(label) !== expectedLabel) return false;
          }
          return true;
        });
        if (!(match instanceof HTMLElement)) return null;
        match.scrollIntoView({ block: "center", inline: "nearest" });
        const rect = match.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return null;
        const hit = document.elementFromPoint(x, y);
        if (!hit || (hit !== match && !match.contains(hit))) return null;
        return { x, y };
      }, target);
    });
  }

  async canAcceptTextInput() {
    await this.start();
    if (!this.page) return false;
    return this.page.evaluate(() => {
      const element = document.activeElement;
      if (!(element instanceof HTMLElement)) return false;
      if (element.isContentEditable) return true;
      const tag = element.tagName.toLowerCase();
      if (tag === "textarea") return true;
      if (element instanceof HTMLInputElement) {
        return !["button", "submit", "reset", "checkbox", "radio", "range", "color", "file", "image", "hidden"].includes(element.type);
      }
      return element.getAttribute("role") === "textbox";
    });
  }

  async clickByLocator(locator: ElementLocator, actionType: "click" | "double_click", timeoutMs = 4_000) {
    return this.serialize(async () => {
      await this.start();
      if (!this.page) return false;
      const page = this.page;
      const candidates: Locator[] = [];
      if (locator.testId) candidates.push(page.locator(`[data-testid=${JSON.stringify(locator.testId)}]`));
      if (locator.elementId) candidates.push(page.locator(`[id=${JSON.stringify(locator.elementId)}]`));
      if (locator.role && locator.name) {
        try {
          candidates.push(page.getByRole(locator.role as Parameters<Page["getByRole"]>[0], { name: locator.name }));
        } catch {
          // invalid role string; skip role strategy
        }
      }
      if (locator.href) {
        candidates.push(page.locator(`a[href=${JSON.stringify(locator.href)}]`));
        try {
          const parsed = new URL(locator.href);
          const relative = `${parsed.pathname}${parsed.search}`;
          if (relative && relative !== locator.href) candidates.push(page.locator(`a[href=${JSON.stringify(relative)}]`));
        } catch {
          // non-absolute href; the exact selector above is sufficient
        }
      }
      if (locator.name) candidates.push(page.getByText(locator.name, { exact: false }));
      for (const base of candidates) {
        try {
          const count = await base.count();
          if (count === 0) continue;
          const target = count > 1 ? base.nth(Math.min(locator.nth ?? 0, count - 1)) : base.first();
          if (actionType === "double_click") await target.dblclick({ timeout: timeoutMs });
          else await target.click({ timeout: timeoutMs });
          this.frameRevision += 1;
          store.setBrowser("ready", page.url());
          return true;
        } catch {
          // try next strategy
        }
      }
      return false;
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
    const target = await this.page.evaluate(({ type, x, y }) => {
      const target = type === "click" ? document.elementFromPoint(x ?? 0, y ?? 0) : document.activeElement;
      if (!(target instanceof Element)) return null;
      const control = target.closest("button, a, input, select, textarea, [role=button]") ?? target;
      const label = [
        control.textContent,
        control.getAttribute("aria-label"),
        control.getAttribute("title"),
        control.getAttribute("name"),
        control.getAttribute("placeholder"),
      ].filter(Boolean).join(" ").replace(/\s+/g, " ").slice(0, 500);
      const inputType = control instanceof HTMLInputElement ? control.type : "";
      return { label, inputType };
    }, { type: action.type, x: action.x, y: action.y });
    return target ? actionRisk(target.label, target.inputType) : null;
  }

  async execute(
    action: BrowserAction,
    operationId = crypto.randomUUID(),
    expectedFrameRevision?: number,
    options: BrowserExecutionOptions = {},
  ) {
    return this.serialize(async () => {
      await this.start();
      if (!this.page) throw new Error("Browser session is not available");
      if (expectedFrameRevision !== undefined && expectedFrameRevision !== this.frameRevision) {
        throw new Error("BROWSER_FRAME_STALE");
      }

      this.activeActor = action.actor;
      this.activeOperationId = operationId;
      store.setBrowser(action.actor === "agent" ? "agent_running" : "user_controlled");
      const beforeUrl = this.page.url();
      const beforeFrameRevision = this.frameRevision;
      const startedAt = new Date().toISOString();
      const previousSuppressActivity = this.suppressActivity;
      this.suppressActivity = options.recordActivity === false;
      let target: ElementFingerprint | undefined;
      let locator: ElementLocator | undefined;
      if (action.actor === "agent" && ["click", "double_click"].includes(action.type)) {
        const captured = await this.page.evaluate(({ x, y }) => {
          const element = document.elementFromPoint(x, y);
          if (!(element instanceof Element)) return undefined;
          const control = element.closest("button, a, input, select, textarea, [role], summary, label") ?? element;
          const anchor = control.closest("a");
          const collapse = (value: string) => value.trim().replace(/\s+/g, " ");
          const label = [
            control.getAttribute("aria-label"),
            control.getAttribute("title"),
            control.textContent,
          ].filter(Boolean).join(" ").trim().replace(/\s+/g, " ").slice(0, 160);
          const tag = control.tagName.toLocaleLowerCase();
          const implicitRole = () => {
            const explicit = control.getAttribute("role");
            if (explicit) return explicit;
            if (anchor instanceof HTMLAnchorElement && anchor === control) return "link";
            if (tag === "a") return "link";
            if (tag === "button" || tag === "summary") return "button";
            if (tag === "select") return "combobox";
            if (tag === "textarea") return "textbox";
            if (control instanceof HTMLInputElement) {
              const type = control.type;
              if (["button", "submit", "reset"].includes(type)) return "button";
              if (type === "checkbox") return "checkbox";
              if (type === "radio") return "radio";
              return "textbox";
            }
            return undefined;
          };
          const associatedLabel = (() => {
            const labelledby = control.getAttribute("aria-labelledby");
            if (labelledby) {
              const text = collapse(labelledby.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" "));
              if (text) return text;
            }
            const wrapping = control.closest("label");
            if (wrapping) {
              const text = collapse(wrapping.textContent ?? "");
              if (text) return text;
            }
            if (control.id) {
              const forLabel = document.querySelector(`label[for="${CSS.escape(control.id)}"]`);
              const text = forLabel ? collapse(forLabel.textContent ?? "") : "";
              if (text) return text;
            }
            const row = control.closest("li, tr, [role=listitem], [role=option], [role=row]");
            if (row) {
              const text = collapse(row.textContent ?? "");
              if (text) return text;
            }
            return "";
          })();
          const accessibleName = (collapse([
            control.getAttribute("aria-label"),
            control.getAttribute("title"),
            control instanceof HTMLInputElement ? control.getAttribute("placeholder") : "",
            control.textContent,
            control.querySelector("img")?.getAttribute("alt"),
          ].filter(Boolean).join(" ")) || associatedLabel).slice(0, 160);
          const testId = control.getAttribute("data-testid") ?? control.getAttribute("data-test-id") ?? control.getAttribute("data-test") ?? undefined;
          const elementId = control.id || undefined;
          const fieldName = control.getAttribute("name") ?? undefined;
          const text = (collapse(control.textContent ?? "") || associatedLabel).slice(0, 120) || undefined;
          const role = implicitRole();
          const inDialog = Boolean(control.closest("[role=dialog], [aria-modal=true], dialog"));
          let nth: number | undefined;
          if (role && accessibleName) {
            const sameName = [...document.querySelectorAll<HTMLElement>("a, button, summary, input, select, textarea, [role]")]
              .filter((candidate) => {
                const candidateRole = candidate.getAttribute("role")
                  ?? (candidate.tagName === "A" ? "link" : candidate.tagName === "BUTTON" ? "button" : "");
                const name = collapse([candidate.getAttribute("aria-label"), candidate.getAttribute("title"), candidate.textContent].filter(Boolean).join(" "));
                return candidateRole === role && name === accessibleName;
              });
            if (sameName.length > 1) nth = Math.max(0, sameName.indexOf(control as HTMLElement));
          }
          return {
            target: {
              tag,
              ...(label ? { label } : {}),
              ...(anchor instanceof HTMLAnchorElement ? { href: anchor.href } : {}),
            },
            locator: {
              tag,
              ...(role ? { role } : {}),
              ...(accessibleName ? { name: accessibleName } : {}),
              ...(testId ? { testId } : {}),
              ...(elementId ? { elementId } : {}),
              ...(fieldName ? { fieldName } : {}),
              ...(anchor instanceof HTMLAnchorElement ? { href: anchor.href } : {}),
              ...(text ? { text } : {}),
              ...(nth !== undefined ? { nth } : {}),
              ...(inDialog ? { inDialog } : {}),
            },
          };
        }, { x: action.x ?? 0, y: action.y ?? 0 });
        target = captured?.target;
        locator = captured?.locator;
      } else if (action.actor === "agent" && action.type === "type") {
        target = await this.page.evaluate(() => {
          const control = document.activeElement;
          if (!(control instanceof Element)) return undefined;
          const label = [
            control.getAttribute("aria-label"),
            control.getAttribute("title"),
            control.getAttribute("placeholder"),
            control.getAttribute("name"),
          ].filter(Boolean).join(" ").trim().replace(/\s+/g, " ").slice(0, 160);
          return { tag: control.tagName.toLocaleLowerCase(), ...(label ? { label } : {}) };
        });
      }

      try {
        this.lastMutationAt = Date.now();
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
        if (options.recordHistory !== false) {
          await runHistoryRecorder.recordAction({
            action,
            beforeUrl,
            afterUrl: this.page.url(),
            beforeFrameRevision,
            afterFrameRevision: this.frameRevision,
            ...(target ? { target } : {}),
            ...(locator ? { locator } : {}),
            startedAt,
            completedAt: new Date().toISOString(),
          });
        }
      } catch (error) {
        store.setBrowser("ready", this.page.url());
        if (action.actor === "agent" && options.recordHistory !== false) {
          await runHistoryRecorder.discardFailedRun().catch((historyError) => {
            store.addProcessLog("system", "error", "失敗した操作の部分履歴を破棄できませんでした", historyError instanceof Error ? historyError.message : undefined);
          });
        }
        throw error;
      } finally {
        this.suppressActivity = previousSuppressActivity;
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
    if (link && isWebNavigationUrl(link.url) && !isAllowedUrl(link.url)) throw new Error("DOMAIN_NOT_ALLOWED");
    store.addProcessLog("browser", "info", "ブラウザ上の要素をクリックしました", target.label ? `${target.tag}: ${target.label}` : target.tag);
    const sourceUrl = this.page.url();
    await this.page.mouse.click(x, y);
    await this.page.waitForTimeout(150);

    if (link && !this.suppressActivity) {
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