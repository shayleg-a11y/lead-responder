/**
 * Pure rules, no AI. Everything here is deterministic and unit-tested.
 * Rules that must not change without Shayle: quiet hours, STOP, no numbers, hand off on "is this a bot".
 */
import type { Message, StoreProfile } from "./crm/types.js";

/* ---------- opt-out ---------- */

const OPT_OUT_RE =
  /^\s*(stop|stopall|unsubscribe|cancel|end|quit|remove me|opt ?out|don'?t (text|message|contact) me( again)?|leave me alone|take me off( your list)?)\b[\s.!]*$/i;
const OPT_OUT_LOOSE_RE =
  /\b(unsubscribe|opt ?out|stop (texting|messaging|contacting) me|do not (text|contact|message) me|take me off (your|the) list|remove me from (your|the) list)\b/i;

export function isOptOut(text: string): boolean {
  return OPT_OUT_RE.test(text) || OPT_OUT_LOOSE_RE.test(text);
}

/* ---------- hand-off triggers ---------- */

export type HandoffReason =
  | "asked_if_bot"
  | "wants_manager"
  | "legal"
  | "fleet"
  | "already_bought"
  | "angry"
  | "ai_requested";

const HANDOFF_RULES: { reason: HandoffReason; re: RegExp }[] = [
  { reason: "asked_if_bot", re: /\b(are|r|is) (you|u|this) (a |an )?(bot|robot|ai|a\.i\.|computer|automated|auto[- ]?reply|real( person)?|human)\b|\bis this automated\b|\btalking to a (bot|machine|computer|real person|human|person)\b/i },
  { reason: "wants_manager", re: /\b(manager|supervisor|owner|gm|general manager|sales manager|finance manager|someone in charge)\b/i },
  { reason: "legal", re: /\b(lawyer|attorney|lawsuit|sue|suing|legal action|bbb|better business bureau|attorney general|lemon law|complaint)\b/i },
  { reason: "fleet", re: /\b(fleet|bulk (order|purchase)|(\d{2,}|dozen|several|multiple) (vehicles|cars|trucks|units)|commercial account)\b/i },
  { reason: "already_bought", re: /\b(already (bought|purchased|got one|have one|leased)|bought (one|it|a car|elsewhere|somewhere else)|went with another dealer|purchased (one|elsewhere)|no longer (looking|interested|in the market))\b/i },
  { reason: "angry", re: /\b(scam|rip ?off|fraud|f+u+c+k|bullshit|pissed|furious|ridiculous|worst dealership)\b/i },
];

export function handoffReason(text: string): HandoffReason | null {
  for (const r of HANDOFF_RULES) if (r.re.test(text)) return r.reason;
  return null;
}

/* ---------- guardrail scan on every outbound ---------- */

export interface GuardrailHit {
  rule: string;
  match: string;
}

const GUARDRAILS: { rule: string; re: RegExp }[] = [
  { rule: "payment", re: /\$\s?\d[\d,]*(\.\d+)?\s*(\/|per|a)\s*(mo|month|mth|wk|week|biweekly|bi-weekly)\b/i },
  { rule: "payment", re: /\b(payment|payments|pmt|pmts|per month|a month|monthly)\b[^.\n]{0,30}\$\s?\d/i },
  { rule: "payment", re: /\$\s?\d[\d,]*(\.\d+)?\b[^.\n]{0,20}\b(a|per|each|every) (month|mo|week|wk)\b/i },
  { rule: "apr", re: /\b\d+(\.\d+)?\s*%\s*(apr|interest|financing|rate)\b|\b(apr|interest rate|rate)\s*(of|at|is|around|about|as low as|=)?\s*\d+(\.\d+)?\s*%/i },
  { rule: "otd_price", re: /\b(out[- ]the[- ]door|otd|drive[- ]?off|total price|final price|sale price|selling price|price is|price of|priced at|for only|for just|i can (do|get you)|we can do)\b[^.\n]{0,40}\$\s?\d/i },
  { rule: "discount", re: /(\b\d{1,2}\s?%|\$\s?\d[\d,]*)\s*(off|discount|rebate|below (msrp|invoice))\b/i },
  { rule: "otd_price", re: /\$\s?\d{2}[\d,]{2,}(\.\d+)?/ }, // any dollar figure >= $1,000-ish quoted at all
  { rule: "guarantee", re: /\b(guarantee[ds]?|guaranty|promise[ds]?|i assure you|100% (approved|approval)|you('| a)re approved|approved for|no matter (your|the) credit|zero down|\$0 down|0 down)\b/i },
  { rule: "trade_value", re: /\b(trade[- ]?in|your (car|vehicle|trade))\b[^.\n]{0,40}(worth|value[ds]?|give you|offer)\b[^.\n]{0,20}\$\s?\d/i },
];

export function guardrailScan(outbound: string): GuardrailHit | null {
  for (const g of GUARDRAILS) {
    const m = outbound.match(g.re);
    if (m) return { rule: g.rule, match: m[0] };
  }
  return null;
}

/* ---------- quiet hours (TCPA) and store hours ---------- */

export const QUIET_START_HOUR = 21; // 9 pm
export const QUIET_END_HOUR = 8; // 8 am

export function localParts(date: Date, timezone: string): { weekday: number; hour: number; minute: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const hour = Number(parts.hour) % 24; // "24" at midnight in some engines
  return { weekday: weekdays.indexOf(parts.weekday), hour, minute: Number(parts.minute) };
}

/** True when it is NOT allowed to send (9 pm – 8 am store-local). */
export function inQuietHours(date: Date, timezone: string): boolean {
  const { hour } = localParts(date, timezone);
  return hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;
}

/** Next moment sending is allowed again (8:00 store-local). */
export function nextAllowedTime(date: Date, timezone: string): Date {
  if (!inQuietHours(date, timezone)) return date;
  // Step forward in 5-minute increments until 8 am local. Simple and DST-safe.
  const d = new Date(date.getTime());
  for (let i = 0; i < 24 * 12; i++) {
    d.setTime(d.getTime() + 5 * 60_000);
    if (!inQuietHours(d, timezone)) {
      // Snap back to the top of the hour (08:00 local).
      const { minute } = localParts(d, timezone);
      d.setTime(d.getTime() - minute * 60_000);
      d.setSeconds(0, 0);
      return d;
    }
  }
  return d;
}

export function isStoreOpen(date: Date, profile: Pick<StoreProfile, "hours" | "timezone">): boolean {
  const { weekday, hour, minute } = localParts(date, profile.timezone);
  const day = profile.hours[String(weekday)];
  if (!day) return false;
  const now = hour * 60 + minute;
  const [oh, om] = day.open.split(":").map(Number);
  const [ch, cm] = day.close.split(":").map(Number);
  return now >= oh * 60 + om && now < ch * 60 + cm;
}

/* ---------- follow-up schedule ---------- */

export const FOLLOW_UP_DELAYS_MS = [
  2 * 3600_000, // 2 h
  24 * 3600_000, // 1 d
  3 * 24 * 3600_000, // 3 d
  7 * 24 * 3600_000, // 1 w
  14 * 24 * 3600_000, // 2 w
];
export const MAX_FOLLOW_UPS = FOLLOW_UP_DELAYS_MS.length;

export const FOLLOW_UP_ANGLES = [
  "Quick check-in: ask one easy question about what matters most to them (timing, budget, must-have features).",
  "Offer value: mention you can send a short walk-around video or photos of the exact vehicle.",
  "Alternatives: ask whether they would like to see one or two similar vehicles in case this one is not the perfect fit.",
  "Low pressure: let them know there is no rush, you are their point of contact whenever they are ready, and ask if the timing changed.",
  "Last touch: a friendly sign-off that leaves the door open and says you will stop reaching out so you are not a bother.",
];

/**
 * Given the last outbound time and how many follow-ups have gone out,
 * returns the earliest time the next follow-up may be sent, or null if done.
 */
export function nextFollowUpAt(lastOutboundAt: Date, followUpsSent: number): Date | null {
  if (followUpsSent >= MAX_FOLLOW_UPS) return null;
  return new Date(lastOutboundAt.getTime() + FOLLOW_UP_DELAYS_MS[followUpsSent]);
}

/* ---------- thread analysis ---------- */

export function lastInbound(msgs: Message[]): Message | undefined {
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].direction === "inbound") return msgs[i];
  return undefined;
}
export function lastOutbound(msgs: Message[]): Message | undefined {
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].direction === "outbound") return msgs[i];
  return undefined;
}
/** The rep already texted this lead by hand (any outbound not sent by us). */
export function repAlreadyTouched(msgs: Message[], ourSendIds: Set<string>): boolean {
  return msgs.some((m) => m.direction === "outbound" && !ourSendIds.has(m.id));
}
/** Which channel to answer on: text unless the customer's last message came by email. */
export function replyChannel(inbound: Message | undefined): "sms" | "email" {
  return inbound?.channel === "email" ? "email" : "sms";
}

/* ---------- SMS clamp ---------- */

export const SMS_MAX = 300;

export function clampSms(text: string, max = SMS_MAX): string {
  let t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  if (lastStop > max * 0.5) return cut.slice(0, lastStop + 1).trim();
  const lastSpace = cut.lastIndexOf(" ");
  return cut.slice(0, lastSpace > 0 ? lastSpace : max).trim();
}

/* ---------- lead stage machine ---------- */

export type Stage =
  | "new"
  | "contacted"
  | "engaged"
  | "appointment"
  | "needs_you"
  | "opted_out"
  | "closed";

export const STAGE_LABEL: Record<Stage, string> = {
  new: "New",
  contacted: "Contacted",
  engaged: "Engaged",
  appointment: "Appointment",
  needs_you: "Needs you",
  opted_out: "Opted out",
  closed: "Closed",
};

/** Terminal stages: the engine never messages these again. */
export function isTerminal(stage: Stage): boolean {
  return stage === "opted_out" || stage === "closed" || stage === "needs_you" || stage === "appointment";
}
