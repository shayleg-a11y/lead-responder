/**
 * Teach mode: saved snapshots → Claude writes the selector map → verified against the live page.
 */
import fs from "node:fs";
import path from "node:path";
import { SNAPSHOT_DIR } from "../config.js";
import { CRITICAL_SELECTORS, defaultSelectorMap, saveSelectorMap, type CdkAdapter, type SelectorMap } from "./cdk.js";

export const TEACH_STEPS = [
  { key: "lead_list", title: "Lead list", help: "Open the page in CDK where new internet leads show up with their timestamps." },
  { key: "lead_detail", title: "One lead opened", help: "Click into any one lead so its details and activity/message history are showing." },
  { key: "text_composer", title: "Text box open", help: "On that lead, click whatever opens the text-message composer. Do NOT send." },
  { key: "email_composer", title: "Email box open", help: "On that lead, open the email composer. Do NOT send." },
  { key: "templates", title: "Templates page (optional)", help: "If your store has a template library, open it. Skip if you don't know where it is." },
] as const;

export type TeachStepKey = (typeof TEACH_STEPS)[number]["key"];

/** Strip scripts, styles, svg, comments, long attribute noise. Keep structure + text + useful attributes. */
export function slimHtml(html: string, maxChars = 120_000): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, "")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, "")
    .replace(/<link\b[^>]*>/gi, "")
    .replace(/<meta\b[^>]*>/gi, "")
    .replace(/\sstyle="[^"]*"/gi, "")
    .replace(/\s(on\w+)="[^"]*"/gi, "")
    .replace(/\s(src|srcset|d|points|viewBox|xlink:href)="[^"]{80,}"/gi, "")
    .replace(/\sclass="([^"]*)"/gi, (_m, cls: string) => {
      // Drop hashed/utility class names; keep short human-looking ones.
      const keep = cls
        .split(/\s+/)
        .filter((c) => c.length <= 32 && !/[0-9a-f]{6,}|__|^[a-z]{1,2}-\d|^css-|^sc-|^jss\d|^Mui/.test(c))
        .slice(0, 4);
      return keep.length ? ` class="${keep.join(" ")}"` : "";
    })
    .replace(/>\s+</g, "><")
    .replace(/\s{2,}/g, " ");
  if (s.length > maxChars) s = s.slice(0, maxChars) + "\n<!-- truncated -->";
  return s;
}

export function readSnapshot(key: string): { html: string; url: string } | null {
  const html = path.join(SNAPSHOT_DIR, `${key}.html`);
  if (!fs.existsSync(html)) return null;
  const urlFile = path.join(SNAPSHOT_DIR, `${key}.url.txt`);
  return { html: fs.readFileSync(html, "utf8"), url: fs.existsSync(urlFile) ? fs.readFileSync(urlFile, "utf8").trim() : "" };
}

export function availableSnapshots(): TeachStepKey[] {
  return TEACH_STEPS.map((s) => s.key).filter((k) => fs.existsSync(path.join(SNAPSHOT_DIR, `${k}.html`)));
}

const SCHEMA_DOC = `Fill this JSON (same shape, every key present). Values are arrays of Playwright selectors tried in order, except where noted.
Selector rules: prefer [data-testid=...], #id, [name=...], [aria-label=...], or stable visible text ("text=Send Text", "button:has-text('Send')", ":has-text('Inbound')"). NEVER use hashed or utility class names. Use "text=/regex/i" for case-insensitive text. Keep each array to 1-3 options.

{
  "mapped": true,
  "version": 1,
  "login": {
    "loggedInProbe": [selectors that exist only when logged in, e.g. a user menu or the lead list],
    "loginFormProbe": [selectors that exist only on the login page, e.g. "input[type=password]"]
  },
  "leads": {
    "listUrl": "URL (absolute or path) of the page listing new leads with timestamps",
    "row": [selector for one lead row/card on that list],
    "rowId": { "attr": "attribute on the row (or on rowId.selector inside the row) holding the lead id, e.g. data-id or href", "selector": [optional element inside the row carrying the attr], "fallbackHrefPattern": "regex with one capture group that extracts the id from an href, e.g. /leads/(\\\\d+)" },
    "rowName": [...], "rowCreated": [...], "rowSource": [...], "rowVehicle": [...],
    "detailUrl": "URL template with {id} for the lead page, e.g. /leads/{id}; EMPTY STRING if the URL does not change per lead (then the app clicks the row)"
  },
  "detail": { "name": [...], "phone": [...], "email": [...], "vehicle": [...], "source": [...], "comment": [...], "created": [...], "stock": [...] },
  "messages": {
    "item": [one row in the activity/message history],
    "body": [message text inside an item],
    "time": [timestamp inside an item],
    "inboundMarker": [something inside an item that exists only for customer→dealer messages, e.g. ":has-text('Inbound')", ":has-text('Received')"],
    "outboundMarker": [exists only for dealer→customer messages, e.g. ":has-text('Outbound')", ":has-text('Sent')"],
    "smsMarker": [exists only for text messages, e.g. ":has-text('Text Message')", ":has-text('SMS')"],
    "emailMarker": [exists only for emails]
  },
  "sendText": { "openButton": [opens the text composer], "body": [the text input/textarea], "sendButton": [the send button] },
  "sendEmail": { "openButton": [...], "subject": [...], "body": [...], "sendButton": [...] },
  "templates": { "url": "", "item": [...], "name": [...], "body": [...] }
}
If something is not visible in any snapshot, leave its array empty (never invent). Respond with ONLY the JSON.`;

export interface LearnResult {
  ok: boolean;
  map: SelectorMap;
  probe: { path: string; resolved: string | null; count: number }[];
  missing: string[];
  error?: string;
}

/** Ask Claude for a selector map from the saved snapshots. */
export async function learnFromSnapshots(apiKey: string, model: string, fetchImpl: typeof fetch = fetch): Promise<SelectorMap> {
  const keys = availableSnapshots();
  if (!keys.includes("lead_detail")) throw new Error("Need at least the 'One lead opened' snapshot.");
  const parts: string[] = [];
  for (const k of keys) {
    const snap = readSnapshot(k)!;
    const step = TEACH_STEPS.find((s) => s.key === k)!;
    parts.push(`===== SNAPSHOT: ${step.title} (${k}) =====\nURL: ${snap.url}\n${slimHtml(snap.html, keys.length > 3 ? 70_000 : 110_000)}`);
  }
  const user = `These are HTML snapshots of a dealership CRM (CDK Connect) taken by the salesperson. Produce the selector map.\n\n${SCHEMA_DOC}\n\n${parts.join("\n\n")}`;
  const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model,
      max_tokens: 4000,
      temperature: 0,
      system: "You are an expert at writing robust Playwright selectors from HTML. You never invent elements that are not in the HTML.",
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { content: { text?: string }[] };
  const text = data.content.map((c) => c.text ?? "").join("");
  return parseSelectorJson(text);
}

export function parseSelectorJson(text: string): SelectorMap {
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1];
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  const obj = JSON.parse(s.slice(start, end + 1));
  const base = defaultSelectorMap();
  // Shape-check: every array key in base must be an array of strings in obj (fill missing with []).
  const fix = (b: unknown, o: unknown): unknown => {
    if (Array.isArray(b)) return Array.isArray(o) ? o.filter((x) => typeof x === "string") : [];
    if (b && typeof b === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(b as object)) out[k] = fix((b as Record<string, unknown>)[k], (o as Record<string, unknown> | undefined)?.[k]);
      return out;
    }
    if (typeof b === "string") return typeof o === "string" ? o : "";
    if (typeof b === "boolean") return typeof o === "boolean" ? o : b;
    if (typeof b === "number") return typeof o === "number" ? o : b;
    return o ?? b;
  };
  const map = fix(base, obj) as SelectorMap;
  map.mapped = true;
  return map;
}

/** Probe the map against whatever lead page is open and decide whether CDK counts as mapped. */
export async function verifyMap(cdk: CdkAdapter, map: SelectorMap): Promise<LearnResult> {
  const probe = await cdk.probe(map);
  const byPath = new Map(probe.map((p) => [p.path, p]));
  const missing = CRITICAL_SELECTORS.filter((p) => !byPath.get(p)?.resolved);
  const ok = missing.length === 0;
  map.mapped = ok;
  return { ok, map, probe, missing };
}

export async function learnAndVerify(cdk: CdkAdapter, apiKey: string, model: string): Promise<LearnResult> {
  try {
    const map = await learnFromSnapshots(apiKey, model);
    // Make sure the composer is open on the live page for verification — the rep left it open at the text_composer step,
    // but if they moved on, try to open it.
    const result = await verifyMap(cdk, map);
    if (!result.ok && map.sendText.openButton.length) {
      const page = cdk.currentPage();
      if (page) {
        for (const sel of map.sendText.openButton) {
          const loc = page.locator(sel).first();
          if (await loc.isVisible().catch(() => false)) {
            await loc.click().catch(() => {});
            await page.waitForTimeout(1200);
            break;
          }
        }
      }
      const again = await verifyMap(cdk, map);
      if (again.ok) {
        saveSelectorMap(again.map);
        cdk.map = again.map;
        return again;
      }
      saveSelectorMap({ ...again.map, mapped: false });
      return again;
    }
    saveSelectorMap(result.map);
    if (result.ok) cdk.map = result.map;
    return result;
  } catch (e) {
    return { ok: false, map: cdk.map, probe: [], missing: [...CRITICAL_SELECTORS], error: e instanceof Error ? e.message : String(e) };
  }
}
