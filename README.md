# Lead Responder

Every new internet lead gets a personal text and email from the salesperson — sent from inside the CRM, under their name, within about two minutes — and the AI keeps the conversation going until the customer books a visit or needs a human.

One Node process on the rep's computer does everything. The only outside calls are to the Claude API (and Telegram, if enabled). The adapter is the only file that knows what the CRM looks like.

## Install (the rep's computer)

**Mac** — Terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/shayleg-a11y/lead-responder/main/install.sh | bash
```

**Windows 10/11** — PowerShell:

```powershell
irm https://raw.githubusercontent.com/shayleg-a11y/lead-responder/main/install.ps1 | iex
```

Pre-load the activation key so the rep never sees it: Mac `... | bash -s -- --key sk-ant-...`; Windows `$env:LEAD_RESPONDER_KEY="sk-ant-..."; irm ... | iex`.

The installer puts Node 22+ in place if needed, clones to `~/.lead-responder/app`, builds, registers autostart (macOS LaunchAgent `com.leadresponder.app` / Windows Task Scheduler job `LeadResponder`), and opens the setup page at **http://localhost:4747**.

Then the rep walks the 5-minute wizard: CDK address → log in once (2FA fine; the session is saved) → name/title → store hours → what counts as an appointment → activation key → **Teach CDK**. The app starts in **Practice** mode (drafts everything, sends nothing) until the rep flips it to **Live**.

## Run from source

```bash
npm install           # also downloads Chromium
npm run build
npm test              # 20 tests: playbook rules + full engine loop on the mock CRM
node dist/index.js start --demo     # fake CRM with auto-replying customers; "+ Demo lead" on the dashboard
node dist/index.js start            # real thing; dashboard at http://localhost:4747
node dist/index.js map              # open CDK visibly and print which selectors resolve on the page showing
node dist/index.js reset            # wipe ~/.lead-responder (settings, login, leads)
```

Flags for `start`: `--demo`, `--show-browser` (keep the CDK Chromium visible), `--no-open`, `--port N`.
Needs Node 22.13+ (`node:sqlite`). API key: `export ANTHROPIC_API_KEY=...` or paste it as the activation key in the wizard. Without a key the app runs on built-in templates (fine for Practice mode and the demo).

## What it does, and the rule that governs each step

| Moment | What happens | Rule |
|---|---|---|
| New lead appears | Text + email within ~2 min (20 s polling), vehicle-specific, signed with the rep's first name | Skipped if the rep already texted them by hand |
| Customer replies | Answered in ~1 min, text only unless they wrote by email | Only 8 am–9 pm store-local (TCPA quiet hours) |
| Customer goes silent | Nudges at 2 h, 1 d, 3 d, 1 w, 2 w, each with a new angle | Stops the moment they reply; max 5 |
| Customer books a day/time | Stage → **Appointment**, rep pinged (dashboard + optional Telegram) | Matches the rep's own appointment definition |
| Customer says STOP / unsubscribe | Stage → **Opted out**, never messaged again | Regex, never the AI |
| "Is this a bot", wants a manager, legal, fleet, already bought | Stage → **Needs you**, rep pinged, AI stops | Regex + AI status |
| AI drafts a payment, APR, OTD price, discount or "guarantee" | Draft blocked, lead → **Needs you** | Guardrail scan on every outbound |
| First start | Only leads from the last 2 hours are considered | No backlog blast |
| Session expires / 2FA | Engine logs it, dashboard shows **Reconnect**, rep pinged once | Rep logs in once |

Rules that must not change without Shayle: never send during quiet hours, never message after STOP, never quote numbers, always hand off when asked if it's a bot.

## File map

| File | What it is | Touch it when |
|---|---|---|
| `src/engine.ts` | The loop: new leads → first touch; new inbound → reply; silent → follow-up; holds in quiet hours | Changing timing or flow |
| `src/playbook.ts` | Pure rules, no AI: opt-out, hand-off triggers, quiet/store hours, follow-up schedule, guardrail scan, SMS clamp | Adding a rule |
| `src/brain.ts` | Claude prompt + JSON parse; `TemplateBrain` fallback without a key | Changing tone or the prompt |
| `src/crm/types.ts` | The adapter interface every CRM implements | Adding a CRM |
| `src/crm/cdk.ts` | Playwright adapter, persistent Chrome profile, selector-driven; map helpers (`snapshot`, `probe`) | CDK changes its UI |
| `src/crm/cdk-selectors.json` | Where things are on CDK pages; ships `"mapped": false`; user overrides in `~/.lead-responder/cdk-selectors.json` | After Teach mode |
| `src/crm/learn.ts` | Teach mode: snapshots → Claude writes the selector map → verify against the live page | Mapping fails |
| `src/crm/mock.ts` | Fake CRM with auto-replies (`--demo`) | Testing without a dealership |
| `src/db.ts` | SQLite via `node:sqlite`; leads, seen messages, sends, events | Never, normally |
| `src/app.ts` | Wires settings + db + CRM + brain + engine; poll loop; watchdog | Startup behaviour |
| `src/web/server.ts` + `public/index.html` | Express API + the single-page wizard/dashboard | UX changes |
| `src/index.ts` | CLI: `start [--demo] [--show-browser] [--no-open]`, `map`, `reset` | — |
| `install.sh` / `install.ps1` | One-line installers; Node, clone, build, autostart | Repo URL changes |
| `tests/` | vitest: playbook rules + full engine loop on the mock CRM (20 tests) | Every change |

Runtime data lives in `~/.lead-responder/`: `settings.json`, `leads.db`, `chrome-profile/` (the CDK login), `cdk-selectors.json`, `snapshots/`, `app.log`.

## Teaching it CDK

The app ships without knowing CDK's page layout (`"mapped": false`) and refuses to act until it does. In the wizard's Teach step (also reachable from a dashboard banner):

1. Rep clicks **Bring up the CDK window** (the logged-in Chromium).
2. For each screen the rep opens it in CDK, comes back, presses **Got it**: lead list → one lead opened → text box open (don't send) → email box open (don't send) → templates page (optional). Each one saves `.html`, `.png`, `.url.txt` to `~/.lead-responder/snapshots/`.
3. **Learn CDK** sends the slimmed HTML (scripts, styles, SVG stripped) plus the selector schema to Claude; it returns the filled `cdk-selectors.json`, written to `~/.lead-responder/cdk-selectors.json`.
4. The app probes every selector on the page the rep still has open. If `detail.phone`, `messages.item`, `sendText.openButton`, `sendText.body`, `sendText.sendButton` all resolve, CDK is mapped (`"mapped": true`); otherwise the rep sees "try again".

If it fails twice, finish it by hand from the snapshots — no second login needed:

- Read the saved `.html`/`.png`. Prefer `data-testid`, `id`, `name`, `aria-label` or stable visible text (`text=...`, `button:has-text('Send Text')`); never hashed class names. Arrays are tried in order.
- The hard parts are usually `messages.*` (telling inbound from outbound and SMS from email in the activity list; use `:has-text()` on labels like "Inbound" or "Text Message") and `leads.rowId` / `leads.detailUrl` (take the id from the row's link `href` with `fallbackHrefPattern`).
- Edit `~/.lead-responder/cdk-selectors.json`, restart the app, and check the Activity log: the engine reports *CDK layout not mapped* or a send error rather than sending blind.
- On a machine with the login, `node dist/index.js map` opens CDK visibly and prints which selectors resolve on whatever page is showing (`console.table`), one snapshot per Enter.
- `cdk.ts` expects the activity list on the lead page to include both directions; if CDK shows inbound texts somewhere else, add a second page visit in `getMessages()`.

Two things only a real login will answer: where new leads surface (set `leads.listUrl` to whichever page lists them with timestamps), and whether CDK Connect is a single-page app whose URL doesn't change per lead (then leave `detailUrl` empty and the adapter clicks the row — see `openLead()`).

## Telegram pings (optional)

Rep creates a bot via @BotFather, sends it one message; get the chat id from `https://api.telegram.org/bot<TOKEN>/getUpdates`; paste both in Settings.

## Operating notes

- `launchctl list | grep leadresponder` (Mac) / Task Scheduler → `LeadResponder` (Windows) to check autostart.
- `~/.lead-responder/app.log` has stack traces; the dashboard's Activity log and **Needs you** box are the whole picture otherwise.
- Browser automation of CDK is fast to ship but fragile and probably against CDK's terms; the dealer accepts that risk for the pilot. Human-paced typing, one session, 20 s polling. Move to CDK's Fortellis API once there's revenue.
- Per-rep install is the model today: one install per salesperson, each with their own CDK login and name.

## Roadmap

1. CDK mapped and one rep live
2. Momentum CRM adapter (template library, Lead Alerts panel, "New Car 1 - Text")
3. ADF/XML email feed as a sub-minute trigger instead of polling
4. Inventory lookup so "is it still available" is answered truthfully
5. Shared install with per-rep routing
6. Fortellis API adapter and a hosted version for per-seat pricing
