// HTTPS front for the home gateway: only POST /chat, /tts, /stt are passed on; everything else is 404.
// Rate limits per client address, and a client that keeps sending wrong tokens (403) is blocked for a while.
import https from "node:https";
import http from "node:http";
import fs from "node:fs";

const PORT = +process.env.PORT || 18443;
const UP = { host: process.env.UP_HOST || "YOUR_LAN_IP", port: +process.env.UP_PORT || 8787 };
const CERT = process.env.CERT, KEY = process.env.KEY;
const ALLOWED = new Set(["/chat", "/tts", "/stt", "/bot-reply", "/wg/enroll", "/avatar"]);   // /bot-reply: a cloud bot calls back with a one-time token
const MAX_BODY = 2 * 1024 * 1024;          // 60 s of 16 kHz PCM is about 2 MB
const hits = new Map();                    // ip -> { t: [timestamps], bad: n, until: ms }

function client(req) { return req.socket.remoteAddress || "?"; }
function limited(ip) {
  const now = Date.now(), h = hits.get(ip) || { t: [], bad: 0, until: 0 };
  hits.set(ip, h);
  if (now < h.until) return true;
  h.t = h.t.filter((x) => now - x < 60000);
  if (h.t.length >= 60) return true;       // 60 requests a minute is far more than a person talking
  h.t.push(now);
  return false;
}
function reject(ip) {
  const h = hits.get(ip); if (!h) return;
  if (++h.bad >= 10) { h.until = Date.now() + 10 * 60000; h.bad = 0; console.log("blocked", ip); }
}

// Forget addresses that have been quiet for a while, so the table cannot grow for months on scanner traffic.
setInterval(() => {
  const now = Date.now();
  for (const [ip, h] of hits) {
    h.t = h.t.filter((x) => now - x < 60000);
    if (!h.t.length && now > h.until) hits.delete(ip);
  }
}, 10 * 60000).unref();

function ctx() { return { key: fs.readFileSync(KEY), cert: fs.readFileSync(CERT) }; }
const server = https.createServer(ctx(), (req, res) => {
  const ip = client(req);
  let path = (req.url || "").split("?")[0].replace(/\/+$/, "");
  if (path.startsWith("/bot-reply/")) path = "/bot-reply";   // /bot-reply/<id>/<one-time token>
  if (req.method !== "POST" || !ALLOWED.has(path)) {
    console.log(`reject ${req.method} ${(req.url || "").split("?")[0].slice(0, 40)} ip=${client(req).replace(/^::ffff:/, "")}`);
    res.writeHead(404); return res.end("not found");
  }
  if (limited(ip)) { res.writeHead(429); return res.end("slow down"); }
  let size = 0;
  const t0 = Date.now();
  res.on("close", () => console.log(`${path} ${res.statusCode} ${Date.now() - t0}ms in=${size}B ip=${ip.replace(/^::ffff:/, "")}`));   // timing of every turn
  const up = http.request({ ...UP, method: "POST", path: req.url, headers: { ...req.headers, host: UP.host + ":" + UP.port } }, (ur) => {
    if (ur.statusCode === 403) reject(ip);
    res.writeHead(ur.statusCode || 502, ur.headers);
    ur.pipe(res);
  });
  up.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.on("data", (c) => { size += c.length; if (size > MAX_BODY) { req.destroy(); up.destroy(); } });
  req.pipe(up);
});
server.headersTimeout = 15000;
server.listen(PORT, "0.0.0.0", () => console.log("listening", PORT));
// pick up a renewed certificate without a restart
process.on("SIGHUP", () => { try { server.setSecureContext(ctx()); console.log("certificate reloaded"); } catch (e) { console.log("reload failed", String(e)); } });
