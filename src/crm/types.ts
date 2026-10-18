/**
 * The adapter interface every CRM implements.
 * The engine only ever talks to a CrmAdapter; nothing else knows what a CRM looks like.
 */

export type Channel = "sms" | "email";
export type Direction = "inbound" | "outbound";

export interface LeadSummary {
  /** CRM's own id for the lead (stable across polls). */
  id: string;
  name: string;
  /** When the lead was created in the CRM (ISO). */
  createdAt: string;
  /** Lead source as the CRM shows it (AutoTrader, CarGurus, website ...). */
  source?: string;
  /** Vehicle of interest as the CRM shows it ("2024 Toyota Camry SE"). */
  vehicle?: string;
}

export interface LeadDetail extends LeadSummary {
  phone?: string;
  email?: string;
  /** Free-text comment the customer left on the lead form. */
  comment?: string;
  /** Stock number / VIN if visible. */
  stock?: string;
}

export interface Message {
  /** Stable id within the lead's thread. */
  id: string;
  direction: Direction;
  channel: Channel;
  body: string;
  /** ISO timestamp. */
  at: string;
  /** Who sent it when outbound (the rep's name) — used to detect manual sends. */
  sender?: string;
}

export interface SendResult {
  ok: boolean;
  error?: string;
}

export interface CrmAdapter {
  readonly name: string;
  /** Called once at start; opens the browser / session. */
  init(): Promise<void>;
  /** Is the CRM session usable right now (logged in, page loads)? */
  isSessionValid(): Promise<boolean>;
  /** New-ish leads, newest first. Adapter may return more than needed; engine filters. */
  listLeads(): Promise<LeadSummary[]>;
  getLead(id: string): Promise<LeadDetail>;
  /** Every message in the lead's thread, oldest first, both directions, both channels. */
  getMessages(id: string): Promise<Message[]>;
  sendText(id: string, body: string): Promise<SendResult>;
  sendEmail(id: string, subject: string, body: string): Promise<SendResult>;
  /** Optional: template library the store uses (for tone/phrases). */
  getTemplates?(): Promise<{ name: string; body: string; channel: Channel }[]>;
  close(): Promise<void>;
}

/** Anything the engine needs to know about the store. */
export interface StoreProfile {
  repName: string;
  repTitle: string;
  storeName: string;
  /** IANA zone, e.g. America/Los_Angeles */
  timezone: string;
  /** 24h "09:00" style, per weekday 0=Sun..6=Sat; null = closed */
  hours: Record<string, { open: string; close: string } | null>;
  /** The rep's own words for what counts as an appointment. */
  appointmentDefinition: string;
  /** Phrases to always use / never use. */
  alwaysSay?: string;
  neverSay?: string;
  extraInstructions?: string;
}
