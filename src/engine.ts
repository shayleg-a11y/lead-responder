/**
 * The loop. new leads → first touch; new inbound → reply; silent → follow-up; holds in quiet hours.
 * Everything that decides *whether* to send lives in playbook.ts; everything that decides *what* to say in brain.ts.
 */
import type { CrmAdapter, LeadDetail, Message, StoreProfile } from "./crm/types.js";
import type { Brain, BrainOutput } from "./brain.js";
import type { Db, LeadRow } from "./db.js";
import type { Notifier } from "./notify.js";
import type { Mode } from "./config.js";
import {
  clampSms,
  guardrailScan,
  handoffReason,
  inQuietHours,
  isOptOut,
  isTerminal,
  lastInbound,
  nextAllowedTime,
  nextFollowUpAt,
  replyChannel,
  repAlreadyTouched,
  localParts,
  MAX_FOLLOW_UPS,
} from "./playbook.js";

export interface EngineOptions {
  crm: CrmAdapter;
  brain: Brain;
  db: Db;
  notifier: Notifier;
  profile: StoreProfile;
  mode: Mode;
  paused?: boolean;
  /** Injectable clock for tests. */
  now?: () => Date;
  /** Only leads created within this window are considered on first boot (default 2 h). */
  backlogWindowMs?: number;
  log?: (line: string) => void;
}

export class Engine {
  private crm: CrmAdapter;
  private brain: Brain;
  private db: Db;
  private notifier: Notifier;
  profile: StoreProfile;
  mode: Mode;
  paused: boolean;
  private now: () => Date;
  private backlogWindowMs: number;
  private bootAt: Date;
  private logFn: (line: string) => void;
  private ticking = false;
  private sessionOk = true;
  lastError: string | null = null;
  lastTickAt: Date | null = null;

  constructor(o: EngineOptions) {
    this.crm = o.crm;
    this.brain = o.brain;
    this.db = o.db;
    this.notifier = o.notifier;
    this.profile = o.profile;
    this.mode = o.mode;
    this.paused = o.paused ?? false;
    this.now = o.now ?? (() => new Date());
    this.backlogWindowMs = o.backlogWindowMs ?? 2 * 3600_000;
    this.bootAt = this.now();
    this.logFn = o.log ?? (() => {});
  }

  setBrain(b: Brain): void {
    this.brain = b;
  }

  get sessionValid(): boolean {
    return this.sessionOk;
  }

  private nowLocal(): string {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: this.profile.timezone,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(this.now());
  }

  /** One pass over the CRM. Safe to call on a timer; overlapping calls are skipped. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.lastTickAt = this.now();
      if (!(await this.crm.isSessionValid())) {
        if (this.sessionOk) {
          this.sessionOk = false;
          this.db.log("error", "CRM session expired — click Reconnect on the dashboard and log in once.");
          await this.notifier.ping("Lead Responder: reconnect needed", "Your CRM session expired. Open the dashboard and log in again.");
        }
        return;
      }
      if (!this.sessionOk) {
        this.sessionOk = true;
        this.db.log("info", "CRM session is back.");
      }
      await this.ingestLeads();
      if (this.paused) return;
      for (const lead of this.db.activeLeads()) {
        try {
          await this.processLead(lead);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          this.lastError = msg;
          this.db.log("error", `Lead ${lead.name}: ${msg}`, lead.id);
          this.logFn(`[engine] ${lead.id} ${msg}`);
        }
      }
      this.lastError = null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.lastError = msg;
      this.db.log("error", msg);
      this.logFn(`[engine] ${msg}`);
    } finally {
      this.ticking = false;
    }
  }

  /** Pull the lead list, store anything new that falls inside the backlog window. */
  private async ingestLeads(): Promise<void> {
    const leads = await this.crm.listLeads();
    const cutoff = this.bootAt.getTime() - this.backlogWindowMs;
    for (const l of leads) {
      if (this.db.getLead(l.id)) continue;
      const created = Date.parse(l.createdAt);
      if (Number.isFinite(created) && created < cutoff) {
        // Too old for a first touch; still record it so we don't look again, but mark closed.
        const row = this.db.upsertLead({ ...l, createdAt: l.createdAt });
        this.db.setStage(row.id, "closed", "older than backlog window at start");
        continue;
      }
      const detail = await this.crm.getLead(l.id);
      this.db.upsertLead({ ...detail, createdAt: detail.createdAt || l.createdAt });
      this.db.log("info", `New lead: ${detail.name}${detail.vehicle ? ` — ${detail.vehicle}` : ""}${detail.source ? ` (${detail.source})` : ""}`, l.id);
    }
  }

  private async processLead(row: LeadRow): Promise<void> {
    if (isTerminal(row.stage)) return;
    const msgs = await this.crm.getMessages(row.id);
    const ours = this.db.ourSendBodies(row.id);
    const ourIds = new Set(msgs.filter((m) => m.direction === "outbound" && ours.has(m.body.trim())).map((m) => m.id));

    // Record what we have not seen; find fresh inbound.
    const freshInbound: Message[] = [];
    for (const m of msgs) {
      if (this.db.hasSeen(row.id, m.id)) continue;
      this.db.markSeen(row.id, m);
      if (m.direction === "inbound") freshInbound.push(m);
    }

    // Terminal checks on fresh inbound run before anything else — and never via the AI.
    if (freshInbound.length) {
      const latest = freshInbound[freshInbound.length - 1];
      this.db.markInbound(row.id, latest.at);
      this.db.log("info", `${row.name} replied (${latest.channel}): "${latest.body.slice(0, 120)}"`, row.id);

      for (const m of freshInbound) {
        if (isOptOut(m.body)) {
          this.db.setStage(row.id, "opted_out", "customer opted out");
          this.db.setSummary(row.id, "Opted out — never message again");
          this.db.log("warn", `${row.name} opted out ("${m.body.trim().slice(0, 40)}"). Will never be messaged again.`, row.id);
          return;
        }
      }
      for (const m of freshInbound) {
        const reason = handoffReason(m.body);
        if (reason) {
          await this.handoff(row, `Customer message triggered "${reason.replaceAll("_", " ")}": "${m.body.slice(0, 100)}"`);
          return;
        }
      }
      await this.respond(row, msgs, latest);
      return;
    }

    // No fresh inbound. First touch?
    if (row.stage === "new") {
      if (repAlreadyTouched(msgs, ourIds)) {
        this.db.setStage(row.id, "contacted");
        this.db.markOutbound(row.id, msgs.filter((m) => m.direction === "outbound").pop()!.at, false);
        this.db.setSummary(row.id, "You already texted this lead — monitoring only");
        this.db.log("info", `${row.name}: you already texted them, so I'm only monitoring for replies.`, row.id);
        return;
      }
      if (msgs.some((m) => m.direction === "inbound")) {
        // They wrote before we ever did (seen but not fresh on a restart) — treat as a reply.
        await this.respond(row, msgs, lastInbound(msgs)!);
        return;
      }
      await this.firstTouch(row);
      return;
    }

    // Silent lead: follow-up ladder, only while the customer has not replied since our last message.
    if (row.stage === "contacted" || row.stage === "engaged") {
      if (!row.last_outbound_at) return;
      const lastOut = new Date(row.last_outbound_at);
      const lastIn = row.last_inbound_at ? new Date(row.last_inbound_at) : null;
      if (lastIn && lastIn > lastOut) return; // ball is in our court — the reply path handles it
      if (row.follow_ups_sent >= MAX_FOLLOW_UPS) {
        this.db.setStage(row.id, "closed", "follow-ups exhausted");
        this.db.setSummary(row.id, "No response after 5 follow-ups");
        this.db.log("info", `${row.name}: no response after ${MAX_FOLLOW_UPS} follow-ups. Closing.`, row.id);
        return;
      }
      const due = nextFollowUpAt(lastOut, row.follow_ups_sent);
      if (due && this.now() >= due) await this.followUp(row, msgs);
    }
  }

  /* ---------- actions ---------- */

  private async firstTouch(row: LeadRow): Promise<void> {
    if (this.holdForQuietHours(row, "first touch")) return;
    const detail = this.toDetail(row);
    const out = await this.brain.think({
      kind: "first_touch",
      lead: detail,
      thread: [],
      profile: this.profile,
      channel: "sms",
      nowLocal: this.nowLocal(),
    });
    if (!(await this.deliver(row, out, "first_touch", "sms", false))) return;
    if (out.emailBody && detail.email) {
      await this.deliver(row, out, "first_touch", "email", false);
    }
    this.db.setStage(row.id, "contacted");
    if (out.summary) this.db.setSummary(row.id, out.summary);
  }

  private async respond(row: LeadRow, msgs: Message[], latest: Message): Promise<void> {
    if (this.holdForQuietHours(row, "reply")) return;
    const channel = replyChannel(latest);
    const out = await this.brain.think({
      kind: "reply",
      lead: this.toDetail(row),
      thread: msgs,
      profile: this.profile,
      channel,
      nowLocal: this.nowLocal(),
    });
    if (out.summary) this.db.setSummary(row.id, out.summary);

    if (out.status === "needs_human") {
      // Send the short holding line (still guardrail-scanned), then hand off.
      await this.deliver(row, out, "handoff", channel, false);
      await this.handoff(row, out.note || "AI asked for a human");
      return;
    }
    if (out.status === "stop") {
      if (out.text) await this.deliver(row, out, "signoff", channel, false);
      this.db.setStage(row.id, "closed", "customer not interested");
      this.db.log("info", `${row.name}: not interested. Closing.`, row.id);
      return;
    }
    const sent = await this.deliver(row, out, "reply", channel, false);
    if (!sent) return;
    if (out.status === "appointment") {
      this.db.setStage(row.id, "appointment", out.note || "customer gave a day/time");
      this.db.log("appointment", `${row.name} booked a visit${out.note ? `: ${out.note}` : ""}`, row.id);
      await this.notifier.ping("Appointment set", `${row.name}${row.vehicle ? ` — ${row.vehicle}` : ""}\n${out.note || out.summary}`);
    } else {
      this.db.setStage(row.id, "engaged");
    }
  }

  private async followUp(row: LeadRow, msgs: Message[]): Promise<void> {
    if (this.holdForQuietHours(row, `follow-up ${row.follow_ups_sent + 1}`)) return;
    const out = await this.brain.think({
      kind: "follow_up",
      lead: this.toDetail(row),
      thread: msgs,
      profile: this.profile,
      followUpIndex: row.follow_ups_sent,
      channel: "sms",
      nowLocal: this.nowLocal(),
    });
    const sent = await this.deliver(row, out, `follow_up_${row.follow_ups_sent + 1}`, "sms", true);
    if (sent && out.summary) this.db.setSummary(row.id, out.summary);
  }

  private async handoff(row: LeadRow, reason: string): Promise<void> {
    this.db.setStage(row.id, "needs_you", reason);
    this.db.log("needs_you", `${row.name} needs you: ${reason}`, row.id);
    await this.notifier.ping("Needs you", `${row.name}${row.vehicle ? ` — ${row.vehicle}` : ""}\n${reason}`);
  }

  /**
   * Guardrail-scan, clamp, and send (or, in practice mode, draft). Returns true when the engine should
   * proceed as if the message went out.
   */
  private async deliver(row: LeadRow, out: BrainOutput, kind: string, channel: "sms" | "email", isFollowUp: boolean): Promise<boolean> {
    const body = channel === "email" ? out.emailBody || out.text : clampSms(out.text);
    const subject = out.emailSubject || `Re: ${row.vehicle ?? "your inquiry"}`;
    const text = channel === "email" ? `${subject}\n${body}` : body;

    const hit = guardrailScan(text);
    if (hit) {
      this.db.log("warn", `Blocked a ${channel} to ${row.name} — draft mentioned ${hit.rule} ("${hit.match}"). Sent to Needs you instead.`, row.id);
      await this.handoff(row, `Draft blocked by guardrail (${hit.rule}: "${hit.match}")`);
      return false;
    }
    if (!body.trim()) return false;

    if (this.mode === "practice") {
      this.db.recordSend({ leadId: row.id, channel, body, mode: "practice", kind });
      this.db.log("draft", `[Practice] Would ${channel === "sms" ? "text" : "email"} ${row.name}: "${body.slice(0, 160)}"`, row.id);
      this.db.markOutbound(row.id, this.now().toISOString(), isFollowUp);
      return true;
    }

    const res =
      channel === "sms" ? await this.crm.sendText(row.id, body) : await this.crm.sendEmail(row.id, subject, body);
    if (!res.ok) {
      this.db.log("error", `Send failed (${channel}) to ${row.name}: ${res.error ?? "unknown error"}`, row.id);
      throw new Error(res.error ?? "send failed");
    }
    this.db.recordSend({ leadId: row.id, channel, body, mode: "live", kind });
    this.db.log("send", `${channel === "sms" ? "Texted" : "Emailed"} ${row.name}: "${body.slice(0, 160)}"`, row.id);
    this.db.markOutbound(row.id, this.now().toISOString(), isFollowUp);
    return true;
  }

  private holdForQuietHours(row: LeadRow, what: string): boolean {
    const now = this.now();
    if (!inQuietHours(now, this.profile.timezone)) return false;
    const until = nextAllowedTime(now, this.profile.timezone);
    const { hour, minute } = localParts(until, this.profile.timezone);
    const key = `hold:${row.id}:${what}`;
    if (!this.heldOnce.has(key)) {
      this.heldOnce.add(key);
      this.db.log("info", `Holding ${what} for ${row.name} until ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} (quiet hours).`, row.id);
    }
    return true;
  }
  private heldOnce = new Set<string>();

  private toDetail(row: LeadRow): LeadDetail {
    return {
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      phone: row.phone ?? undefined,
      email: row.email ?? undefined,
      vehicle: row.vehicle ?? undefined,
      source: row.source ?? undefined,
      comment: row.comment ?? undefined,
    };
  }
}
