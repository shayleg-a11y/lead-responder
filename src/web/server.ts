/**
 * Express API + the single-page wizard/dashboard (public/index.html).
 */
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { App } from "../app.js";
import { availableSnapshots, learnAndVerify, TEACH_STEPS, verifyMap } from "../crm/learn.js";
import { apiKey } from "../config.js";
import type { Stage } from "../playbook.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "../../public");

export function createServer(app: App) {
  const web = express();
  web.use(express.json({ limit: "1mb" }));
  web.use(express.static(PUBLIC_DIR));

  web.get("/api/state", (_req, res) => res.json(app.snapshotState()));

  web.post("/api/settings", (req, res) => {
    const b = req.body ?? {};
    const patch: Record<string, unknown> = {};
    if (typeof b.crmUrl === "string") patch.crmUrl = b.crmUrl.trim();
    if (b.profile && typeof b.profile === "object") patch.profile = b.profile;
    if (typeof b.anthropicApiKey === "string") patch.anthropicApiKey = b.anthropicApiKey.trim() || undefined;
    if (b.telegram === null) patch.telegram = undefined;
    else if (b.telegram && typeof b.telegram === "object") {
      const prev = app.settings.telegram;
      patch.telegram = {
        botToken: b.telegram.botToken && b.telegram.botToken !== "••••" ? String(b.telegram.botToken).trim() : prev?.botToken ?? "",
        chatId: String(b.telegram.chatId ?? prev?.chatId ?? "").trim(),
      };
    }
    if (typeof b.setupComplete === "boolean") patch.setupComplete = b.setupComplete;
    if (b.mode === "practice" || b.mode === "live") patch.mode = b.mode;
    if (typeof b.paused === "boolean") patch.paused = b.paused;
    app.updateSettings(patch);
    if (patch.mode) app.db.log("info", `Switched to ${patch.mode === "live" ? "LIVE — messages will really send" : "Practice — drafting only"}.`);
    if (typeof patch.paused === "boolean") app.db.log("info", patch.paused ? "Paused." : "Resumed.");
    res.json(app.snapshotState());
  });

  web.post("/api/setup/complete", async (_req, res) => {
    app.updateSettings({ setupComplete: true });
    app.db.log("info", "Setup complete.");
    await app.start();
    res.json(app.snapshotState());
  });

  /* ---- login ---- */
  web.post("/api/login/open", (_req, res) => {
    void app.openLogin();
    res.json({ loginState: app.loginState });
  });
  web.get("/api/login/status", (_req, res) => res.json({ loginState: app.loginState }));
  web.post("/api/reconnect", (_req, res) => {
    app.loginState = "idle";
    void app.openLogin();
    res.json({ ok: true });
  });

  /* ---- teach ---- */
  web.get("/api/teach/status", (_req, res) =>
    res.json({ steps: TEACH_STEPS, have: app.demo ? TEACH_STEPS.map((s) => s.key) : availableSnapshots(), mapped: app.mapped }),
  );
  web.post("/api/teach/show", async (_req, res) => {
    if (!app.cdk) return res.json({ ok: true, demo: true });
    try {
      await app.cdk.showWindow();
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e) });
    }
  });
  web.post("/api/teach/snapshot", async (req, res) => {
    const step = String(req.body?.step ?? "");
    if (!TEACH_STEPS.some((s) => s.key === step)) return res.status(400).json({ ok: false, error: "unknown step" });
    if (!app.cdk) return res.json({ ok: true, demo: true });
    try {
      const snap = await app.cdk.snapshot(step);
      app.db.log("info", `Saved snapshot "${step}" (${snap.url})`);
      res.json({ ok: true, ...snap });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e) });
    }
  });
  web.post("/api/teach/learn", async (_req, res) => {
    if (!app.cdk) return res.json({ ok: true, demo: true, missing: [] });
    const key = apiKey(app.settings);
    if (!key) return res.status(400).json({ ok: false, error: "Activation key needed to learn CDK." });
    app.db.log("info", "Learning CDK's layout from the snapshots…");
    const result = await learnAndVerify(app.cdk, key, app.settings.model);
    app.db.log(result.ok ? "info" : "warn", result.ok ? "CDK mapped and verified." : `CDK map incomplete — missing: ${result.missing.join(", ")}${result.error ? ` (${result.error})` : ""}`);
    res.json({ ok: result.ok, missing: result.missing, probe: result.probe, error: result.error });
  });
  web.post("/api/teach/verify", async (_req, res) => {
    if (!app.cdk) return res.json({ ok: true, demo: true, missing: [] });
    app.cdk.reloadMap();
    const result = await verifyMap(app.cdk, app.cdk.map);
    res.json({ ok: result.ok, missing: result.missing, probe: result.probe });
  });
  web.post("/api/teach/done", async (_req, res) => {
    if (app.cdk) await app.cdk.hideWindow().catch(() => {});
    res.json({ ok: true });
  });

  /* ---- leads ---- */
  web.post("/api/lead/:id/stage", (req, res) => {
    const stage = String(req.body?.stage ?? "") as Stage;
    if (!["new", "contacted", "engaged", "appointment", "needs_you", "opted_out", "closed"].includes(stage)) {
      return res.status(400).json({ error: "bad stage" });
    }
    app.db.setStage(req.params.id, stage, "set by rep");
    app.db.log("info", `You moved ${app.db.getLead(req.params.id)?.name ?? req.params.id} to ${stage.replace("_", " ")}.`, req.params.id);
    res.json({ ok: true });
  });

  web.get("/api/lead/:id", async (req, res) => {
    const row = app.db.getLead(req.params.id);
    if (!row) return res.status(404).json({ error: "not found" });
    const sends = app.db.sendsFor(req.params.id);
    let thread: unknown[] = [];
    try {
      thread = await app.crm.getMessages(req.params.id);
    } catch {
      /* unmapped or session issue */
    }
    res.json({ lead: row, sends, thread });
  });

  /* ---- demo ---- */
  web.post("/api/demo/lead", (_req, res) => {
    if (!app.mock) return res.status(400).json({ error: "not in demo mode" });
    const lead = app.mock.addLead();
    res.json({ ok: true, lead });
  });
  web.post("/api/demo/reply", (req, res) => {
    if (!app.mock) return res.status(400).json({ error: "not in demo mode" });
    app.mock.customerSays(String(req.body.id), String(req.body.body ?? ""), req.body.channel === "email" ? "email" : "sms");
    res.json({ ok: true });
  });
  web.post("/api/demo/tick", async (_req, res) => {
    if (!app.mock) return res.status(400).json({ error: "not in demo mode" });
    await app.engine.tick();
    res.json({ ok: true });
  });

  web.get("*", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));
  return web;
}
