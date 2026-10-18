import { describe, it, expect } from "vitest";
import { Engine } from "../src/engine.js";
import { Db } from "../src/db.js";
import { MockCrm } from "../src/crm/mock.js";
import { TemplateBrain, type Brain, type BrainInput, type BrainOutput } from "../src/brain.js";
import type { Notifier } from "../src/notify.js";
import { DEFAULT_HOURS } from "../src/config.js";
import type { StoreProfile } from "../src/crm/types.js";

const TZ = "America/Los_Angeles";
const profile: StoreProfile = {
  repName: "Jordan Smith",
  repTitle: "Sales Consultant",
  storeName: "Example Toyota",
  timezone: TZ,
  hours: DEFAULT_HOURS,
  appointmentDefinition: "They give me a day and a time.",
};

class Clock {
  t: Date;
  constructor(iso: string) {
    this.t = new Date(iso);
  }
  now = () => new Date(this.t.getTime());
  advance(ms: number) {
    this.t = new Date(this.t.getTime() + ms);
  }
}
class Pings implements Notifier {
  list: { title: string; body: string }[] = [];
  async ping(title: string, body: string) {
    this.list.push({ title, body });
  }
}
const H = 3600_000;
/** Monday 2026-06-15 10:00 PDT */
const MON_10AM = "2026-06-15T17:00:00Z";

function setup(opts: { mode?: "practice" | "live"; brain?: Brain; clock?: Clock; sessionValid?: () => boolean } = {}) {
  const clock = opts.clock ?? new Clock(MON_10AM);
  const crm = new MockCrm({ now: clock.now, sessionValid: opts.sessionValid });
  const db = new Db(":memory:");
  const pings = new Pings();
  const engine = new Engine({ crm, brain: opts.brain ?? new TemplateBrain(), db, notifier: pings, profile, mode: opts.mode ?? "live", now: clock.now });
  return { clock, crm, db, pings, engine };
}

describe("engine loop on the mock CRM", () => {
  it("new lead → text + email first touch under the rep's name, stage Contacted", async () => {
    const { crm, db, engine } = setup();
    const lead = crm.addLead({ name: "Maria Lopez", vehicle: "2024 Toyota Camry SE" });
    await engine.tick();
    const thread = crm.thread(lead.id);
    expect(thread.filter((m) => m.direction === "outbound" && m.channel === "sms")).toHaveLength(1);
    expect(thread.filter((m) => m.direction === "outbound" && m.channel === "email")).toHaveLength(1);
    expect(thread[0].body).toContain("Jordan");
    expect(thread[0].body).toContain("Camry");
    expect(thread[0].body.length).toBeLessThanOrEqual(300);
    expect(db.getLead(lead.id)!.stage).toBe("contacted");
    // Second tick does not double-send.
    await engine.tick();
    expect(crm.thread(lead.id).filter((m) => m.direction === "outbound")).toHaveLength(2);
  });

  it("practice mode drafts everything and sends nothing", async () => {
    const { crm, db, engine } = setup({ mode: "practice" });
    const lead = crm.addLead();
    await engine.tick();
    expect(crm.thread(lead.id)).toHaveLength(0);
    const sends = db.sendsFor(lead.id);
    expect(sends.length).toBeGreaterThanOrEqual(1);
    expect(sends.every((s) => s.mode === "practice")).toBe(true);
    expect(db.events().some((e) => e.level === "draft")).toBe(true);
    expect(db.getLead(lead.id)!.stage).toBe("contacted");
  });

  it("skips leads the rep already texted, and leads older than the backlog window at boot", async () => {
    const { crm, db, engine, clock } = setup();
    const touched = crm.addLead({ name: "Already Touched" });
    crm.repSays(touched.id, "Hey this is Jordan, saw your inquiry!");
    const old = crm.addLead({ name: "Old Lead", createdAt: new Date(clock.now().getTime() - 3 * H).toISOString() });
    const fresh = crm.addLead({ name: "Fresh Lead" });
    await engine.tick();
    expect(crm.thread(touched.id).filter((m) => m.direction === "outbound")).toHaveLength(1); // only the rep's
    expect(db.getLead(touched.id)!.stage).toBe("contacted");
    expect(crm.thread(old.id)).toHaveLength(0);
    expect(db.getLead(old.id)!.stage).toBe("closed");
    expect(crm.thread(fresh.id).filter((m) => m.direction === "outbound").length).toBeGreaterThan(0);
  });

  it("customer reply → AI answers (text only) → day/time reply → Appointment + rep pinged", async () => {
    const { crm, db, engine, pings } = setup();
    const lead = crm.addLead({ name: "James Carter", vehicle: "2023 Honda CR-V" });
    await engine.tick();
    crm.customerSays(lead.id, "Is it still available?");
    await engine.tick();
    let out = crm.thread(lead.id).filter((m) => m.direction === "outbound");
    expect(out).toHaveLength(3); // sms + email first touch, then one sms reply
    expect(out[2].channel).toBe("sms");
    expect(db.getLead(lead.id)!.stage).toBe("engaged");
    crm.customerSays(lead.id, "Can I come Saturday at 11am?");
    await engine.tick();
    out = crm.thread(lead.id).filter((m) => m.direction === "outbound");
    expect(out).toHaveLength(4);
    expect(db.getLead(lead.id)!.stage).toBe("appointment");
    expect(pings.list.some((p) => p.title === "Appointment set")).toBe(true);
    // Terminal: nothing more goes out even if they write again.
    crm.customerSays(lead.id, "thanks!");
    await engine.tick();
    expect(crm.thread(lead.id).filter((m) => m.direction === "outbound")).toHaveLength(4);
  });

  it("STOP → Opted out forever (regex, not AI); 'is this a bot' → Needs you, pinged, AI stops", async () => {
    const { crm, db, engine, pings, clock } = setup();
    const a = crm.addLead({ name: "Stopper" });
    const b = crm.addLead({ name: "Skeptic" });
    await engine.tick();
    crm.customerSays(a.id, "STOP");
    crm.customerSays(b.id, "Is this a bot?");
    await engine.tick();
    expect(db.getLead(a.id)!.stage).toBe("opted_out");
    expect(db.getLead(b.id)!.stage).toBe("needs_you");
    expect(pings.list.some((p) => p.title === "Needs you" && p.body.includes("Skeptic"))).toBe(true);
    const outA = crm.thread(a.id).filter((m) => m.direction === "outbound").length;
    const outB = crm.thread(b.id).filter((m) => m.direction === "outbound").length;
    // Weeks pass, they write again: still nothing from us.
    clock.advance(21 * 24 * H);
    crm.customerSays(a.id, "hello?");
    crm.customerSays(b.id, "anyone there?");
    await engine.tick();
    await engine.tick();
    expect(crm.thread(a.id).filter((m) => m.direction === "outbound")).toHaveLength(outA);
    expect(crm.thread(b.id).filter((m) => m.direction === "outbound")).toHaveLength(outB);
  });

  it("holds in quiet hours, then follows up at 2h/1d/3d/1w/2w, stops on reply, closes after 5", async () => {
    // 9:30 pm Monday PDT
    const clock = new Clock("2026-06-16T04:30:00Z");
    const { crm, db, engine } = setup({ clock });
    const lead = crm.addLead({ name: "Night Owl" });
    await engine.tick();
    expect(crm.thread(lead.id)).toHaveLength(0);
    expect(db.getLead(lead.id)!.stage).toBe("new");
    clock.advance(11 * H); // 8:30 am Tue
    await engine.tick();
    const count = () => crm.thread(lead.id).filter((m) => m.direction === "outbound" && m.channel === "sms").length;
    expect(count()).toBe(1);
    clock.advance(1 * H);
    await engine.tick();
    expect(count()).toBe(1); // too early
    clock.advance(1 * H + 60_000); // 2h after first touch
    await engine.tick();
    expect(count()).toBe(2);
    clock.advance(24 * H + 60_000);
    await engine.tick();
    expect(count()).toBe(3);
    clock.advance(3 * 24 * H + 60_000);
    await engine.tick();
    expect(count()).toBe(4);
    // Customer replies → ladder resets and we answer instead of nudging.
    crm.customerSays(lead.id, "Sorry, busy week. What colors do you have?");
    await engine.tick();
    expect(count()).toBe(5);
    expect(db.getLead(lead.id)!.follow_ups_sent).toBe(0);
    // Silent again: 5 more nudges then closed.
    for (const d of [2 * H, 24 * H, 3 * 24 * H, 7 * 24 * H, 14 * 24 * H]) {
      clock.advance(d + 60_000);
      await engine.tick();
    }
    expect(count()).toBe(10);
    clock.advance(30 * 24 * H);
    await engine.tick();
    expect(count()).toBe(10);
    expect(db.getLead(lead.id)!.stage).toBe("closed");
  });

  it("guardrail blocks a draft that quotes money → Needs you; expired session pauses everything and pings once", async () => {
    const pricey: Brain = {
      name: "pricey",
      async think(i: BrainInput): Promise<BrainOutput> {
        return { text: i.kind === "first_touch" ? "Hi! I can get you into it for $399/mo, when can you come in?" : "ok", status: "continue", summary: "x" };
      },
    };
    const { crm, db, engine, pings } = setup({ brain: pricey });
    const lead = crm.addLead({ name: "Bargain Hunter" });
    await engine.tick();
    expect(crm.thread(lead.id)).toHaveLength(0);
    expect(db.getLead(lead.id)!.stage).toBe("needs_you");
    expect(db.getLead(lead.id)!.needs_you_reason).toMatch(/guardrail/i);
    expect(pings.list.some((p) => p.title === "Needs you")).toBe(true);

    let valid = false;
    const s = setup({ sessionValid: () => valid });
    const l2 = s.crm.addLead({ name: "Waiting" });
    await s.engine.tick();
    await s.engine.tick();
    expect(s.crm.thread(l2.id)).toHaveLength(0);
    expect(s.engine.sessionValid).toBe(false);
    expect(s.pings.list.filter((p) => /reconnect/i.test(p.title))).toHaveLength(1);
    valid = true;
    await s.engine.tick();
    expect(s.engine.sessionValid).toBe(true);
    expect(s.crm.thread(l2.id).filter((m) => m.direction === "outbound").length).toBeGreaterThan(0);
  });
});
