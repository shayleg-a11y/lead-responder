/**
 * CDK Connect adapter. Playwright over a persistent Chrome profile (the rep's login lives in it),
 * driven entirely by cdk-selectors.json so a UI change is a map change, not a code change.
 *
 * Nothing is guessed: with "mapped": false every read/send throws "CDK layout not mapped".
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext, type Page, type Locator } from "playwright";
import type { CrmAdapter, LeadDetail, LeadSummary, Message, SendResult, Channel } from "./types.js";
import { PROFILE_DIR, SELECTORS_PATH, SNAPSHOT_DIR } from "../config.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export interface SelectorMap {
  mapped: boolean;
  version: number;
  login: { loggedInProbe: string[]; loginFormProbe: string[] };
  leads: {
    listUrl: string;
    row: string[];
    rowId: { attr: string; selector: string[]; fallbackHrefPattern: string };
    rowName: string[];
    rowCreated: string[];
    rowSource: string[];
    rowVehicle: string[];
    /** Absolute or relative URL template with {id}; empty = click the row. */
    detailUrl: string;
  };
  detail: Record<"name" | "phone" | "email" | "vehicle" | "source" | "comment" | "created" | "stock", string[]>;
  messages: Record<"item" | "body" | "time" | "inboundMarker" | "outboundMarker" | "smsMarker" | "emailMarker", string[]>;
  sendText: Record<"openButton" | "body" | "sendButton", string[]>;
  sendEmail: Record<"openButton" | "subject" | "body" | "sendButton", string[]>;
  templates: { url: string; item: string[]; name: string[]; body: string[] };
}

/** The selectors that must resolve on a live lead page before the adapter is allowed to send. */
export const CRITICAL_SELECTORS = ["detail.phone", "messages.item", "sendText.openButton", "sendText.body", "sendText.sendButton"] as const;

export function defaultSelectorMap(): SelectorMap {
  return require("./cdk-selectors.json") as SelectorMap;
}

export function loadSelectorMap(): SelectorMap {
  const base = defaultSelectorMap();
  if (!fs.existsSync(SELECTORS_PATH)) return structuredClone(base);
  try {
    const user = JSON.parse(fs.readFileSync(SELECTORS_PATH, "utf8"));
    return deepMerge(structuredClone(base) as unknown as Record<string, unknown>, user) as unknown as SelectorMap;
  } catch {
    return structuredClone(base);
  }
}

export function saveSelectorMap(map: SelectorMap): void {
  fs.mkdirSync(path.dirname(SELECTORS_PATH), { recursive: true });
  fs.writeFileSync(SELECTORS_PATH, JSON.stringify(map, null, 2));
}

function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === "object" && !Array.isArray(v) && a[k] && typeof a[k] === "object" && !Array.isArray(a[k])) {
      a[k] = deepMerge(a[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      a[k] = v;
    }
  }
  return a;
}

/** Flatten "a.b.c" paths → selector arrays, for probing. */
export function selectorEntries(map: SelectorMap): { path: string; selectors: string[] }[] {
  const out: { path: string; selectors: string[] }[] = [];
  const walk = (obj: unknown, prefix: string) => {
    if (!obj || typeof obj !== "object") return;
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (Array.isArray(v) && v.every((x) => typeof x === "string")) out.push({ path: p, selectors: v as string[] });
      else if (v && typeof v === "object") walk(v, p);
    }
  };
  walk({ leads: map.leads, detail: map.detail, messages: map.messages, sendText: map.sendText, sendEmail: map.sendEmail, templates: map.templates, login: map.login }, "");
  return out;
}

export interface CdkOptions {
  baseUrl: string;
  headed?: boolean;
  map?: SelectorMap;
  profileDir?: string;
  log?: (line: string) => void;
  /** Human-paced typing delay per character (ms). */
  typeDelayMs?: number;
}

export class CdkAdapter implements CrmAdapter {
  readonly name = "cdk";
  private ctx: BrowserContext | null = null;
  private page: Page | null = null;
  private headed: boolean;
  map: SelectorMap;
  private profileDir: string;
  private log: (line: string) => void;
  private typeDelayMs: number;
  baseUrl: string;

  constructor(private opts: CdkOptions) {
    this.headed = !!opts.headed;
    this.map = opts.map ?? loadSelectorMap();
    this.profileDir = opts.profileDir ?? PROFILE_DIR;
    this.log = opts.log ?? (() => {});
    this.typeDelayMs = opts.typeDelayMs ?? 45;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
  }

  reloadMap(): void {
    this.map = loadSelectorMap();
  }

  /* ---------- browser lifecycle ---------- */

  async init(): Promise<void> {
    await this.ensureBrowser(this.headed);
  }

  /** (Re)launch the persistent context, headed or headless. Relaunches if the mode differs. */
  async ensureBrowser(headed: boolean): Promise<Page> {
    if (this.ctx && this.page && !this.page.isClosed() && this.headed === headed) return this.page;
    await this.close();
    fs.mkdirSync(this.profileDir, { recursive: true });
    this.ctx = await chromium.launchPersistentContext(this.profileDir, {
      headless: !headed,
      // Optional: point at an installed Chrome/Chromium instead of Playwright's download.
      executablePath: process.env.LEAD_RESPONDER_CHROME || undefined,
      viewport: { width: 1366, height: 900 },
      args: ["--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check"],
    });
    this.headed = headed;
    // Chrome drops session cookies on exit, and many CRM logins are session cookies. We stash them on close
    // (storageState) and re-add them here so a headed→headless relaunch keeps the rep logged in.
    const statePath = path.join(this.profileDir, "..", "session-cookies.json");
    try {
      if (fs.existsSync(statePath)) {
        const st = JSON.parse(fs.readFileSync(statePath, "utf8")) as { cookies?: Parameters<BrowserContext["addCookies"]>[0] };
        if (st.cookies?.length) await this.ctx.addCookies(st.cookies);
      }
    } catch (e) {
      this.log(`[cdk] could not restore session cookies: ${e instanceof Error ? e.message : e}`);
    }
    this.page = this.ctx.pages()[0] ?? (await this.ctx.newPage());
    this.page.setDefaultTimeout(15_000);
    this.log(`[cdk] browser up (${headed ? "visible" : "hidden"})`);
    return this.page;
  }

  async close(): Promise<void> {
    try {
      if (this.ctx) {
        const st = await this.ctx.storageState();
        fs.writeFileSync(path.join(this.profileDir, "..", "session-cookies.json"), JSON.stringify({ cookies: st.cookies }), { mode: 0o600 });
      }
    } catch {
      /* ignore */
    }
    try {
      await this.ctx?.close();
    } catch {
      /* ignore */
    }
    this.ctx = null;
    this.page = null;
  }

  /** Open a visible window on the CDK login page and wait until the rep is logged in (or timeout). */
  async openForLogin(timeoutMs = 10 * 60_000): Promise<boolean> {
    const page = await this.ensureBrowser(true);
    await page.goto(this.baseUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.bringToFront().catch(() => {});
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (page.isClosed()) return false;
      if (await this.looksLoggedIn(page)) return true;
      await page.waitForTimeout(2000);
    }
    return false;
  }

  /** Bring the visible window up (Teach mode / map). */
  async showWindow(): Promise<Page> {
    const page = await this.ensureBrowser(true);
    await page.bringToFront().catch(() => {});
    return page;
  }

  async hideWindow(): Promise<void> {
    await this.ensureBrowser(false);
  }

  currentPage(): Page | null {
    return this.page;
  }

  /* ---------- session ---------- */

  private async looksLoggedIn(page: Page): Promise<boolean> {
    // Logged in when none of the login-form probes are present (and, if given, a logged-in probe is).
    for (const sel of this.map.login.loginFormProbe) {
      if (await page.locator(sel).first().isVisible().catch(() => false)) return false;
    }
    if (this.map.login.loggedInProbe.length) {
      for (const sel of this.map.login.loggedInProbe) {
        if (await page.locator(sel).first().isVisible().catch(() => false)) return true;
      }
      return false;
    }
    return true;
  }

  async isSessionValid(): Promise<boolean> {
    try {
      const page = await this.ensureBrowser(this.headed);
      const url = this.map.leads.listUrl ? this.abs(this.map.leads.listUrl) : this.baseUrl;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForTimeout(1500);
      return await this.looksLoggedIn(page);
    } catch (e) {
      this.log(`[cdk] session check failed: ${e instanceof Error ? e.message : e}`);
      return false;
    }
  }

  /* ---------- helpers ---------- */

  private abs(u: string): string {
    if (/^https?:\/\//.test(u)) return u;
    return `${this.baseUrl}${u.startsWith("/") ? "" : "/"}${u}`;
  }

  private assertMapped(): void {
    if (!this.map.mapped) throw new Error("CDK layout not mapped — run Teach CDK from the dashboard.");
  }

  /** First selector in the list that exists under `root`. */
  private async pick(root: Page | Locator, selectors: string[]): Promise<Locator | null> {
    for (const sel of selectors) {
      const loc = root.locator(sel).first();
      if ((await loc.count().catch(() => 0)) > 0) return loc;
    }
    return null;
  }

  /** First selector string in the list that matches at least one element. */
  private async pickSel(root: Page | Locator, selectors: string[]): Promise<string | null> {
    for (const sel of selectors) {
      if ((await root.locator(sel).count().catch(() => 0)) > 0) return sel;
    }
    return null;
  }

  private async text(root: Page | Locator, selectors: string[]): Promise<string | undefined> {
    const loc = await this.pick(root, selectors);
    if (!loc) return undefined;
    const t = (await loc.innerText().catch(() => "")).trim();
    if (t) return t;
    const v = await loc.getAttribute("value").catch(() => null);
    return v?.trim() || undefined;
  }

  private async humanType(loc: Locator, text: string): Promise<void> {
    await loc.click();
    await loc.fill("");
    // Type in chunks with a per-char delay so it looks like a person, but don't take a minute on long emails.
    const delay = text.length > 400 ? 8 : this.typeDelayMs;
    await loc.pressSequentially(text, { delay });
  }

  /* ---------- reads ---------- */

  async listLeads(): Promise<LeadSummary[]> {
    this.assertMapped();
    const page = await this.ensureBrowser(this.headed);
    await page.goto(this.abs(this.map.leads.listUrl), { waitUntil: "domcontentloaded" });
    const rowSel = await this.pickSel(page, this.map.leads.row);
    if (!rowSel) return [];
    const rows = page.locator(rowSel);
    const n = Math.min(await rows.count(), 50);
    const out: LeadSummary[] = [];
    for (let i = 0; i < n; i++) {
      const row = rows.nth(i);
      const id = await this.rowId(row);
      if (!id) continue;
      out.push({
        id,
        name: (await this.text(row, this.map.leads.rowName)) ?? "Unknown",
        createdAt: parseWhen(await this.text(row, this.map.leads.rowCreated)),
        source: await this.text(row, this.map.leads.rowSource),
        vehicle: await this.text(row, this.map.leads.rowVehicle),
      });
    }
    return out;
  }

  private async rowId(row: Locator): Promise<string | null> {
    const { attr, selector, fallbackHrefPattern } = this.map.leads.rowId;
    const target = selector.length ? await this.pick(row, selector) : row;
    if (attr && target) {
      const v = await target.getAttribute(attr).catch(() => null);
      if (v) {
        if (fallbackHrefPattern) {
          const m = v.match(new RegExp(fallbackHrefPattern));
          if (m) return m[1] ?? m[0];
        }
        return v;
      }
    }
    if (fallbackHrefPattern) {
      const hrefs = await row.locator("a[href]").evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute("href") || "")).catch(() => []);
      for (const h of hrefs) {
        const m = h.match(new RegExp(fallbackHrefPattern));
        if (m) return m[1] ?? m[0];
      }
    }
    return null;
  }

  private async openLead(id: string): Promise<Page> {
    const page = await this.ensureBrowser(this.headed);
    if (this.map.leads.detailUrl) {
      await page.goto(this.abs(this.map.leads.detailUrl.replace("{id}", encodeURIComponent(id))), { waitUntil: "domcontentloaded" });
    } else {
      // Single-page app: find the row by id on the list and click it.
      await page.goto(this.abs(this.map.leads.listUrl), { waitUntil: "domcontentloaded" });
      const rowSel = (await this.pickSel(page, this.map.leads.row)) ?? this.map.leads.row[0];
      const rows = page.locator(rowSel);
      const n = await rows.count();
      for (let i = 0; i < n; i++) {
        if ((await this.rowId(rows.nth(i))) === id) {
          await rows.nth(i).click();
          await page.waitForTimeout(1500);
          return page;
        }
      }
      throw new Error(`Lead ${id} not found on list page`);
    }
    await page.waitForTimeout(800);
    return page;
  }

  async getLead(id: string): Promise<LeadDetail> {
    this.assertMapped();
    const page = await this.openLead(id);
    const d = this.map.detail;
    return {
      id,
      name: (await this.text(page, d.name)) ?? "Unknown",
      createdAt: parseWhen(await this.text(page, d.created)),
      phone: normalizePhone(await this.text(page, d.phone)),
      email: (await this.text(page, d.email))?.match(/[^\s<>]+@[^\s<>]+/)?.[0],
      vehicle: await this.text(page, d.vehicle),
      source: await this.text(page, d.source),
      comment: await this.text(page, d.comment),
      stock: await this.text(page, d.stock),
    };
  }

  async getMessages(id: string): Promise<Message[]> {
    this.assertMapped();
    const page = await this.openLead(id);
    return this.readThread(page, id);
  }

  /** Reads the activity list on whatever lead page is showing. */
  async readThread(page: Page, id: string): Promise<Message[]> {
    const m = this.map.messages;
    const itemSel = await this.pickSel(page, m.item);
    if (!itemSel) return [];
    const list = page.locator(itemSel);
    const n = await list.count();
    const out: Message[] = [];
    for (let i = 0; i < n; i++) {
      const item = list.nth(i);
      const body = (await this.text(item, m.body)) ?? (await item.innerText().catch(() => "")).trim();
      if (!body) continue;
      const has = async (sels: string[]) => !!(sels.length && (await this.pick(item, sels)));
      const isIn = await has(m.inboundMarker);
      const isOut = await has(m.outboundMarker);
      const isEmail = await has(m.emailMarker);
      const isSms = await has(m.smsMarker);
      // Default: anything not clearly outbound is inbound; anything not clearly email is sms.
      const direction = isOut && !isIn ? "outbound" : "inbound";
      const channel: Channel = isEmail && !isSms ? "email" : "sms";
      if (!isIn && !isOut) continue; // not a message row (note, status change, etc.)
      const at = parseWhen(await this.text(item, m.time));
      out.push({ id: `${id}-${i}-${hash(body + at)}`, direction, channel, body, at });
    }
    // Oldest first.
    return out.sort((a, b) => a.at.localeCompare(b.at));
  }

  /* ---------- sends ---------- */

  async sendText(id: string, body: string): Promise<SendResult> {
    this.assertMapped();
    try {
      const page = await this.openLead(id);
      const s = this.map.sendText;
      const open = await this.pick(page, s.openButton);
      if (!open) return { ok: false, error: "text composer button not found (sendText.openButton)" };
      await open.click();
      const box = await this.waitPick(page, s.body);
      if (!box) return { ok: false, error: "text box not found (sendText.body)" };
      await this.humanType(box, body);
      const send = await this.pick(page, s.sendButton);
      if (!send) return { ok: false, error: "send button not found (sendText.sendButton)" };
      await page.waitForTimeout(400 + Math.random() * 600);
      await send.click();
      await page.waitForTimeout(1500);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async sendEmail(id: string, subject: string, body: string): Promise<SendResult> {
    this.assertMapped();
    if (!this.map.sendEmail.openButton.length) return { ok: false, error: "email composer not mapped" };
    try {
      const page = await this.openLead(id);
      const s = this.map.sendEmail;
      const open = await this.pick(page, s.openButton);
      if (!open) return { ok: false, error: "email composer button not found" };
      await open.click();
      const subj = await this.waitPick(page, s.subject);
      if (subj) await this.humanType(subj, subject);
      const box = await this.waitPick(page, s.body);
      if (!box) return { ok: false, error: "email body not found" };
      await this.humanType(box, body);
      const send = await this.pick(page, s.sendButton);
      if (!send) return { ok: false, error: "email send button not found" };
      await page.waitForTimeout(500);
      await send.click();
      await page.waitForTimeout(1500);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private async waitPick(page: Page, selectors: string[], timeout = 8000): Promise<Locator | null> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const loc = await this.pick(page, selectors);
      if (loc && (await loc.isVisible().catch(() => false))) return loc;
      await page.waitForTimeout(250);
    }
    return null;
  }

  async getTemplates(): Promise<{ name: string; body: string; channel: Channel }[]> {
    const t = this.map.templates;
    if (!this.map.mapped || !t.url || !t.item.length) return [];
    const page = await this.ensureBrowser(this.headed);
    await page.goto(this.abs(t.url), { waitUntil: "domcontentloaded" });
    const list = page.locator((await this.pickSel(page, t.item)) ?? t.item[0]);
    const n = Math.min(await list.count(), 100);
    const out: { name: string; body: string; channel: Channel }[] = [];
    for (let i = 0; i < n; i++) {
      const item = list.nth(i);
      const name = (await this.text(item, t.name)) ?? `Template ${i + 1}`;
      const body = (await this.text(item, t.body)) ?? "";
      if (body) out.push({ name, body, channel: /text|sms/i.test(name) ? "sms" : "email" });
    }
    return out;
  }

  /* ---------- map helpers (Teach mode / `map` CLI) ---------- */

  /** Save html/png/url of the current page under SNAPSHOT_DIR/<label>.* */
  async snapshot(label: string): Promise<{ html: string; png: string; url: string }> {
    const page = await this.ensureBrowser(this.headed);
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    const safe = label.replace(/[^a-z0-9_-]+/gi, "_");
    const html = path.join(SNAPSHOT_DIR, `${safe}.html`);
    const png = path.join(SNAPSHOT_DIR, `${safe}.png`);
    const urlFile = path.join(SNAPSHOT_DIR, `${safe}.url.txt`);
    fs.writeFileSync(html, await page.content());
    await page.screenshot({ path: png, fullPage: true }).catch(() => {});
    fs.writeFileSync(urlFile, page.url());
    return { html, png, url: page.url() };
  }

  /** Which selectors resolve on the page that is showing right now. */
  async probe(map: SelectorMap = this.map): Promise<{ path: string; resolved: string | null; count: number }[]> {
    const page = await this.ensureBrowser(this.headed);
    const out: { path: string; resolved: string | null; count: number }[] = [];
    for (const { path: p, selectors } of selectorEntries(map)) {
      let resolved: string | null = null;
      let count = 0;
      for (const sel of selectors) {
        const c = await page.locator(sel).count().catch(() => 0);
        if (c > 0) {
          resolved = sel;
          count = c;
          break;
        }
      }
      out.push({ path: p, resolved, count });
    }
    return out;
  }
}

/* ---------- small utils ---------- */

export function parseWhen(s: string | undefined): string {
  if (!s) return new Date().toISOString();
  const t = s.trim();
  const rel = t.match(/(\d+)\s*(min|minute|hour|hr|day)s?\s*ago/i);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const ms = unit.startsWith("min") ? 60_000 : unit.startsWith("h") ? 3600_000 : 86_400_000;
    return new Date(Date.now() - n * ms).toISOString();
  }
  if (/just now|moments ago/i.test(t)) return new Date().toISOString();
  const d = new Date(t);
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  // "Today 3:14 PM" / "Yesterday 9:02 AM"
  const td = t.match(/^(today|yesterday)\s*,?\s*(\d{1,2}(:\d{2})?\s*(am|pm)?)/i);
  if (td) {
    const base = new Date();
    if (/yesterday/i.test(td[1])) base.setDate(base.getDate() - 1);
    const dd = new Date(`${base.toDateString()} ${td[2]}`);
    if (!Number.isNaN(dd.getTime())) return dd.toISOString();
  }
  return new Date().toISOString();
}

export function normalizePhone(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const digits = s.replace(/\D+/g, "");
  if (digits.length < 10) return undefined;
  return digits.slice(-10).replace(/(\d{3})(\d{3})(\d{4})/, "($1) $2-$3");
}

function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
