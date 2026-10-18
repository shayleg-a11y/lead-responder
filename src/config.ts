import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { StoreProfile } from "./crm/types.js";

export const DATA_DIR = process.env.LEAD_RESPONDER_HOME || path.join(os.homedir(), ".lead-responder");
export const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");
export const DB_PATH = path.join(DATA_DIR, "leads.db");
export const PROFILE_DIR = path.join(DATA_DIR, "chrome-profile");
export const SELECTORS_PATH = path.join(DATA_DIR, "cdk-selectors.json");
export const SNAPSHOT_DIR = path.join(DATA_DIR, "snapshots");
export const LOG_PATH = path.join(DATA_DIR, "app.log");

export type Mode = "practice" | "live";

export interface Settings {
  /** Wizard progress */
  setupComplete: boolean;
  crm: "cdk" | "mock";
  crmUrl: string;
  mode: Mode;
  paused: boolean;
  profile: StoreProfile;
  anthropicApiKey?: string;
  model: string;
  telegram?: { botToken: string; chatId: string };
  /** Milliseconds between CRM polls. */
  pollMs: number;
  port: number;
}

export const DEFAULT_HOURS: StoreProfile["hours"] = {
  "0": { open: "10:00", close: "18:00" },
  "1": { open: "09:00", close: "20:00" },
  "2": { open: "09:00", close: "20:00" },
  "3": { open: "09:00", close: "20:00" },
  "4": { open: "09:00", close: "20:00" },
  "5": { open: "09:00", close: "20:00" },
  "6": { open: "09:00", close: "19:00" },
};

export function defaultSettings(): Settings {
  return {
    setupComplete: false,
    crm: "cdk",
    crmUrl: "",
    mode: "practice",
    paused: false,
    profile: {
      repName: "",
      repTitle: "Sales Consultant",
      storeName: "",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Los_Angeles",
      hours: DEFAULT_HOURS,
      appointmentDefinition:
        "The customer gives me a specific day and a time (or a window like 'Saturday morning') when they will come in.",
    },
    model: process.env.LEAD_RESPONDER_MODEL || "claude-sonnet-4-5",
    pollMs: 20_000,
    port: 4747,
  };
}

export function ensureDataDir(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
}

export function loadSettings(): Settings {
  ensureDataDir();
  const base = defaultSettings();
  if (!fs.existsSync(SETTINGS_PATH)) return base;
  try {
    const saved = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
    return { ...base, ...saved, profile: { ...base.profile, ...(saved.profile || {}) } };
  } catch {
    return base;
  }
}

export function saveSettings(s: Settings): void {
  ensureDataDir();
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2));
}

export function apiKey(s: Settings): string | undefined {
  return process.env.ANTHROPIC_API_KEY || s.anthropicApiKey || undefined;
}
