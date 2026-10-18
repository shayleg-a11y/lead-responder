/**
 * Wires settings + db + CRM + brain + engine together and runs the poll loop.
 * The web server talks to this object; so does the CLI.
 */
import fs from "node:fs";
import { Db } from "./db.js";
import { Engine } from "./engine.js";
import { makeBrain } from "./brain.js";
import { MockCrm } from "./crm/mock.js";
import { CdkAdapter } from "./crm/cdk.js";
import type { CrmAdapter } from "./crm/types.js";
import { FanoutNotifier, NullNotifier, TelegramNotifier, type Notifier } from "./notify.js";
import { apiKey, DB_PATH, LOG_PATH, loadSettings, saveSettings, type Settings } from "./config.js";

export interface AppOptions {
  demo?: boolean;
  showBrowser?: boolean;
}

export class App {
  settings: Settings;
  db: Db;
  crm: CrmAdapter;
  engine: Engine;
  mock: MockCrm | null = null;
  cdk: CdkAdapter | null = null;
  private timer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  loginState: "idle" | "waiting" | "ok" | "failed" = "idle";
  readonly demo: boolean;
  startedAt = new Date();

  constructor(private opts: AppOptions = {}) {
    this.demo = !!opts.demo;
    this.settings = loadSettings();
    if (this.demo) this.settings.crm = "mock";
    this.db = new Db(this.demo ? ":memory:" : DB_PATH);
    this.crm = this.makeCrm();
    this.engine = new Engine({
      crm: this.crm,
      brain: makeBrain(apiKey(this.settings), this.settings.model),
      db: this.db,
      notifier: this.makeNotifier(),
      profile: this.settings.profile,
      mode: this.settings.mode,
      paused: this.settings.paused,
      log: (l) => this.log(l),
    });
  }

  private makeCrm(): CrmAdapter {
    if (this.settings.crm === "mock") {
      this.mock = new MockCrm({ autoReply: true, autoReplyDelayMs: 12_000 });
      return this.mock;
    }
    this.cdk = new CdkAdapter({ baseUrl: this.settings.crmUrl || "https://example.invalid", headed: !!this.opts.showBrowser, log: (l) => this.log(l) });
    return this.cdk;
  }

  private makeNotifier(): Notifier {
    const t = this.settings.telegram;
    return t?.botToken && t?.chatId ? new FanoutNotifier([new TelegramNotifier(t.botToken, t.chatId)]) : new NullNotifier();
  }

  log(line: string): void {
    const l = `${new Date().toISOString()} ${line}\n`;
    try {
      fs.appendFileSync(LOG_PATH, l);
    } catch {
      /* ignore */
    }
    if (process.env.LEAD_RESPONDER_QUIET !== "1") process.stdout.write(l);
  }

  get mapped(): boolean {
    return this.demo ? true : !!this.cdk?.map.mapped;
  }

  get hasKey(): boolean {
    return !!apiKey(this.settings);
  }

  /** Apply a settings patch from the UI and rewire what changed. */
  updateSettings(patch: Partial<Settings> & { profile?: Partial<Settings["profile"]> }): Settings {
    const prevUrl = this.settings.crmUrl;
    const prevKey = apiKey(this.settings);
    this.settings = {
      ...this.settings,
      ...patch,
      profile: { ...this.settings.profile, ...(patch.profile || {}) },
      telegram: patch.telegram === undefined ? this.settings.telegram : patch.telegram,
    };
    saveSettings(this.settings);
    this.engine.profile = this.settings.profile;
    this.engine.mode = this.settings.mode;
    this.engine.paused = this.settings.paused;
    if (apiKey(this.settings) !== prevKey) this.engine.setBrain(makeBrain(apiKey(this.settings), this.settings.model));
    if (this.cdk && this.settings.crmUrl !== prevUrl) this.cdk.baseUrl = this.settings.crmUrl.replace(/\/+$/, "");
    // Notifier may have changed
    (this.engine as unknown as { notifier: Notifier }).notifier = this.makeNotifier();
    return this.settings;
  }

  /** Start polling. Safe to call again after setup completes. */
  async start(): Promise<void> {
    if (this.timer) return;
    await this.crm.init();
    this.log(`[app] started · crm=${this.crm.name} · mode=${this.settings.mode} · brain=${this.hasKey ? "claude" : "template"}`);
    this.db.log("info", `Lead Responder started in ${this.settings.mode === "live" ? "LIVE" : "Practice"} mode${this.hasKey ? "" : " (no activation key — using built-in templates)"}.`);
    const loop = async () => {
      if (!this.settings.setupComplete && !this.demo) return;
      if (!this.mapped) return; // engine refuses to act until CDK is mapped
      await this.engine.tick();
    };
    this.timer = setInterval(loop, this.settings.pollMs);
    void loop();
    // Watchdog: if the session dropped, re-check every 5 min (the regular loop already does, this keeps logs quiet).
    this.watchdog = setInterval(() => {
      if (!this.engine.sessionValid) this.log("[watchdog] CRM session still invalid; waiting for Reconnect.");
    }, 5 * 60_000);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.timer = null;
    await this.crm.close();
    this.db.close();
  }

  /** Open the visible CDK window for login; resolves when logged in or timed out. */
  async openLogin(): Promise<void> {
    if (!this.cdk) {
      this.loginState = "ok";
      return;
    }
    if (this.loginState === "waiting") return;
    this.loginState = "waiting";
    this.db.log("info", "Opened the CDK window — log in once; the session will be remembered.");
    const ok = await this.cdk.openForLogin();
    this.loginState = ok ? "ok" : "failed";
    this.db.log(ok ? "info" : "warn", ok ? "CDK login detected." : "Did not detect a CDK login within 10 minutes.");
    if (ok && !this.opts.showBrowser) {
      // Keep it visible while the wizard continues to Teach mode; the dashboard hides it when done.
    }
  }

  snapshotState() {
    const s = this.settings;
    return {
      demo: this.demo,
      crm: this.crm.name,
      setupComplete: s.setupComplete,
      mode: s.mode,
      paused: s.paused,
      crmUrl: s.crmUrl,
      profile: s.profile,
      hasKey: this.hasKey,
      brain: this.hasKey ? "claude" : "template",
      telegram: s.telegram ? { chatId: s.telegram.chatId, botToken: s.telegram.botToken ? "••••" : "" } : null,
      mapped: this.mapped,
      loginState: this.loginState,
      sessionValid: this.engine.sessionValid,
      lastTickAt: this.engine.lastTickAt,
      lastError: this.engine.lastError,
      startedAt: this.startedAt,
      port: s.port,
      stats: this.db.stats(),
      leads: this.db.listLeads(200),
      events: this.db.events(150),
    };
  }
}
