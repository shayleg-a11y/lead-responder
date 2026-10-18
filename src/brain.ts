/**
 * The AI. One prompt in, one JSON object out. TemplateBrain is the no-key fallback
 * (demo / practice without an API key) and is also what the tests run on.
 */
import type { LeadDetail, Message, StoreProfile } from "./crm/types.js";
import { FOLLOW_UP_ANGLES } from "./playbook.js";

export type BrainKind = "first_touch" | "reply" | "follow_up";

export interface BrainInput {
  kind: BrainKind;
  lead: LeadDetail;
  thread: Message[];
  profile: StoreProfile;
  /** 0-based index into FOLLOW_UP_ANGLES for follow-ups. */
  followUpIndex?: number;
  channel: "sms" | "email";
  nowLocal: string;
}

export type BrainStatus = "continue" | "appointment" | "needs_human" | "stop";

export interface BrainOutput {
  /** The text message body (short). */
  text: string;
  /** Email subject + body; only filled for first_touch or email-channel replies. */
  emailSubject?: string;
  emailBody?: string;
  status: BrainStatus;
  /** One-line summary of where this lead stands, shown on the dashboard. */
  summary: string;
  /** Why needs_human / appointment, in a few words. */
  note?: string;
}

export interface Brain {
  readonly name: string;
  think(input: BrainInput): Promise<BrainOutput>;
}

/* ---------------- prompt ---------------- */

export function buildSystemPrompt(p: StoreProfile): string {
  const hours = Object.entries(p.hours)
    .map(([d, h]) => `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][Number(d)]}: ${h ? `${h.open}-${h.close}` : "closed"}`)
    .join(", ");
  return `You are ${p.repName}, ${p.repTitle} at ${p.storeName || "the dealership"}. You are texting and emailing internet leads in your own voice. The customer must never suspect an assistant is writing for you.

Your single goal: get the customer to book a visit (a specific day and time) to see the vehicle. Be warm, brief, human, and specific to the vehicle they asked about. One question per message. No emojis unless the customer uses them first. No exclamation-point pile-ups.

Hard rules — breaking any of these is a failure:
1. NEVER quote or estimate any number about money: price, payment, APR, interest, discount, rebate, trade-in value, fees, down payment, taxes. If asked, say pricing is handled in person or by the manager and pivot to booking a visit. Do not say "I'll find out" and then invent a figure.
2. NEVER promise or guarantee anything (availability, approval, price, delivery).
3. If the customer asks whether you are a bot/AI/real person, asks for a manager, mentions a lawyer or legal action, is buying a fleet, says they already bought, or is angry: set status "needs_human" and write a short, kind holding line like "Let me grab the right person for you — give me a moment." Do not argue or explain.
4. If the customer gives a day/time to come in that fits this definition — "${p.appointmentDefinition}" — set status "appointment", confirm it warmly in one line, and stop asking questions.
5. If the customer says they are not interested or asks you to stop: set status "stop" and send nothing pushy (text may be a one-line polite sign-off).
6. Store hours (${p.timezone}): ${hours}. Only offer times inside these hours.
${p.alwaysSay ? `7. Always work in: ${p.alwaysSay}` : ""}
${p.neverSay ? `8. Never say: ${p.neverSay}` : ""}
${p.extraInstructions ? `Extra instructions from ${p.repName}: ${p.extraInstructions}` : ""}

Text messages: under 300 characters, sign the first one with your first name only. Emails: 3-6 short sentences, plain text, signed with name and title.

Respond with ONLY a JSON object, no markdown fences:
{"text": string, "emailSubject"?: string, "emailBody"?: string, "status": "continue"|"appointment"|"needs_human"|"stop", "summary": string (<=100 chars, third person, e.g. "Asked about color options; wants to come Saturday"), "note"?: string}`;
}

export function buildUserPrompt(i: BrainInput): string {
  const { lead, thread } = i;
  const lines: string[] = [];
  lines.push(`Now (store-local): ${i.nowLocal}`);
  lines.push(`Lead: ${lead.name}${lead.source ? ` via ${lead.source}` : ""}`);
  if (lead.vehicle) lines.push(`Vehicle of interest: ${lead.vehicle}${lead.stock ? ` (stock ${lead.stock})` : ""}`);
  if (lead.comment) lines.push(`Customer's comment on the lead form: "${lead.comment}"`);
  lines.push(`Channel for this message: ${i.channel}`);
  if (thread.length) {
    lines.push("Conversation so far (oldest first):");
    for (const m of thread.slice(-20)) {
      lines.push(`  [${m.direction === "inbound" ? "CUSTOMER" : "YOU"} / ${m.channel} / ${m.at}] ${m.body}`);
    }
  }
  switch (i.kind) {
    case "first_touch":
      lines.push(
        "Task: FIRST CONTACT. Write the opening text (and an email with emailSubject/emailBody saying the same thing in slightly more words). Thank them for the inquiry, name the exact vehicle, ask one easy question (when they'd like to come see it, or what matters most). Sign the text with your first name.",
      );
      break;
    case "reply":
      lines.push("Task: REPLY to the customer's latest message. Answer what they asked (without numbers about money), then move toward a visit.");
      if (i.channel === "email") lines.push("They wrote by email, so also fill emailSubject/emailBody; text is still required as a fallback.");
      break;
    case "follow_up":
      lines.push(`Task: FOLLOW-UP #${(i.followUpIndex ?? 0) + 1}. The customer went quiet. Angle: ${FOLLOW_UP_ANGLES[i.followUpIndex ?? 0]}`);
      break;
  }
  return lines.join("\n");
}

/* ---------------- Claude ---------------- */

export class ClaudeBrain implements Brain {
  readonly name = "claude";
  constructor(
    private apiKey: string,
    private model: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async think(input: BrainInput): Promise<BrainOutput> {
    const res = await this.fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 700,
        temperature: 0.7,
        system: buildSystemPrompt(input.profile),
        messages: [{ role: "user", content: buildUserPrompt(input) }],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Claude API ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = (await res.json()) as { content: { type: string; text?: string }[] };
    const text = data.content.map((c) => c.text ?? "").join("");
    return parseBrainJson(text);
  }
}

export function parseBrainJson(raw: string): BrainOutput {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("Brain returned no JSON");
  const obj = JSON.parse(s.slice(start, end + 1)) as Partial<BrainOutput>;
  const status: BrainStatus = (["continue", "appointment", "needs_human", "stop"] as const).includes(
    obj.status as BrainStatus,
  )
    ? (obj.status as BrainStatus)
    : "continue";
  if (typeof obj.text !== "string") throw new Error("Brain JSON missing text");
  return {
    text: obj.text,
    emailSubject: typeof obj.emailSubject === "string" ? obj.emailSubject : undefined,
    emailBody: typeof obj.emailBody === "string" ? obj.emailBody : undefined,
    status,
    summary: typeof obj.summary === "string" ? obj.summary.slice(0, 140) : "",
    note: typeof obj.note === "string" ? obj.note : undefined,
  };
}

/* ---------------- Template fallback ---------------- */

const APPT_RE =
  /\b((mon|tues|wednes|thurs|fri|satur|sun)day|tomorrow|tonight|today|this (afternoon|evening|morning|weekend))\b[^.?!]{0,40}\b(\d{1,2}(:\d{2})?\s?(am|pm|a\.m\.|p\.m\.)|noon|morning|afternoon|evening)\b|\b(\d{1,2}(:\d{2})?\s?(am|pm))\b[^.?!]{0,30}\b((mon|tues|wednes|thurs|fri|satur|sun)day|tomorrow|today)\b/i;

export class TemplateBrain implements Brain {
  readonly name = "template";

  async think(i: BrainInput): Promise<BrainOutput> {
    const first = i.profile.repName.split(" ")[0] || "Me";
    const veh = i.lead.vehicle ? `the ${i.lead.vehicle}` : "the vehicle you asked about";
    const who = i.lead.name.split(" ")[0] || "there";
    const lastIn = [...i.thread].reverse().find((m) => m.direction === "inbound");
    const inText = lastIn?.body ?? "";

    if (i.kind === "first_touch") {
      return {
        text: `Hi ${who}, this is ${first} at ${i.profile.storeName || "the dealership"}. Thanks for asking about ${veh} — it's here and ready to see. When would be a good day for you to come take a look? - ${first}`,
        emailSubject: `Your inquiry on ${i.lead.vehicle ?? "our vehicle"}`,
        emailBody: `Hi ${who},\n\nThanks for reaching out about ${veh}. I'm ${first}, ${i.profile.repTitle} here at ${i.profile.storeName || "the dealership"}, and I'll be your point of contact.\n\nIt's available and I'd be glad to have it pulled up front for you. Is there a day this week that works for a quick visit?\n\n${i.profile.repName}\n${i.profile.repTitle}`,
        status: "continue",
        summary: `New lead on ${i.lead.vehicle ?? "a vehicle"}; first touch sent`,
      };
    }

    if (i.kind === "follow_up") {
      const n = i.followUpIndex ?? 0;
      const texts = [
        `Hi ${who}, ${first} again. Still thinking about ${veh}? Happy to answer anything — what matters most to you in your next car?`,
        `Hi ${who}, I can shoot you a quick walk-around video of ${veh} if that helps. Want me to send one?`,
        `Hi ${who}, if ${veh} isn't the perfect fit I have a couple of similar ones on the lot. Want me to send those over?`,
        `Hi ${who}, no rush at all — just checking whether your timing changed. I'm here whenever you're ready.`,
        `Hi ${who}, I'll stop bugging you after this one. If anything changes, I'm a text away. Take care - ${first}`,
      ];
      return { text: texts[Math.min(n, texts.length - 1)], status: "continue", summary: `Quiet; follow-up ${n + 1} sent` };
    }

    // reply
    if (APPT_RE.test(inText)) {
      return {
        text: `Perfect, ${who} — I'll have ${veh} up front and ready. See you then. Just ask for ${first} when you arrive.`,
        status: "appointment",
        summary: `Booked a visit: "${inText.slice(0, 60)}"`,
        note: inText.slice(0, 80),
      };
    }
    if (/\b(price|cost|payment|apr|rate|finance|how much|\$|out the door|otd|deal|discount|lease)\b/i.test(inText)) {
      return {
        text: `Great question, ${who}. Pricing and numbers are handled in person so you get accurate figures — it only takes a few minutes. Would today or tomorrow work for a quick visit?`,
        status: "continue",
        summary: "Asked about pricing; steered to a visit",
      };
    }
    if (/\b(available|still have|in stock|sold)\b/i.test(inText)) {
      return {
        text: `Last I checked ${veh} is still here, ${who}. The best way to lock it in is a quick visit — would this afternoon or tomorrow work?`,
        status: "continue",
        summary: "Asked if available; offered a visit",
      };
    }
    return {
      text: `Thanks ${who}. Happy to help with that — easiest is to walk through it in person with the car in front of us. What day works best for you this week?`,
      status: "continue",
      summary: `Replied: "${inText.slice(0, 60)}"`,
    };
  }
}

export function makeBrain(apiKey: string | undefined, model: string): Brain {
  return apiKey ? new ClaudeBrain(apiKey, model) : new TemplateBrain();
}
