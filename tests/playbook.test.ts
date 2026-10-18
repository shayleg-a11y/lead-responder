import { describe, it, expect } from "vitest";
import {
  isOptOut,
  handoffReason,
  guardrailScan,
  inQuietHours,
  nextAllowedTime,
  isStoreOpen,
  nextFollowUpAt,
  clampSms,
  MAX_FOLLOW_UPS,
  repAlreadyTouched,
  replyChannel,
} from "../src/playbook.js";
import { parseBrainJson } from "../src/brain.js";
import { DEFAULT_HOURS } from "../src/config.js";

const TZ = "America/Los_Angeles";
/** Build a Date that is `hour:minute` local in TZ on a given 2026 date (PDT, UTC-7). */
const la = (month: number, day: number, hour: number, minute = 0) =>
  new Date(Date.UTC(2026, month - 1, day, hour + 7, minute));

describe("opt-out (regex, never the AI)", () => {
  it("catches STOP and friends, ignores normal sentences", () => {
    for (const t of ["STOP", "stop", " Stop. ", "unsubscribe", "Please remove me from your list", "don't text me again", "opt out"]) {
      expect(isOptOut(t), t).toBe(true);
    }
    for (const t of ["Can you stop by my office?", "I want to stop paying so much for gas", "Nonstop calls at work, text is better"]) {
      expect(isOptOut(t), t).toBe(false);
    }
  });
});

describe("hand-off triggers", () => {
  it("is this a bot / manager / legal / fleet / already bought", () => {
    expect(handoffReason("Is this a bot?")).toBe("asked_if_bot");
    expect(handoffReason("am I talking to a real person")).toBe("asked_if_bot");
    expect(handoffReason("Let me speak to your manager")).toBe("wants_manager");
    expect(handoffReason("My lawyer will be in touch")).toBe("legal");
    expect(handoffReason("We need 12 trucks for our fleet")).toBe("fleet");
    expect(handoffReason("I already bought one elsewhere, thanks")).toBe("already_bought");
  });
  it("does not fire on ordinary questions", () => {
    expect(handoffReason("Is it still available?")).toBeNull();
    expect(handoffReason("Can I come Saturday at 11am?")).toBeNull();
    expect(handoffReason("Does it have CarPlay?")).toBeNull();
  });
});

describe("guardrail scan on every outbound", () => {
  it("blocks payments, APR, OTD prices, guarantees", () => {
    expect(guardrailScan("We can get you into it for $399/mo")?.rule).toBe("payment");
    expect(guardrailScan("Your monthly payment would be around $450")?.rule).toBe("payment");
    expect(guardrailScan("Rates as low as 2.9% APR right now")?.rule).toBe("apr");
    expect(guardrailScan("Out the door you're looking at $31,500")?.rule).toBe("otd_price");
    expect(guardrailScan("I can do $28,900 if you come today")?.rule).toBe("otd_price");
    expect(guardrailScan("I guarantee you'll be approved")?.rule).toBe("guarantee");
    expect(guardrailScan("We'll take $2,000 off MSRP")?.rule).toBe("discount");
  });
  it("lets normal sales texts through", () => {
    expect(guardrailScan("Hi Maria, this is Jordan at Example Toyota. The 2024 Camry SE is here — when would you like to come see it? - Jordan")).toBeNull();
    expect(guardrailScan("Pricing is handled in person so you get accurate numbers. Does tomorrow at 3 work?")).toBeNull();
    expect(guardrailScan("We're open until 8 tonight and 9 to 7 on Saturday.")).toBeNull();
  });
});

describe("quiet hours (TCPA) and store hours", () => {
  it("9 pm – 8 am store-local is quiet", () => {
    expect(inQuietHours(la(6, 15, 21, 0), TZ)).toBe(true);
    expect(inQuietHours(la(6, 15, 23, 30), TZ)).toBe(true);
    expect(inQuietHours(la(6, 16, 7, 59), TZ)).toBe(true);
    expect(inQuietHours(la(6, 16, 8, 0), TZ)).toBe(false);
    expect(inQuietHours(la(6, 15, 20, 59), TZ)).toBe(false);
    expect(inQuietHours(la(6, 15, 12, 0), TZ)).toBe(false);
  });
  it("nextAllowedTime lands at 8:00 local", () => {
    const next = nextAllowedTime(la(6, 15, 22, 17), TZ);
    expect(next.getTime()).toBe(la(6, 16, 8, 0).getTime());
    const noon = la(6, 15, 12, 0);
    expect(nextAllowedTime(noon, TZ)).toBe(noon);
  });
  it("store hours respect the weekday table", () => {
    const profile = { hours: DEFAULT_HOURS, timezone: TZ };
    expect(isStoreOpen(la(6, 15, 10, 0), profile)).toBe(true); // Mon 10am
    expect(isStoreOpen(la(6, 15, 20, 30), profile)).toBe(false); // Mon 8:30pm (closes 20:00)
    expect(isStoreOpen(la(6, 14, 9, 30), profile)).toBe(false); // Sun opens 10
    expect(isStoreOpen(la(6, 14, 17, 0), profile)).toBe(true); // Sun 5pm
  });
});

describe("follow-up ladder", () => {
  it("2h, 1d, 3d, 1w, 2w then stops at 5", () => {
    const t0 = new Date("2026-06-15T17:00:00Z");
    const h = 3600_000;
    expect(nextFollowUpAt(t0, 0)!.getTime() - t0.getTime()).toBe(2 * h);
    expect(nextFollowUpAt(t0, 1)!.getTime() - t0.getTime()).toBe(24 * h);
    expect(nextFollowUpAt(t0, 2)!.getTime() - t0.getTime()).toBe(72 * h);
    expect(nextFollowUpAt(t0, 3)!.getTime() - t0.getTime()).toBe(7 * 24 * h);
    expect(nextFollowUpAt(t0, 4)!.getTime() - t0.getTime()).toBe(14 * 24 * h);
    expect(nextFollowUpAt(t0, 5)).toBeNull();
    expect(MAX_FOLLOW_UPS).toBe(5);
  });
});

describe("SMS clamp and thread helpers", () => {
  it("clamps long texts at a sentence boundary", () => {
    const long = "First sentence here. " + "Second sentence that is quite a bit longer than the first one. ".repeat(6);
    const c = clampSms(long);
    expect(c.length).toBeLessThanOrEqual(300);
    expect(c.endsWith(".")).toBe(true);
    expect(clampSms("short")).toBe("short");
  });
  it("detects a manual rep text and picks the reply channel", () => {
    const msgs = [
      { id: "a", direction: "outbound" as const, channel: "sms" as const, body: "Hey it's Jordan", at: "2026-06-15T17:00:00Z" },
      { id: "b", direction: "inbound" as const, channel: "email" as const, body: "Hi", at: "2026-06-15T17:05:00Z" },
    ];
    expect(repAlreadyTouched(msgs, new Set())).toBe(true);
    expect(repAlreadyTouched(msgs, new Set(["a"]))).toBe(false);
    expect(replyChannel(msgs[1])).toBe("email");
    expect(replyChannel(undefined)).toBe("sms");
  });
});

describe("brain JSON parsing", () => {
  it("tolerates fences and bad status", () => {
    const out = parseBrainJson('```json\n{"text":"hi","status":"weird","summary":"s"}\n```');
    expect(out.text).toBe("hi");
    expect(out.status).toBe("continue");
    expect(() => parseBrainJson("nope")).toThrow();
  });
});

describe("template brain (no-key fallback)", () => {
  it("never trips the guardrails and detects a day/time as an appointment", async () => {
    const { TemplateBrain } = await import("../src/brain.js");
    const b = new TemplateBrain();
    const lead = { id: "L1", name: "Maria Lopez", createdAt: "2026-06-15T17:00:00Z", vehicle: "2024 Toyota Camry SE", email: "m@example.com" };
    const profile = { repName: "Jordan Smith", repTitle: "Sales Consultant", storeName: "Example Toyota", timezone: TZ, hours: DEFAULT_HOURS, appointmentDefinition: "day and time" };
    const first = await b.think({ kind: "first_touch", lead, thread: [], profile, channel: "sms", nowLocal: "Mon 10:00" });
    expect(guardrailScan(first.text)).toBeNull();
    expect(guardrailScan(first.emailBody!)).toBeNull();
    for (let i = 0; i < 5; i++) {
      const f = await b.think({ kind: "follow_up", lead, thread: [], profile, followUpIndex: i, channel: "sms", nowLocal: "" });
      expect(guardrailScan(f.text)).toBeNull();
      expect(f.text.length).toBeLessThanOrEqual(300);
    }
    const price = await b.think({ kind: "reply", lead, thread: [{ id: "m", direction: "inbound", channel: "sms", body: "What's your best price?", at: "" }], profile, channel: "sms", nowLocal: "" });
    expect(price.status).toBe("continue");
    expect(guardrailScan(price.text)).toBeNull();
    const appt = await b.think({ kind: "reply", lead, thread: [{ id: "m", direction: "inbound", channel: "sms", body: "I'll come tomorrow at 3pm", at: "" }], profile, channel: "sms", nowLocal: "" });
    expect(appt.status).toBe("appointment");
  });
});
