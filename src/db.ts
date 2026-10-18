/**
 * SQLite via node:sqlite. Leads, seen messages, our sends, events (activity log).
 */
import { createRequire } from "node:module";
// Loaded via require so bundlers/test runners that don't know node:sqlite leave it alone.
import type { DatabaseSync as DatabaseSyncT } from "node:sqlite";
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
import type { Stage } from "./playbook.js";

export interface LeadRow {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  vehicle: string | null;
  source: string | null;
  comment: string | null;
  created_at: string;
  first_seen_at: string;
  stage: Stage;
  summary: string | null;
  follow_ups_sent: number;
  last_outbound_at: string | null;
  last_inbound_at: string | null;
  needs_you_reason: string | null;
  updated_at: string;
}

export interface EventRow {
  id: number;
  at: string;
  lead_id: string | null;
  level: "info" | "warn" | "error" | "send" | "draft" | "needs_you" | "appointment";
  message: string;
}

export interface SendRow {
  id: number;
  lead_id: string;
  channel: string;
  body: string;
  at: string;
  mode: string;
  kind: string;
  crm_message_id: string | null;
}

export class Db {
  private db: DatabaseSyncT;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS leads (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        phone TEXT, email TEXT, vehicle TEXT, source TEXT, comment TEXT,
        created_at TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        stage TEXT NOT NULL DEFAULT 'new',
        summary TEXT,
        follow_ups_sent INTEGER NOT NULL DEFAULT 0,
        last_outbound_at TEXT,
        last_inbound_at TEXT,
        needs_you_reason TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS seen_messages (
        lead_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        channel TEXT NOT NULL,
        body TEXT NOT NULL,
        at TEXT NOT NULL,
        PRIMARY KEY (lead_id, message_id)
      );
      CREATE TABLE IF NOT EXISTS sends (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lead_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        body TEXT NOT NULL,
        at TEXT NOT NULL,
        mode TEXT NOT NULL,
        kind TEXT NOT NULL,
        crm_message_id TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        lead_id TEXT,
        level TEXT NOT NULL,
        message TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_at ON events(at DESC);
    `);
  }

  /* ---- leads ---- */

  getLead(id: string): LeadRow | undefined {
    return this.db.prepare("SELECT * FROM leads WHERE id = ?").get(id) as LeadRow | undefined;
  }

  upsertLead(l: {
    id: string;
    name: string;
    phone?: string;
    email?: string;
    vehicle?: string;
    source?: string;
    comment?: string;
    createdAt: string;
  }): LeadRow {
    const now = new Date().toISOString();
    const existing = this.getLead(l.id);
    if (existing) {
      this.db
        .prepare(
          `UPDATE leads SET name=?, phone=COALESCE(?,phone), email=COALESCE(?,email), vehicle=COALESCE(?,vehicle),
           source=COALESCE(?,source), comment=COALESCE(?,comment), updated_at=? WHERE id=?`,
        )
        .run(l.name, l.phone ?? null, l.email ?? null, l.vehicle ?? null, l.source ?? null, l.comment ?? null, now, l.id);
    } else {
      this.db
        .prepare(
          `INSERT INTO leads (id,name,phone,email,vehicle,source,comment,created_at,first_seen_at,stage,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,'new',?)`,
        )
        .run(l.id, l.name, l.phone ?? null, l.email ?? null, l.vehicle ?? null, l.source ?? null, l.comment ?? null, l.createdAt, now, now);
    }
    return this.getLead(l.id)!;
  }

  setStage(id: string, stage: Stage, reason?: string): void {
    this.db
      .prepare("UPDATE leads SET stage=?, needs_you_reason=COALESCE(?, needs_you_reason), updated_at=? WHERE id=?")
      .run(stage, reason ?? null, new Date().toISOString(), id);
  }

  setSummary(id: string, summary: string): void {
    this.db.prepare("UPDATE leads SET summary=?, updated_at=? WHERE id=?").run(summary, new Date().toISOString(), id);
  }

  markOutbound(id: string, at: string, isFollowUp: boolean): void {
    this.db
      .prepare(
        `UPDATE leads SET last_outbound_at=?, follow_ups_sent = follow_ups_sent + ?, updated_at=? WHERE id=?`,
      )
      .run(at, isFollowUp ? 1 : 0, new Date().toISOString(), id);
  }

  markInbound(id: string, at: string): void {
    // A reply resets the follow-up ladder.
    this.db
      .prepare("UPDATE leads SET last_inbound_at=?, follow_ups_sent=0, updated_at=? WHERE id=?")
      .run(at, new Date().toISOString(), id);
  }

  listLeads(limit = 200): LeadRow[] {
    return this.db.prepare("SELECT * FROM leads ORDER BY updated_at DESC LIMIT ?").all(limit) as unknown as LeadRow[];
  }

  activeLeads(): LeadRow[] {
    return this.db
      .prepare("SELECT * FROM leads WHERE stage IN ('new','contacted','engaged') ORDER BY created_at DESC")
      .all() as unknown as LeadRow[];
  }

  /* ---- seen messages ---- */

  hasSeen(leadId: string, messageId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM seen_messages WHERE lead_id=? AND message_id=?").get(leadId, messageId);
  }

  markSeen(leadId: string, m: { id: string; direction: string; channel: string; body: string; at: string }): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO seen_messages (lead_id,message_id,direction,channel,body,at) VALUES (?,?,?,?,?,?)",
      )
      .run(leadId, m.id, m.direction, m.channel, m.body, m.at);
  }

  /* ---- sends ---- */

  recordSend(s: { leadId: string; channel: string; body: string; mode: string; kind: string; crmMessageId?: string }): number {
    const r = this.db
      .prepare("INSERT INTO sends (lead_id,channel,body,at,mode,kind,crm_message_id) VALUES (?,?,?,?,?,?,?)")
      .run(s.leadId, s.channel, s.body, new Date().toISOString(), s.mode, s.kind, s.crmMessageId ?? null);
    return Number(r.lastInsertRowid);
  }

  sendsFor(leadId: string): SendRow[] {
    return this.db.prepare("SELECT * FROM sends WHERE lead_id=? ORDER BY at ASC").all(leadId) as unknown as SendRow[];
  }

  /** Bodies we sent, used to recognise our own messages in the CRM thread. */
  ourSendBodies(leadId: string): Set<string> {
    return new Set(this.sendsFor(leadId).map((s) => s.body.trim()));
  }

  /* ---- events ---- */

  log(level: EventRow["level"], message: string, leadId?: string): void {
    this.db
      .prepare("INSERT INTO events (at,lead_id,level,message) VALUES (?,?,?,?)")
      .run(new Date().toISOString(), leadId ?? null, level, message);
  }

  events(limit = 100): EventRow[] {
    return this.db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit) as unknown as EventRow[];
  }

  stats(): { total: number; contacted: number; replied: number; appointments: number; needsYou: number; optedOut: number; sentToday: number } {
    const count = (sql: string, ...args: unknown[]) =>
      Number((this.db.prepare(sql).get(...(args as never[])) as { n: number }).n);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return {
      total: count("SELECT COUNT(*) n FROM leads"),
      contacted: count("SELECT COUNT(*) n FROM leads WHERE last_outbound_at IS NOT NULL"),
      replied: count("SELECT COUNT(*) n FROM leads WHERE last_inbound_at IS NOT NULL"),
      appointments: count("SELECT COUNT(*) n FROM leads WHERE stage='appointment'"),
      needsYou: count("SELECT COUNT(*) n FROM leads WHERE stage='needs_you'"),
      optedOut: count("SELECT COUNT(*) n FROM leads WHERE stage='opted_out'"),
      sentToday: count("SELECT COUNT(*) n FROM sends WHERE at >= ?", today.toISOString()),
    };
  }

  close(): void {
    this.db.close();
  }
}
