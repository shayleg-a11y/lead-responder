/**
 * Fake CRM for --demo and tests. Leads live in memory; "customers" can auto-reply.
 */
import type { CrmAdapter, LeadDetail, LeadSummary, Message, SendResult } from "./types.js";

export interface MockOptions {
  /** When true, customers auto-reply a few seconds after we text them (demo mode). */
  autoReply?: boolean;
  autoReplyDelayMs?: number;
  now?: () => Date;
  sessionValid?: () => boolean;
}

const DEMO_NAMES = ["Maria Lopez", "James Carter", "Priya Patel", "Daniel Kim", "Ashley Nguyen", "Robert Garcia"];
const DEMO_VEHICLES = ["2024 Toyota Camry SE", "2023 Honda CR-V EX-L", "2025 Ford F-150 XLT", "2024 Tesla Model Y", "2022 BMW X3 xDrive30i", "2024 Hyundai Tucson SEL"];
const DEMO_SOURCES = ["AutoTrader", "CarGurus", "Cars.com", "Dealer website", "TrueCar"];
const DEMO_COMMENTS = ["Is this still available?", "Looking to come in this weekend.", "What colors do you have?", "", "Interested in test driving."];

/** Scripted customer personalities so a demo exercises every branch. */
const REPLY_SCRIPTS: string[][] = [
  ["Yes still interested. Is it still available?", "Can I come Saturday at 11am?"],
  ["What's the best price you can do?", "Ok. How about tomorrow around 3pm?"],
  ["Is this a bot?"],
  ["STOP"],
  ["I already bought one elsewhere, thanks"],
  ["Does it have Apple CarPlay?", "Great. I'll swing by Thursday at 5:30 pm"],
];

export class MockCrm implements CrmAdapter {
  readonly name = "mock";
  private leads = new Map<string, LeadDetail>();
  private threads = new Map<string, Message[]>();
  private scripts = new Map<string, string[]>();
  private counter = 0;
  private timers: NodeJS.Timeout[] = [];
  private now: () => Date;
  constructor(private opts: MockOptions = {}) {
    this.now = opts.now ?? (() => new Date());
  }

  async init(): Promise<void> {}
  async isSessionValid(): Promise<boolean> {
    return this.opts.sessionValid ? this.opts.sessionValid() : true;
  }
  async close(): Promise<void> {
    this.timers.forEach(clearTimeout);
  }

  /* ---- fixtures ---- */

  addLead(partial: Partial<LeadDetail> & { script?: string[] } = {}): LeadDetail {
    const n = this.counter++;
    const id = partial.id ?? `L${1000 + n}`;
    const lead: LeadDetail = {
      id,
      name: partial.name ?? DEMO_NAMES[n % DEMO_NAMES.length],
      createdAt: partial.createdAt ?? this.now().toISOString(),
      source: partial.source ?? DEMO_SOURCES[n % DEMO_SOURCES.length],
      vehicle: partial.vehicle ?? DEMO_VEHICLES[n % DEMO_VEHICLES.length],
      phone: partial.phone ?? `(949) 555-0${String(100 + n).slice(-3)}`,
      email: partial.email ?? `${(partial.name ?? DEMO_NAMES[n % DEMO_NAMES.length]).toLowerCase().replace(/\s+/g, ".")}@example.com`,
      comment: partial.comment ?? DEMO_COMMENTS[n % DEMO_COMMENTS.length],
    };
    this.leads.set(id, lead);
    this.threads.set(id, []);
    this.scripts.set(id, partial.script ?? [...REPLY_SCRIPTS[n % REPLY_SCRIPTS.length]]);
    return lead;
  }

  /** Simulate the customer writing in. */
  customerSays(id: string, body: string, channel: "sms" | "email" = "sms"): Message {
    const t = this.threads.get(id);
    if (!t) throw new Error(`no lead ${id}`);
    const m: Message = { id: `${id}-m${t.length + 1}`, direction: "inbound", channel, body, at: this.now().toISOString() };
    t.push(m);
    return m;
  }

  /** Simulate the rep texting by hand from inside the CRM. */
  repSays(id: string, body: string, channel: "sms" | "email" = "sms"): Message {
    const t = this.threads.get(id)!;
    const m: Message = { id: `${id}-m${t.length + 1}`, direction: "outbound", channel, body, at: this.now().toISOString(), sender: "rep" };
    t.push(m);
    return m;
  }

  thread(id: string): Message[] {
    return [...(this.threads.get(id) ?? [])];
  }

  /* ---- adapter ---- */

  async listLeads(): Promise<LeadSummary[]> {
    return [...this.leads.values()]
      .map(({ id, name, createdAt, source, vehicle }) => ({ id, name, createdAt, source, vehicle }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async getLead(id: string): Promise<LeadDetail> {
    const l = this.leads.get(id);
    if (!l) throw new Error(`Lead ${id} not found`);
    return { ...l };
  }
  async getMessages(id: string): Promise<Message[]> {
    return this.thread(id);
  }
  async sendText(id: string, body: string): Promise<SendResult> {
    return this.outbound(id, body, "sms");
  }
  async sendEmail(id: string, subject: string, body: string): Promise<SendResult> {
    return this.outbound(id, `${subject}\n\n${body}`, "email");
  }

  private outbound(id: string, body: string, channel: "sms" | "email"): SendResult {
    const t = this.threads.get(id);
    if (!t) return { ok: false, error: `Lead ${id} not found` };
    t.push({ id: `${id}-m${t.length + 1}`, direction: "outbound", channel, body, at: this.now().toISOString(), sender: "me" });
    if (this.opts.autoReply && channel === "sms") {
      const script = this.scripts.get(id) ?? [];
      const next = script.shift();
      if (next) {
        const timer = setTimeout(() => this.customerSays(id, next), this.opts.autoReplyDelayMs ?? 15_000);
        this.timers.push(timer);
      }
    }
    return { ok: true };
  }
}
