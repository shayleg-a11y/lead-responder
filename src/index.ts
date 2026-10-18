#!/usr/bin/env node
/**
 * CLI:
 *   lead-responder start [--demo] [--show-browser] [--no-open] [--port N]
 *   lead-responder map          open CDK visibly, print which selectors resolve on the page showing (Enter = again, q = quit)
 *   lead-responder reset        wipe settings, DB, login profile, selectors, snapshots
 */
import fs from "node:fs";
import { exec } from "node:child_process";
import readline from "node:readline";
import { App } from "./app.js";
import { createServer } from "./web/server.js";
import { DATA_DIR, ensureDataDir, loadSettings } from "./config.js";
import { CdkAdapter, loadSelectorMap } from "./crm/cdk.js";

const args = process.argv.slice(2);
const cmd = args[0] ?? "start";
const flag = (f: string) => args.includes(f);
const opt = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

function openBrowser(url: string) {
  const c = process.platform === "darwin" ? `open "${url}"` : process.platform === "win32" ? `start "" "${url}"` : `xdg-open "${url}"`;
  exec(c, () => {});
}

async function start() {
  ensureDataDir();
  const app = new App({ demo: flag("--demo"), showBrowser: flag("--show-browser") });
  const port = Number(opt("--port") ?? process.env.PORT ?? app.settings.port ?? 4747);
  const server = createServer(app);
  const listener = server.listen(port, "127.0.0.1", () => {
    const url = `http://localhost:${port}`;
    app.log(`[web] ${url}${app.demo ? "  (demo: fake CRM, nothing real is sent)" : ""}`);
    if (!flag("--no-open")) openBrowser(url);
  });
  if (app.settings.setupComplete || app.demo) await app.start();
  const shutdown = async () => {
    app.log("[app] shutting down");
    listener.close();
    await app.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function map() {
  const s = loadSettings();
  if (!s.crmUrl) {
    console.error("No CDK address saved yet. Run the wizard first (lead-responder start).");
    process.exit(1);
  }
  const cdk = new CdkAdapter({ baseUrl: s.crmUrl, headed: true, map: loadSelectorMap() });
  await cdk.showWindow();
  const page = cdk.currentPage()!;
  await page.goto(s.crmUrl).catch(() => {});
  console.log(`Map mode. Navigate in the CDK window, then press Enter here to probe the page showing. 'q' quits.`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = () =>
    rl.question("> ", async (a) => {
      if (a.trim().toLowerCase() === "q") {
        rl.close();
        await cdk.close();
        process.exit(0);
      }
      cdk.reloadMap();
      const probe = await cdk.probe();
      console.log(`URL: ${page.url()}`);
      console.table(probe.map((p) => ({ selector: p.path, resolved: p.resolved ?? "—", count: p.count })));
      const label = `map_${Date.now()}`;
      const snap = await cdk.snapshot(label);
      console.log(`snapshot saved: ${snap.html}`);
      ask();
    });
  ask();
}

function reset() {
  if (fs.existsSync(DATA_DIR)) {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    console.log(`Removed ${DATA_DIR}`);
  } else console.log("Nothing to reset.");
}

function help() {
  console.log(`lead-responder <command>

  start [--demo] [--show-browser] [--no-open] [--port N]   run the app (dashboard at http://localhost:4747)
  map                                                      open CDK and print which selectors resolve
  reset                                                    wipe ~/.lead-responder (settings, login, leads)
`);
}

switch (cmd) {
  case "start":
    start().catch((e) => {
      console.error(e);
      process.exit(1);
    });
    break;
  case "map":
    map().catch((e) => {
      console.error(e);
      process.exit(1);
    });
    break;
  case "reset":
    reset();
    break;
  default:
    help();
}
