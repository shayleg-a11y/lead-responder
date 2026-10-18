// A tiny stand-in for CDK Connect: login page, lead list, lead page with activity + text composer.
// Used by e2e/cdk-adapter.e2e.mjs to exercise the real Playwright adapter without a dealership login.
import http from "node:http";

const leads = {
  "5001": { name: "Maria Lopez", phone: "(949) 555-0100", email: "maria@example.com", vehicle: "2024 Toyota Camry SE", source: "AutoTrader", created: "2 minutes ago", comment: "Is this still available?",
    activity: [{ dir: "Inbound", type: "Email", body: "Is this still available?", at: "Today 10:02 AM" }] },
  "5002": { name: "James Carter", phone: "(949) 555-0101", email: "james@example.com", vehicle: "2023 Honda CR-V EX-L", source: "CarGurus", created: "5 minutes ago", comment: "",
    activity: [] },
};
const sessions = new Set();
const page = (title, body) => `<!doctype html><html><head><title>${title}</title></head><body><header><span id="user-menu">Jordan S.</span></header>${body}</body></html>`;

export function startFakeCdk(port = 4790, opts = {}) {
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const cookie = req.headers.cookie || "";
    const loggedIn = /sid=ok/.test(cookie);
    const send = (html, status = 200, headers = {}) => { res.writeHead(status, { "content-type": "text/html", ...headers }); res.end(html); };
    if (url.pathname === "/login" && req.method === "POST") return send("", 302, { "set-cookie": "sid=ok; Path=/", location: "/leads" });
    if (!loggedIn && opts.autoLogin) return send("", 302, { "set-cookie": "sid=ok; Path=/", location: "/leads" });
    if (!loggedIn) return send(`<!doctype html><html><body><form method="post" action="/login"><input name="u"><input type="password" name="p"><button>Sign in</button></form></body></html>`);
    if (url.pathname === "/" || url.pathname === "/leads") {
      const rows = Object.entries(leads).map(([id, l]) => `<tr class="lead-row" data-lead-id="${id}"><td class="lead-name"><a href="/leads/${id}">${l.name}</a></td><td class="lead-vehicle">${l.vehicle}</td><td class="lead-source">${l.source}</td><td class="lead-created">${l.created}</td></tr>`).join("");
      return send(page("Leads", `<table id="lead-list"><tbody>${rows}</tbody></table>`));
    }
    const m = url.pathname.match(/^\/leads\/(\d+)(\/text)?$/);
    if (m) {
      const l = leads[m[1]];
      if (!l) return send("not found", 404);
      if (m[2] && req.method === "POST") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => { const text = new URLSearchParams(body).get("body") || ""; l.activity.push({ dir: "Outbound", type: "Text Message", body: text, at: "Just now" }); send("", 302, { location: `/leads/${m[1]}` }); });
        return;
      }
      const acts = l.activity.map((a) => `<li class="activity-item"><span class="act-dir">${a.dir}</span> · <span class="act-type">${a.type}</span> · <time class="act-time">${a.at}</time><div class="act-body">${a.body}</div></li>`).join("");
      return send(page(l.name, `<h1 id="lead-name">${l.name}</h1><div id="lead-phone">${l.phone}</div><div id="lead-email">${l.email}</div><div id="lead-vehicle">${l.vehicle}</div><div id="lead-source">${l.source}</div><div id="lead-created">${l.created}</div><p id="lead-comment">${l.comment}</p>
        <ul id="activity">${acts}</ul>
        <button id="btn-text" onclick="document.getElementById('composer').style.display='block'">Send Text</button>
        <form id="composer" style="display:none" method="post" action="/leads/${m[1]}/text"><textarea name="body" id="sms-body"></textarea><button type="submit" id="sms-send">Send</button></form>`));
    }
    send("not found", 404);
  });
  return new Promise((resolve) => srv.listen(port, "127.0.0.1", () => resolve({ srv, leads, port })));
}

export const FAKE_CDK_SELECTORS = {
  mapped: true, version: 1,
  login: { loggedInProbe: ["#user-menu"], loginFormProbe: ["input[type=password]"] },
  leads: { listUrl: "/leads", row: ["tr.lead-row"], rowId: { attr: "data-lead-id", selector: [], fallbackHrefPattern: "/leads/(\\d+)" },
    rowName: [".lead-name"], rowCreated: [".lead-created"], rowSource: [".lead-source"], rowVehicle: [".lead-vehicle"], detailUrl: "/leads/{id}" },
  detail: { name: ["#lead-name"], phone: ["#lead-phone"], email: ["#lead-email"], vehicle: ["#lead-vehicle"], source: ["#lead-source"], comment: ["#lead-comment"], created: ["#lead-created"], stock: [] },
  messages: { item: ["li.activity-item"], body: [".act-body"], time: [".act-time"], inboundMarker: [".act-dir:has-text('Inbound')"], outboundMarker: [".act-dir:has-text('Outbound')"], smsMarker: [".act-type:has-text('Text Message')"], emailMarker: [".act-type:has-text('Email')"] },
  sendText: { openButton: ["#btn-text", "button:has-text('Send Text')"], body: ["#sms-body"], sendButton: ["#sms-send"] },
  sendEmail: { openButton: [], subject: [], body: [], sendButton: [] },
  templates: { url: "", item: [], name: [], body: [] },
};

if (process.argv[1] && process.argv[1].endsWith("fake-cdk-server.mjs")) {
  startFakeCdk().then(({ port }) => console.log(`fake CDK on http://localhost:${port}`));
}
