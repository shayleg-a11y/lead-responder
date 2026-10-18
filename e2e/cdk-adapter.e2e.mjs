// End-to-end check of the real Playwright CDK adapter against the fake CDK site:
// unmapped refusal → session check → list → detail → thread → send text → thread shows it → probe.
// Run: npm run e2e   (needs the build and Chromium from `npm install`)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeCdk, FAKE_CDK_SELECTORS } from "./fake-cdk-server.mjs";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "lr-e2e-"));
process.env.LEAD_RESPONDER_HOME = tmpHome;
const { CdkAdapter, defaultSelectorMap } = await import("../dist/crm/cdk.js");
const { verifyMap } = await import("../dist/crm/learn.js");

const assert = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exit(1); } console.log("ok  ", msg); };
const { srv, leads, port } = await startFakeCdk(4790);
const baseUrl = `http://localhost:${port}`;

// 1. Unmapped → refuses to act.
const unmapped = new CdkAdapter({ baseUrl, headed: false, map: defaultSelectorMap(), profileDir: path.join(tmpHome, "profile"), typeDelayMs: 1 });
await unmapped.init();
let threw = false;
try { await unmapped.listLeads(); } catch (e) { threw = /not mapped/i.test(String(e)); }
assert(threw, "unmapped adapter refuses to read leads (CDK layout not mapped)");

// 2. Not logged in → session invalid.
assert((await unmapped.isSessionValid()) === false, "session invalid before login");

// 3. "Log in" the way the rep would — in the persistent profile — then mapped adapter sees a valid session.
const page = unmapped.currentPage();
await page.goto(`${baseUrl}/`);
await page.click("button:has-text('Sign in')");
await page.waitForURL(/\/leads/);
await unmapped.close();

const cdk = new CdkAdapter({ baseUrl, headed: false, map: structuredClone(FAKE_CDK_SELECTORS), profileDir: path.join(tmpHome, "profile"), typeDelayMs: 1 });
await cdk.init();
assert(await cdk.isSessionValid(), "session valid after login (cookie persisted in chrome-profile)");

// 4. Reads.
const list = await cdk.listLeads();
assert(list.length === 2 && list[0].id === "5001" && list[0].vehicle.includes("Camry"), `listLeads → ${list.length} rows with ids/vehicles`);
const detail = await cdk.getLead("5001");
assert(detail.phone === "(949) 555-0100" && detail.email === "maria@example.com" && detail.comment.includes("available"), "getLead → phone/email/comment");
const before = await cdk.getMessages("5001");
assert(before.length === 1 && before[0].direction === "inbound" && before[0].channel === "email", "getMessages → inbound email detected via markers");

// 5. Send a text through the composer, then see it in the thread as outbound sms.
const res = await cdk.sendText("5001", "Hi Maria, this is Jordan — the Camry is here. When works to come see it?");
assert(res.ok, "sendText ok");
assert(leads["5001"].activity.some((a) => a.dir === "Outbound" && a.body.includes("Jordan")), "fake CDK received the text");
const after = await cdk.getMessages("5001");
assert(after.length === 2 && after[1].direction === "outbound" && after[1].channel === "sms", "thread now shows our outbound sms");

// 6. Probe/verify on the lead page with the composer open (what Teach mode does).
await cdk.currentPage().click("#btn-text");
const v = await verifyMap(cdk, structuredClone(FAKE_CDK_SELECTORS));
assert(v.ok && v.missing.length === 0, "verifyMap: all critical selectors resolve on the live lead page");
const snap = await cdk.snapshot("lead_detail");
assert(fs.existsSync(snap.html) && fs.existsSync(snap.png), "snapshot wrote html + png");

await cdk.close();
srv.close();
fs.rmSync(tmpHome, { recursive: true, force: true });
console.log("\nCDK adapter e2e: all good");
process.exit(0);
