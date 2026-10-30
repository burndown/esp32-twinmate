// Muse gateway, Cloudflare edition. The gadget firmware makes a few HTTP calls (always with ?k=<GATEWAY_TOKEN>):
//   POST /stt         raw 16 kHz PCM        -> {"text"}            Cloudflare Workers AI (Whisper) or Azure Speech
//   POST /tts         {"text"}              -> MP3 (16 kHz)        Azure Speech
//   POST /chat        {"text","away"}       -> streamed text       a Webhook bot (the "Grok Bot"); anything else is for Muse itself
//   POST /bot-reply/<id>/<token>            the bot's answer (one-time token, no gateway token)
//   POST /wg/enroll, GET /wg/peers          a device asks for a WireGuard tunnel; a person approves it on the server
//   POST /avatar, /avatar/set               the picture for the round screen
//   GET /badge/list, /badge/<n>             the badge pictures the device copies into its badge partition (device token)
//   POST /badge/set?n=N, /badge/delete?n=N  put or remove one (admin token); the admin page does it from the browser
//   GET  /admin                             the settings page (static; the page sends the admin token in a header)
// Two tokens: GATEWAY_TOKEN (devices) and ADMIN_TOKEN (the settings page, /wg/peers, /avatar/set, /health).
// Limits: /stt 2 MB, /tts 600 characters, /chat 1000 characters, avatar 120 KB (413 beyond that).
// Settings live in KV (key "config"), keys in KV (key "secrets"); Worker secrets with the upper-case names also work.
import adminHtml from "./admin.html";

const DEFAULTS = {
  asr: { provider: "cloudflare", language: "zh-CN" },
  tts: { voice: "zh-CN-XiaoxiaoMultilingualNeural", region: "eastasia" },
  bot: { callback_base: "", mode: "auto" },   // mode: "auto" (the bot answers when the device says it is away), "always", "off"
  wg: { server_pub: "", endpoint: "", port: 51820, subnet: "10.77.0." },
};
// A gadget can override these parts of the settings (KV "devcfg:<id>"); what it does not override follows the global values.
// callback_base belongs to the deployment, so for the bot only "mode" can be overridden.
const DEV_SECTIONS = ["asr", "tts", "bot"];
const DEV_FIELDS = { asr: ["provider", "language"], tts: ["voice", "region"], bot: ["mode"] };
const SECRET_ENV = { azure_key: "AZURE_SPEECH_KEY", grokbot_url: "GROKBOT_URL", grokbot_auth: "GROKBOT_AUTH" };
const ENV_CONFIG = { "wg.server_pub": "WG_SERVER_PUB", "wg.endpoint": "WG_ENDPOINT", "wg.port": "WG_PORT", "wg.subnet": "WG_SUBNET" };

async function devCfgGet(env, d) {
  const v = d && env.CFG ? await env.CFG.get("devcfg:" + d, "json").catch(() => null) : null;
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}
// d: a gadget's id, when the call is its own (or the settings page looks at one): its overrides go on top of the global settings.
async function loadAll(env, d) {
  let over = null, sec = null;
  try { over = env.CFG ? await env.CFG.get("config", "json") : null; } catch (e) { /* defaults */ }
  try { sec = env.CFG ? await env.CFG.get("secrets", "json") : null; } catch (e) { /* env only */ }
  const cfg = {};
  for (const k of Object.keys(DEFAULTS)) cfg[k] = { ...DEFAULTS[k], ...((over || {})[k] || {}) };
  for (const [path, name] of Object.entries(ENV_CONFIG)) {
    const [sect, field] = path.split(".");
    if (!(over && over[sect] && over[sect][field]) && env[name]) cfg[sect][field] = field === "port" ? +env[name] : env[name];
  }
  const S = {};
  for (const [name, envName] of Object.entries(SECRET_ENV)) S[name] = (sec && sec[name]) || env[envName] || "";
  const global = JSON.parse(JSON.stringify(cfg));
  const dev = await devCfgGet(env, d);
  for (const k of DEV_SECTIONS) if (dev[k]) cfg[k] = { ...cfg[k], ...dev[k] };
  return { cfg, S, global, dev, stored: sec || {}, over: over || {}, AI: env.AI || null };   // AI: the Workers AI binding of this request ([ai] binding = "AI" in wrangler.toml)
}

const text = (s, status = 200, type = "text/plain; charset=utf-8") => new Response(s, { status, headers: { "content-type": type } });
const json = (o, status = 200) => text(JSON.stringify(o), status, "application/json");

// ---- limits and checks (a device token must not be a way to burn quotas or to aim the keys elsewhere) ------------------
const MAX_PCM = 2 * 1024 * 1024;     // 60 s of 16 kHz PCM is 1.9 MB, which is also the most Azure takes
const MAX_TTS_CHARS = 600;           // the firmware sends at most 480 bytes at a time
const MAX_CHAT_CHARS = 1000;
const MAX_AVATAR = 120 * 1024;       // 233x233 RGB565 is 108 KB
const MAX_BADGES = 9;                // the badge partition holds 4 MB in slots of 0x70000 bytes
const MAX_BADGE = 0x70000;           // 466 x 466 RGB565 plus the 16-byte header fits one slot
// Tunnel addresses 2..9 are left for devices whose address is written into the firmware (muse-cloud.toml [wireguard] address,
// tools/make-wg-config.py), which the registry does not know about; the registry hands out 10 and up.
const FIRST_DYNAMIC = 10;
const MAX_PENDING_PEERS = 20;        // device keys that asked for a tunnel and nobody has approved yet
const tooLarge = () => json({ error: "too large" }, 413);
// A /chat reply is plain text that gets spoken. When the bot fails, the rest of the reply is not an answer: it starts with this
// control character, followed by a short code (bot_timeout, bot_unreachable); the firmware shows an error instead of speaking it.
const ERR = "\u0001";

// ---- two tokens --------------------------------------------------------------------------------------------
// GATEWAY_TOKEN is in every device's firmware (whoever holds a device holds it) and opens only what a device needs.
// ADMIN_TOKEN stays in your browser and opens the settings page and the other management routes. Without ADMIN_TOKEN the device
// token still opens them (an old deployment keeps working) and the settings page says so.
const isAdminPath = (p) => p.startsWith("/admin") || p === "/wg/peers" || p === "/avatar/set" || p === "/avatar/view" || p === "/avatar/delete" || p === "/health" || p === "/badge/set" || p === "/badge/delete";
const givenToken = (req, url) => url.searchParams.get("k") || (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");

// The values the settings page and the per-device overrides may store. Empty means "not set" (the default or the environment applies).
const VOICE_RE = /^[A-Za-z0-9:-]{3,80}$/;
const LANG_RE = /^(auto|[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?)$/;
const B64KEY_RE = /^[A-Za-z0-9+/]{43}=$/;
const HOST_RE = /^[A-Za-z0-9.:-]{1,253}$/;
const SUBNET_RE = /^(\d{1,3}\.){3}$/;
function checkSetting(sect, f, v) {
  if (v === "" || v == null) return;
  const bad = () => { throw new Error("bad value for " + sect + "." + f); };
  if (sect === "asr" && f === "provider" && !["cloudflare", "azure"].includes(v)) bad();
  if (sect === "asr" && f === "language" && !(typeof v === "string" && LANG_RE.test(v))) bad();
  if (sect === "tts" && f === "voice" && !(typeof v === "string" && VOICE_RE.test(v))) bad();
  if (sect === "wg" && f === "server_pub" && !(typeof v === "string" && B64KEY_RE.test(v))) bad();
  if (sect === "wg" && f === "endpoint" && !(typeof v === "string" && HOST_RE.test(v))) bad();
  if (sect === "wg" && f === "subnet" && !(typeof v === "string" && SUBNET_RE.test(v) && v.split(".").slice(0, 3).every((x) => +x <= 255))) bad();
  if (sect === "wg" && f === "port" && !(Number.isInteger(+v) && +v >= 1 && +v <= 65535)) bad();
}

// Azure Speech host for a region name ("eastasia"), or a full "<region>.tts.speech.microsoft.com" / ".azure.cn" host; nothing else,
// because the Azure key travels with the request.
function azureHost(region, svc) {
  const r = String(region || "eastasia").toLowerCase();
  if (/^[a-z0-9]{3,30}$/.test(r)) return `${r}.${svc}.speech.microsoft.com`;
  const m = r.match(/^([a-z0-9]{3,30})\.(?:tts|stt)\.speech\.(microsoft\.com|azure\.cn)$/);
  if (m) return `${m[1]}.${svc}.speech.${m[2]}`;
  throw new Error("bad Azure region");
}
// The bot's webhook and callback addresses must be https on a public-looking host; the bot's credentials go there.
function checkHttpsUrl(s) {
  let u;
  try { u = new URL(String(s)); } catch (e) { throw new Error("not a URL"); }
  const h = u.hostname;
  if (u.protocol !== "https:" || !h.includes(".") || h.includes(":") || /^[\d.]+$/.test(h) || /(^|\.)(localhost|local|internal|lan|home|test|invalid)$/i.test(h)) throw new Error("only https addresses on a public host name are accepted");
  return u.href;
}
async function sha256(s) { return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))); }
async function safeEq(a, b) { return crypto.subtle.timingSafeEqual(await sha256(a), await sha256(b)); }
// A bot-reply id is 16 random hex digits followed by 16 digits of HMAC(random, gateway token): a forged callback is refused before
// any storage is touched.
async function hmac16(env, data) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.GATEWAY_TOKEN || ""), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data))).slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function signedId(env) { const r = hex(8); return r + (await hmac16(env, r)); }
async function idValid(env, id) { return /^[0-9a-f]{32}$/.test(id) && (await safeEq(await hmac16(env, id.slice(0, 16)), id.slice(16))); }

function b64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function wav(pcm, rate) {
  const h = new DataView(new ArrayBuffer(44));
  const w = (o, s) => [...s].forEach((c, i) => h.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); h.setUint32(4, 36 + pcm.length, true); w(8, "WAVEfmt ");
  h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 1, true);
  h.setUint32(24, rate, true); h.setUint32(28, rate * 2, true); h.setUint16(32, 2, true); h.setUint16(34, 16, true);
  w(36, "data"); h.setUint32(40, pcm.length, true);
  const out = new Uint8Array(44 + pcm.length);
  out.set(new Uint8Array(h.buffer), 0); out.set(pcm, 44);
  return out;
}

// ---- speech recognition ------------------------------------------------------------------------------
// audio: WAV bytes (16 kHz mono PCM). Returns the recognised text ("" for silence).
const LOCALES = { zh: "zh-CN", en: "en-US", ja: "ja-JP", ko: "ko-KR", fr: "fr-FR", de: "de-DE", es: "es-ES" };
// Root mean square of the 16-bit samples of a WAV (after its 44-byte header).
function rms16(wavBytes) {
  const v = new DataView(wavBytes.buffer, wavBytes.byteOffset + 44, ((wavBytes.length - 44) >> 1) << 1);
  let sum = 0; const n = v.byteLength >> 1;
  for (let i = 0; i < n; i++) { const x = v.getInt16(i * 2, true); sum += x * x; }
  return n ? Math.sqrt(sum / n) : 0;
}
// Whisper invents subtitle credits for silence or noise; these are what it says.
const WHISPER_GHOSTS = /字幕|志愿者|点赞|订阅|谢谢观看|感谢观看|Thanks for watching|Subtitles by/i;

async function recognise(cfg, S, audio, AI) {
  const A = cfg.asr;
  if (A.provider === "azure") {
    // Azure Speech short-audio REST API (60 s at most): the same resource, key and region as speech synthesis.
    if (!S.azure_key) throw new Error("Azure Speech key not set");
    const host = azureHost(cfg.tts.region, "stt");
    const r = await fetch(`https://${host}/speech/recognition/conversation/cognitiveservices/v1?language=${encodeURIComponent(LOCALES[A.language] || A.language || "zh-CN")}&format=simple`, {
      method: "POST",
      headers: { "Ocp-Apim-Subscription-Key": S.azure_key, "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000", Accept: "application/json" },
      body: audio });
    if (!r.ok) throw new Error("azure asr http " + r.status);
    const d = await r.json();
    if (d.RecognitionStatus === "NoMatch" || d.RecognitionStatus === "InitialSilenceTimeout") return "";
    if (d.RecognitionStatus !== "Success") throw new Error("azure asr " + d.RecognitionStatus);
    return (d.DisplayText || "").trim();
  }
  // Cloudflare Workers AI: Whisper large-v3-turbo, free allowance of 10,000 neurons a day (about 200 audio minutes), no key.
  if (!AI) throw new Error('Workers AI binding missing: add [ai] binding = "AI" to wrangler.toml and deploy');
  if (rms16(audio) < 100) return "";   // a silent recording: Whisper would make something up
  const args = { audio: b64(audio) };
  const lang = (A.language || "zh-CN").split("-")[0];
  if (lang !== "auto") args.language = lang;
  const r = await AI.run("@cf/openai/whisper-large-v3-turbo", args);
  const out = (r.text || "").trim();
  return WHISPER_GHOSTS.test(out) && out.length < 30 ? "" : out;
}

async function stt(req, env, all) {
  if ((+req.headers.get("content-length") || 0) > MAX_PCM) return tooLarge();
  const pcm = new Uint8Array(await req.arrayBuffer());
  if (pcm.length > MAX_PCM) return tooLarge();
  const rate = parseInt(req.headers.get("x-sample-rate") || "16000", 10);
  if (pcm.length < 3200) return json({ text: "" });           // under 0.1 s: nothing to recognise
  try { return json({ text: await recognise(all.cfg, all.S, wav(pcm, rate), all.AI) }); }
  catch (e) { console.log("asr", String(e).slice(0, 200)); return json({ error: String(e).slice(0, 200) }, 502); }
}

// ---- speech synthesis (Azure) -------------------------------------------------------------------------
function splitText(t, [minLen, maxLen] = [30, 110]) {
  // Cut after every stop or comma, then merge small pieces: Azure sounds better on whole sentences.
  const raw = t.replace(/\s+/g, " ").match(/[^。！？!?；;，,、\n]+[。！？!?；;，,、]*/g) || [t];
  const out = [];
  let cur = "";
  for (const piece of raw) {
    if (cur && cur.length + piece.length > maxLen) { out.push(cur.trim()); cur = ""; }
    cur += piece;
    if (cur.length >= minLen) { out.push(cur.trim()); cur = ""; }
  }
  if (cur.trim()) { if (out.length && cur.length < 6) out[out.length - 1] += cur; else out.push(cur.trim()); }
  return out.filter((x) => x.length);
}
function stripId3(b) {
  if (b.length > 10 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) {
    const n = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
    return b.subarray(10 + n);
  }
  return b;
}
const xmlEsc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function synthAzure(cfg, S, t, fmt = "audio-16khz-128kbitrate-mono-mp3") {
  if (!S.azure_key) throw new Error("Azure Speech key not set");
  const T = cfg.tts, voice = T.voice || "zh-CN-XiaoxiaoMultilingualNeural";
  if (!VOICE_RE.test(voice)) throw new Error("bad voice name");   // it goes into the SSML below
  const host = azureHost(T.region, "tts");
  const lang = voice.split("-").slice(0, 2).join("-");
  const r = await fetch(`https://${host}/cognitiveservices/v1`, {
    method: "POST",
    headers: { "Ocp-Apim-Subscription-Key": S.azure_key, "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": fmt, "User-Agent": "muse-gateway" },
    body: `<speak version='1.0' xml:lang='${lang}'><voice name='${voice}'>${xmlEsc(t)}</voice></speak>`,
  });
  if (!r.ok) throw new Error("azure tts http " + r.status + " " + (await r.text().catch(() => "")).slice(0, 120));
  const out = new Uint8Array(await r.arrayBuffer());
  if (!out.length) throw new Error("no audio");
  return out;
}

async function synthAll(cfg, S, t) {
  const pieces = splitText(t);
  const results = new Array(pieces.length);
  let next = 0;
  // Azure answers 429 to short bursts (the free tier allows few concurrent requests): back off and retry.
  const withRetry = async (piece) => {
    for (let attempt = 0; ; attempt++) {
      try { return await synthAzure(cfg, S, piece); }
      catch (e) {
        if (attempt >= 3 || !/429|rate|quota|limit/i.test(String(e))) throw e;
        await new Promise((r) => setTimeout(r, 350 * 2 ** attempt));
      }
    }
  };
  const worker = async () => { while (next < pieces.length) { const i = next++; results[i] = await withRetry(pieces[i]); } };
  await Promise.all(Array.from({ length: Math.min(3, pieces.length) }, worker));
  const bodies = results.map((r, i) => (i ? stripId3(r) : r));
  const out = new Uint8Array(bodies.reduce((n, b) => n + b.length, 0)); let o = 0;
  for (const b of bodies) { out.set(b, o); o += b.length; }
  return { audio: out, parts: pieces.length };
}

async function tts(req, env, all) {
  const { text: t } = await req.json().catch(() => ({}));
  if (!t || typeof t !== "string") return json({ error: "no text" }, 400);
  if (t.length > MAX_TTS_CHARS) return tooLarge();
  try {
    const { audio, parts } = await synthAll(all.cfg, all.S, t);
    return new Response(audio, { headers: { "content-type": "audio/mpeg", "x-parts": String(parts) } });
  } catch (e) {
    console.log("tts failed", String(e).slice(0, 200));
    return json({ error: "tts failed", detail: String(e).slice(0, 200) }, 502);
  }
}

// ---- Grok Bot (a Webhook bot) ----------------------------------------------------------------------------
// A cloud agent that takes a webhook and answers later (30 s to a few minutes). The device speaks an acknowledgement at once,
// the gateway keeps the response open, the bot POSTs its answer to /bot-reply with a one-time token, and the answer is streamed on.
const BOT_WAIT_MS = 300000;   // 5 minutes; the firmware gives the HTTP read 330 s (timeout_ms in firmware/muse-cloud.patch), so the bot_timeout marker below arrives first
function hex(n) { return [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join(""); }

// The callback host's real address from a public resolver: some bots sit behind a DNS that answers with a fake 198.18.x.x.
let dohCache = { host: "", ip: "", at: 0 };
async function realIp(host) {
  if (dohCache.host === host && Date.now() - dohCache.at < 300000) return dohCache.ip;
  try {
    const r = await fetch("https://cloudflare-dns.com/dns-query?name=" + encodeURIComponent(host) + "&type=A", { headers: { accept: "application/dns-json" } });
    const ip = ((await r.json()).Answer || []).find((a) => a.type === 1)?.data || "";
    dohCache = { host, ip, at: Date.now() };
    return ip;
  } catch (e) { return ""; }
}

// The state of one question: a Durable Object (strongly consistent; KV would delay the answer by up to a minute). Without the
// BOT binding it falls back to a KV key that is polled.
export class BotWait {
  constructor(state) { this.state = state; this.waiters = []; }
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const b = await req.json().catch(() => ({}));
    const v = (await this.state.storage.get("v")) || null;
    if (path === "/init") {
      await this.state.storage.put("v", { tok: b.tok, text: null });
      await this.state.storage.setAlarm(Date.now() + 600000);   // forgotten after 10 minutes
      return new Response("ok");
    }
    if (path === "/reply") {
      if (!v || v.tok !== b.tok || v.text) return new Response("no", { status: 403 });
      await this.state.storage.put("v", { tok: v.tok, text: String(b.text) });
      for (const w of this.waiters.splice(0)) w();
      return new Response("ok");
    }
    if (path === "/wait") {
      if (!v) return Response.json({ text: null, gone: true });
      if (!v.text) await new Promise((res) => { this.waiters.push(res); setTimeout(res, Math.min(+b.ms || 30000, 60000)); });
      const w = (await this.state.storage.get("v")) || {};
      return Response.json({ text: w.text || null });
    }
    if (path === "/done") { await this.state.storage.deleteAll(); return new Response("ok"); }
    return new Response("not found", { status: 404 });
  }
  async alarm() { await this.state.storage.deleteAll(); }
}
const doCall = (env, id, path, body) => env.BOT.get(env.BOT.idFromName(id)).fetch("https://bot/" + path, { method: "POST", body: JSON.stringify(body || {}) });

async function botInit(env, id, tok) {
  if (env.BOT) await doCall(env, id, "init", { tok });
  else await env.CFG.put("bot:" + id, JSON.stringify({ tok, text: null }), { expirationTtl: 600 });
}
// stop: {done: true} ends the wait early (the caller gave up, or the client hung up); a question whose state is gone (expired or never
// stored) ends it too, instead of asking again and again until the time is up.
async function botWait(env, id, ms, stop = {}) {
  const until = Date.now() + ms;
  while (Date.now() < until && !stop.done) {
    if (env.BOT) {
      const r = await doCall(env, id, "wait", { ms: Math.min(until - Date.now(), 30000) });
      const j = await r.json().catch(() => ({}));
      if (j.text) { await doCall(env, id, "done"); return j.text; }
      if (j.gone) return null;
    } else {
      await new Promise((r) => setTimeout(r, 1500));
      const v = await env.CFG.get("bot:" + id, "json").catch(() => null);
      if (v && v.text) { await env.CFG.delete("bot:" + id); return v.text; }
      if (!v) return null;
    }
  }
  return null;
}
async function botSet(env, id, tok, reply) {
  if (env.BOT) return (await doCall(env, id, "reply", { tok, text: reply })).ok;
  const v = await env.CFG.get("bot:" + id, "json").catch(() => null);
  if (!v || v.tok !== tok || v.text) return false;
  await env.CFG.put("bot:" + id, JSON.stringify({ tok: v.tok, text: reply }), { expirationTtl: 600 });
  return true;
}

// Sends the question to the bot and returns a function that waits for the answer. Throws when the bot cannot be reached.
async function botAsk(req, env, all, ask) {
  const { grokbot_url: url, grokbot_auth: authRaw } = all.S;
  if (!url || !authRaw) throw new Error("Grok Bot not set up");
  const hook = checkHttpsUrl(url);
  const id = await signedId(env), tok = hex(16);
  await botInit(env, id, tok);
  const origin = all.cfg.bot.callback_base ? new URL(checkHttpsUrl(all.cfg.bot.callback_base)).origin : new URL(req.url).origin;
  const host = new URL(origin).hostname, port = new URL(origin).port || "443";
  const ip = await realIp(host);
  const hint = ip ? " 如果这个域名在你那里被解析成 198.18.x.x 之类的假地址，请改用真实地址：curl --resolve " + host + ":" + port + ":" + ip + " ，仍然使用上面的域名和 https。" : "";
  const message = ask + "\n\n（这是桌上小圆屏设备的语音提问。请用中文纯文本简短回答，不要 Markdown。回答好以后，请用 HTTP POST 把答案发到 "
    + origin + "/bot-reply/" + id + "/" + tok + " ，请求头 Content-Type: application/json，请求体 {\"reply\":\"你的回答\"}。请逐字使用这个地址（里面没有问号和 & 符号）。这个地址只用一次，10 分钟内有效，不需要任何密钥或其他请求头。" + hint + "）";
  const auth = /^bearer\s/i.test(authRaw) ? authRaw : "Bearer " + authRaw;
  const r = await fetch(hook, { method: "POST", headers: { Authorization: auth, "content-type": "application/json" }, body: JSON.stringify({ message }), signal: AbortSignal.timeout(20000) });
  console.log("bot webhook", r.status);
  if (!r.ok) throw new Error("the bot answered HTTP " + r.status);
  return (stop) => botWait(env, id, BOT_WAIT_MS, stop);
}

// /chat: with "away" the question goes to the bot; anything else is for Muse itself (the firmware asks Muse when this says so).
// The gadget's bot mode changes that: "always" sends every question to the bot, "off" never does.
async function chat(req, env, all) {
  const { text: userText, away } = await req.json().catch(() => ({}));
  if (!userText || typeof userText !== "string") return json({ error: "no text" }, 400);
  if (userText.length > MAX_CHAT_CHARS) return tooLarge();
  const mode = all.cfg.bot.mode;
  if (mode === "off" || !(away || mode === "always")) return json({ muse: true }, 503);
  const enc = new TextEncoder();
  const stop = { done: false };   // set when the device hangs up: the wait for the bot ends with it
  return new Response(new ReadableStream({
    async start(ctl) {
      const say = (t) => { if (stop.done) return; try { ctl.enqueue(enc.encode(t)); } catch (e) { stop.done = true; } };
      say("收到，我去问小黑，请稍等。");   // heard at once, before the Webhook
      try {
        const wait = await botAsk(req, env, all, userText);
        const answer = await wait(stop);
        say(answer ? "\n" + answer.replace(/[*#`]+/g, "") : ERR + "bot_timeout");
      } catch (e) { console.log("bot", String(e).slice(0, 150)); say(ERR + "bot_unreachable"); }
      try { ctl.close(); } catch (e) { /* already closed */ }
    },
    cancel() { stop.done = true; },
  }), { headers: { "content-type": "text/plain; charset=utf-8" } });
}

async function botReply(req, env, url) {
  if (req.method !== "POST") return text("method", 405);
  // The one-time token is in the path (/bot-reply/<id>/<token>), which no HTML escaping can touch; the older
  // ?id=&t= form still works, including when a webhook turned "&" into "&amp;" and the parameter became "amp;t".
  const seg = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean).slice(1);
  const id = seg[0] || url.searchParams.get("id") || "";
  const t = seg[1] || url.searchParams.get("t") || url.searchParams.get("amp;t") || "";
  if (!(await idValid(env, id))) return text("forbidden", 403);   // forged ids never reach storage
  const b = await req.json().catch(() => null);
  const reply = (b && (b.text || b.reply || b.message) || "").toString().slice(0, 4000);
  if (!reply.trim()) return json({ error: "no text" }, 400);
  if (!(await botSet(env, id, t, reply))) return text("forbidden", 403);
  return json({ ok: true });
}

// ---- WireGuard enrolment -----------------------------------------------------------------------------
// The device makes its own key pair and POSTs the public key here. It gets back the server's public key, the endpoint and a
// tunnel address; nothing works until a person adds the key on the WireGuard server (the settings page lists the keys that asked,
// with the `wg set` line to run, and marks them approved or revokes them). The registry is a Durable Object so that concurrent
// requests cannot hand out the same address; keys nobody approved within a week are forgotten, and at most MAX_PENDING_PEERS can
// wait at once, so stray requests cannot use up the address pool.
export class WgRegistry {
  constructor(state) { this.state = state; }
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const b = await req.json().catch(() => ({}));
    const peers = (await this.state.storage.get("peers")) || {};
    if (path === "/enroll") {
      let p = peers[b.pub];
      if (!p) {
        const waiting = Object.entries(peers).filter(([, x]) => !x.ok);
        if (waiting.length >= MAX_PENDING_PEERS) {
          // The oldest unapproved request makes room once it is a day old; a flood of fresh ones still gets 429 and cannot push out
          // approved keys, and the owner can revoke the made-up ones on the settings page.
          const [oldKey, old] = waiting.sort((a, c) => Date.parse(a[1].at) - Date.parse(c[1].at))[0];
          if (Date.now() - Date.parse(old.at) < 86400000) return Response.json({ error: "too many waiting" }, { status: 429 });
          delete peers[oldKey];
        }
        const used = new Set(Object.values(peers).map((x) => x.n));
        let n = FIRST_DYNAMIC;
        while (used.has(n) && n <= 250) n++;
        if (n > 250) return Response.json({ error: "no addresses left" }, { status: 507 });
        p = peers[b.pub] = { n, at: new Date().toISOString(), ok: false };
        await this.state.storage.put("peers", peers);
        await this.state.storage.setAlarm(Date.now() + 86400000);
      }
      return Response.json({ n: p.n });
    }
    if (path === "/list") return Response.json({ peers });
    if (path === "/label") {
      if (!peers[b.pub]) return Response.json({ error: "unknown key" }, { status: 404 });
      peers[b.pub].label = String(b.label || "").trim().slice(0, 40);
      await this.state.storage.put("peers", peers);
      return Response.json({ ok: true });
    }
    if (path === "/approve" || path === "/revoke") {
      if (!peers[b.pub]) return Response.json({ error: "unknown key" }, { status: 404 });
      if (path === "/approve") peers[b.pub].ok = true; else delete peers[b.pub];
      await this.state.storage.put("peers", peers);
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  }
  async alarm() {
    const peers = (await this.state.storage.get("peers")) || {};
    let waiting = false;
    for (const [k, p] of Object.entries(peers)) {
      if (p.ok) continue;
      if (Date.now() - Date.parse(p.at) > 7 * 86400000) delete peers[k]; else waiting = true;
    }
    await this.state.storage.put("peers", peers);
    if (waiting) await this.state.storage.setAlarm(Date.now() + 86400000);
  }
}
const reg = (env, path, body) => env.WG.get(env.WG.idFromName("registry")).fetch("https://wg/" + path, { method: "POST", body: JSON.stringify(body || {}) });

async function wgEnroll(req, env, all) {
  const W = all.cfg.wg;
  if (!env.WG) return json({ error: "the WG Durable Object is not bound (see wrangler.toml)" }, 503);
  if (!W.server_pub || !W.endpoint) return json({ error: "wireguard not set up" }, 503);
  const { pub } = await req.json().catch(() => ({}));
  if (typeof pub !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(pub)) return json({ error: "bad key" }, 400);
  const r = await reg(env, "enroll", { pub });
  if (!r.ok) return json(await r.json().catch(() => ({ error: "registry" })), r.status);
  const { n } = await r.json();
  return json({ server_pub: W.server_pub, endpoint: W.endpoint, port: W.port || 51820, address: W.subnet + n, netmask: "255.255.255.0", keepalive: 25,
    now: Math.floor(Date.now() / 1000) });
}
async function wgList(env, W) {
  if (!env.WG) return [];
  const { peers } = await (await reg(env, "list")).json();
  return Object.entries(peers).sort((a, b) => a[1].n - b[1].n).map(([pub, p]) => ({ pub, n: p.n, ip: W.subnet + p.n, at: p.at, ok: !!p.ok, label: p.label || "", cmd: `sudo wg set wg0 peer '${pub}' allowed-ips ${W.subnet}${p.n}/32` }));
}
// What goes into the WireGuard server's wg0.conf for a peer, and a client config for the same peer. A key pair the device made
// itself has its private key only on the device, so the client text has a placeholder where the private key goes.
function wgServerBlock(p) {
  return `[Peer]\n# ${p.label || "device"}\nPublicKey = ${p.pub}\nAllowedIPs = ${p.ip}/32\n`;
}
function wgClientConf(W, p) {
  const ep = W.endpoint.includes(":") ? `[${W.endpoint}]` : W.endpoint;
  return `[Interface]\nPrivateKey = <this device's private key>\nAddress = ${p.ip}/24\n\n[Peer]\nPublicKey = ${W.server_pub}\nEndpoint = ${ep}:${W.port}\n` +
    `AllowedIPs = ${W.subnet}0/24\nPersistentKeepalive = 25\n`;
}

// ---- devices, avatar and badge pictures ---------------------------------------------------------------
// Several gadgets can use one gateway, each with its own avatar and badge pictures. A gadget names itself with `d=<node id>`
// ("homelink-" and six hex digits) on the calls below; a call without a valid `d` is the older single set, kept as it was.
// The first time a gadget asks, and only after its token was checked, it is entered in the list `devices` (at most MAX_DEVICES;
// the settings page can rename it). KV keys: "devices" = {id: {name, first_seen, last_seen}}, and per gadget "avatar:<d>",
// "badges:<d>" (a JSON list [{n, v, w, h, bytes}]) and "badge:<d>:<n>"; the older set is "avatar", "badges", "badge:<n>".
const DEVICE_RE = /^homelink-[0-9a-f]{6}$/;
const MAX_DEVICES = 8;
const SEEN_EVERY = 600;   // seconds: a gadget's last_seen is written at most this often (KV writes are rate-limited)
const devParam = (url) => { const d = url.searchParams.get("d") || ""; return DEVICE_RE.test(d) ? d : ""; };
const kAvatar = (d) => (d ? "avatar:" + d : "avatar");
const kBadges = (d) => (d ? "badges:" + d : "badges");
const kBadge = (d, n) => (d ? "badge:" + d + ":" + n : "badge:" + n);

async function devicesGet(env) {
  const v = env.CFG ? await env.CFG.get("devices", "json").catch(() => null) : null;
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}
// A gadget the owner has not touched (never renamed, no tunnel key, not blocked, no picture or settings saved from the settings page)
// may be pushed out of a full list by a newcomer: the device token is in every firmware, so anyone holding one could otherwise fill
// the list with made-up ids and keep real gadgets out. Gadgets the owner worked on ("kept") are never pushed out.
const isKept = (d, e) => !!(e.kept || e.blocked || e.wg_pub || (e.name && e.name !== "Device " + d.slice(-6)));
async function markKept(env, d) {
  if (!d || !env.CFG) return;
  const devs = await devicesGet(env);
  if (devs[d] && !devs[d].kept) { devs[d].kept = true; await env.CFG.put("devices", JSON.stringify(devs)); }
}
async function deviceSeen(env, d) {
  if (!d || !env.CFG) return;
  const devs = await devicesGet(env);
  const now = Math.floor(Date.now() / 1000);
  const e = devs[d];
  if (!e) {
    if (Object.keys(devs).length >= MAX_DEVICES) {
      const idle = Object.entries(devs).filter(([k, x]) => !isKept(k, x)).sort((a, b) => (a[1].last_seen || 0) - (b[1].last_seen || 0))[0];
      if (!idle) return;
      delete devs[idle[0]];
    }
    devs[d] = { name: "Device " + d.slice(-6), first_seen: now, last_seen: now };
  } else if (now - (e.last_seen || 0) < SEEN_EVERY) {
    return;
  } else {
    e.last_seen = now;
  }
  await env.CFG.put("devices", JSON.stringify(devs));
}
// For the settings page: a gadget it names must be one in the list.
async function knownDevice(env, d) {
  return !d || d in (await devicesGet(env));
}

// ---- avatar picture
// One picture for the round screen: 16-byte header ("MAV1", width, height, byte count) + RGB565 pixels (tools/make-avatar-img.py).
async function avatarGet(env, url, asDevice) {
  const d = devParam(url);
  if (asDevice) await deviceSeen(env, d);
  const b = env.CFG && (await env.CFG.get(kAvatar(d), "arrayBuffer"));
  if (!b) return json({ error: "no picture" }, 404);
  return new Response(b, { headers: { "content-type": "application/octet-stream", "content-length": String(b.byteLength) } });
}
async function avatarSet(req, env, url) {
  const d = devParam(url);
  if (!(await knownDevice(env, d))) return json({ error: "unknown device" }, 404);
  if ((+req.headers.get("content-length") || 0) > MAX_AVATAR) return tooLarge();
  const b = await req.arrayBuffer();
  if (b.byteLength > MAX_AVATAR) return tooLarge();
  const v = new DataView(b);
  if (b.byteLength < 16 || v.getUint32(0, true) !== 0x3156414d) return json({ error: "not a MAV1 picture" }, 400);
  const w = v.getUint16(4, true), h = v.getUint16(6, true), n = v.getUint32(8, true);
  if (w > 240 || h > 240 || n !== w * h * 2 || b.byteLength !== 16 + n) return json({ error: "bad size" }, 400);
  await env.CFG.put(kAvatar(d), b);
  await markKept(env, d);
  return json({ ok: true, w, h, bytes: n });
}
// The settings page shows and removes the picture (admin token); the device asks with POST /avatar (device token).
async function avatarView(env, url) {
  return await avatarGet(env, url, false);
}
async function avatarDelete(env, url) {
  const d = devParam(url);
  if (!(await knownDevice(env, d))) return json({ error: "unknown device" }, 404);
  await env.CFG.delete(kAvatar(d));
  return json({ ok: true });
}

// ---- badge pictures
// Up to MAX_BADGES full-screen pictures. Each is stored as the exact bytes the device keeps in a badge slot: a 16-byte header
// ("MBG1", width, height, byte count, version) + RGB565 little-endian pixels. The browser makes them (settings page), so nothing
// here needs an image library. The version is a number the Worker puts in the header's last four bytes when the picture is stored;
// the device copies a picture again only when its version differs from the one in its slot.
async function badgeIndex(env, d) {
  const l = env.CFG ? await env.CFG.get(kBadges(d), "json").catch(() => null) : null;
  return Array.isArray(l) ? l : [];
}
async function badgeList(env, url, asDevice) {
  const d = devParam(url);
  if (asDevice) await deviceSeen(env, d);
  return json({ items: await badgeIndex(env, d) });
}
async function badgeGet(env, url, n, asDevice) {
  const d = devParam(url);
  if (!Number.isInteger(n) || n < 0 || n >= MAX_BADGES) return json({ error: "no such picture" }, 404);
  if (asDevice) await deviceSeen(env, d);
  const b = env.CFG && (await env.CFG.get(kBadge(d, n), "arrayBuffer"));
  if (!b) return json({ error: "no such picture" }, 404);
  return new Response(b, { headers: { "content-type": "application/octet-stream", "content-length": String(b.byteLength) } });
}
async function badgeSet(req, env, url) {
  const d = devParam(url);
  if (!(await knownDevice(env, d))) return json({ error: "unknown device" }, 404);
  const n = parseInt(url.searchParams.get("n"), 10);
  if (!Number.isInteger(n) || n < 0 || n >= MAX_BADGES) return json({ error: "n must be 0.." + (MAX_BADGES - 1) }, 400);
  if ((+req.headers.get("content-length") || 0) > MAX_BADGE) return tooLarge();
  const b = await req.arrayBuffer();
  if (b.byteLength > MAX_BADGE) return tooLarge();
  const v = new DataView(b);
  if (b.byteLength < 16 || v.getUint32(0, true) !== 0x3147424d) return json({ error: "not an MBG1 picture" }, 400);
  const w = v.getUint16(4, true), h = v.getUint16(6, true), bytes = v.getUint32(8, true);
  if (w < 16 || h < 16 || w > 466 || h > 466 || bytes !== w * h * 2 || b.byteLength !== 16 + bytes) return json({ error: "bad size" }, 400);
  const items = (await badgeIndex(env, d)).filter((x) => x.n !== n);
  const ver = (Date.now() / 1000) >>> 0 || 1;   // seconds since 1970: changes whenever the picture is stored again
  v.setUint32(12, ver, true);
  await env.CFG.put(kBadge(d, n), b);
  items.push({ n, v: ver, w, h, bytes });
  items.sort((a, c) => a.n - c.n);
  await env.CFG.put(kBadges(d), JSON.stringify(items));
  await markKept(env, d);
  return json({ ok: true, n, v: ver, w, h, bytes });
}
async function badgeDelete(req, env, url) {
  const d = devParam(url);
  if (!(await knownDevice(env, d))) return json({ error: "unknown device" }, 404);
  const n = parseInt(url.searchParams.get("n"), 10);
  if (!Number.isInteger(n) || n < 0 || n >= MAX_BADGES) return json({ error: "n must be 0.." + (MAX_BADGES - 1) }, 400);
  const items = (await badgeIndex(env, d)).filter((x) => x.n !== n);
  await env.CFG.delete(kBadge(d, n));
  await env.CFG.put(kBadges(d), JSON.stringify(items));
  return json({ ok: true });
}

// ---- the list of gadgets, for the settings page
async function adminDevices(env) {
  const devs = await devicesGet(env);
  const out = [];
  for (const [d, e] of Object.entries(devs)) {
    out.push({ d, name: e.name || d, first_seen: e.first_seen || 0, last_seen: e.last_seen || 0, wg: e.wg_pub || "", blocked: !!e.blocked,
      over: Object.keys(await devCfgGet(env, d)),
      badges: (await badgeIndex(env, d)).length, avatar: !!(await env.CFG.get(kAvatar(d), "arrayBuffer")) });
  }
  out.sort((a, b) => b.last_seen - a.last_seen);
  return json({ devices: out, legacy: { badges: (await badgeIndex(env, "")).length, avatar: !!(await env.CFG.get("avatar", "arrayBuffer")) }, max: MAX_DEVICES });
}
async function adminDevice(req, env) {
  const { d, name, remove, block } = await req.json().catch(() => ({}));
  if (typeof d !== "string" || !DEVICE_RE.test(d)) return json({ error: "bad device id" }, 400);
  const devs = await devicesGet(env);
  if (!devs[d]) return json({ error: "unknown device" }, 404);
  if (remove) {
    for (let n = 0; n < MAX_BADGES; n++) await env.CFG.delete(kBadge(d, n));
    await env.CFG.delete(kBadges(d));
    await env.CFG.delete(kAvatar(d));
    await env.CFG.delete("devcfg:" + d);
    delete devs[d];
  } else if (typeof block === "boolean") {
    // A lost gadget: blocked, every call it makes with its id is refused (see fetch). Its tunnel key is revoked too, so it stops
    // being an approved peer; unblocking does not approve the key again.
    if (block) devs[d].blocked = true; else delete devs[d].blocked;
    if (block && devs[d].wg_pub && env.WG) await reg(env, "revoke", { pub: devs[d].wg_pub }).catch(() => {});
  } else if (typeof name === "string" && name.trim()) {
    devs[d].name = name.trim().slice(0, 40);
  } else {
    return json({ error: "nothing to do" }, 400);
  }
  await env.CFG.put("devices", JSON.stringify(devs));
  return json({ ok: true });
}
// Copies the older single set (avatar and badge pictures) to a gadget, where it has none of its own yet. The older set stays,
// so a gadget with the older firmware keeps working.
async function adminMigrate(env, url) {
  const d = devParam(url);
  if (!d || !(await knownDevice(env, d))) return json({ error: "unknown device" }, 404);
  let avatar = false, badges = 0;
  const av = await env.CFG.get("avatar", "arrayBuffer");
  if (av && !(await env.CFG.get(kAvatar(d), "arrayBuffer"))) { await env.CFG.put(kAvatar(d), av); avatar = true; }
  const old = await badgeIndex(env, "");
  if (old.length && !(await badgeIndex(env, d)).length) {
    for (const it of old) {
      const b = await env.CFG.get(kBadge("", it.n), "arrayBuffer");
      if (b) await env.CFG.put(kBadge(d, it.n), b);
    }
    await env.CFG.put(kBadges(d), JSON.stringify(old));
    badges = old.length;
  }
  if (avatar || badges) await markKept(env, d);
  return json({ ok: true, avatar, badges });
}

// ---- settings page -------------------------------------------------------------------------------------
const mask = (v) => (v ? "已设置 ••••" + v.slice(-4) : "");

async function admin(req, env, url, all) {
  const p = url.pathname;
  if (p === "/admin/devices" && req.method === "GET") return await adminDevices(env);
  if (p === "/admin/device" && req.method === "POST") return await adminDevice(req, env);
  if (p === "/admin/migrate" && req.method === "POST") return await adminMigrate(env, url);
  // ?d=<gadget id>: the settings of one gadget. "config" is what applies to it (its own overrides over the global values),
  // "global" the global values, "over" the parts it overrides. Without d it is the global settings.
  if (p === "/admin/api" && req.method === "GET") {
    const d = devParam(url);
    if (!(await knownDevice(env, d))) return json({ error: "unknown device" }, 404);
    const A = d ? await loadAll(env, d) : all;
    const secrets = {};
    for (const n of Object.keys(SECRET_ENV)) secrets[n] = mask(all.S[n]);
    return json({ config: A.cfg, global: d ? A.global : undefined, over: d ? Object.keys(A.dev) : undefined, secrets, peers: await wgList(env, all.cfg.wg), binding: { ai: !!all.AI, durable: !!env.BOT, admin_token: !!env.ADMIN_TOKEN }, origin: url.origin });
  }
  if (p === "/admin/api" && req.method === "POST") {
    if (!env.CFG) return json({ error: "KV not bound" }, 500);
    const body = await req.json().catch(() => ({}));
    const d = devParam(url);
    if (d) {   // one gadget: body.over = the sections it overrides (asr, tts, bot); a section not listed follows the global values
      if (!(await knownDevice(env, d))) return json({ error: "unknown device" }, 404);
      const c = body.config && typeof body.config === "object" ? body.config : {}, ov = {};
      for (const sect of Array.isArray(body.over) ? body.over : []) {
        if (!DEV_SECTIONS.includes(sect) || !c[sect] || typeof c[sect] !== "object") continue;
        ov[sect] = {};
        for (const f of DEV_FIELDS[sect]) if (["string", "number"].includes(typeof c[sect][f])) ov[sect][f] = c[sect][f];
      }
      try { if (ov.tts && ov.tts.region) azureHost(ov.tts.region, "tts"); } catch (e) { return json({ error: "区域名不对：只能是 eastasia 这样的名字" }, 400); }
      try { for (const [sect, o] of Object.entries(ov)) for (const [f, v] of Object.entries(o)) checkSetting(sect, f, v); } catch (e) { return json({ error: "设置值格式不对：" + String(e.message) }, 400); }
      if (ov.bot && !["auto", "always", "off"].includes(ov.bot.mode)) ov.bot.mode = "auto";
      if (Object.keys(ov).length) { await env.CFG.put("devcfg:" + d, JSON.stringify(ov)); await markKept(env, d); } else await env.CFG.delete("devcfg:" + d);
    } else if (body.config) {   // merged into what is stored, section by section: a partial update never wipes the rest
      const keep = { ...all.over };
      for (const sect of Object.keys(DEFAULTS)) {
        const c = body.config[sect];
        if (!c || typeof c !== "object") continue;
        keep[sect] = { ...(keep[sect] || {}) };
        for (const [f, v] of Object.entries(c)) if (f in DEFAULTS[sect] && ["string", "number"].includes(typeof v)) keep[sect][f] = v;
        try {
          for (const [f, v] of Object.entries(keep[sect])) checkSetting(sect, f, v);
          if (sect === "tts" && keep.tts.region) azureHost(keep.tts.region, "tts");
          if (sect === "bot" && keep.bot.callback_base) checkHttpsUrl(keep.bot.callback_base);
        } catch (e) { return json({ error: /^bad value/.test(String(e.message)) ? "设置值格式不对：" + e.message : (sect === "tts" ? "区域名不对：只能是 eastasia 这样的名字" : "回调地址只接受公网域名上的 https 地址") }, 400); }
      }
      if (keep.bot && keep.bot.mode && !["auto", "always", "off"].includes(keep.bot.mode)) keep.bot.mode = "auto";
      await env.CFG.put("config", JSON.stringify(keep));
    }
    if (body.secrets) {
      const cur = { ...all.stored };
      for (const [n, v] of Object.entries(body.secrets)) {
        if (!(n in SECRET_ENV)) continue;
        if (v === null) { delete cur[n]; continue; }
        if (typeof v !== "string" || !v.trim()) continue;
        if (n === "grokbot_url") { try { checkHttpsUrl(v.trim()); } catch (e) { return json({ error: "机器人的 Webhook 地址只接受公网域名上的 https 地址" }, 400); } }
        cur[n] = v.trim();
      }
      await env.CFG.put("secrets", JSON.stringify(cur));
    }
    return json({ ok: true });
  }
  if (p === "/admin/wg" && req.method === "GET") {   // the tunnel keys that asked, the gadget each is assigned to, and the server side's facts
    if (!env.WG) return json({ peers: [], conf: null });
    const devs = await devicesGet(env), owner = {}, W = all.cfg.wg;
    for (const [d, e] of Object.entries(devs)) if (e.wg_pub) owner[e.wg_pub] = d;
    const peers = (await wgList(env, W)).map((x) => ({ ...x, device: owner[x.pub] || "" }));
    return json({ peers, conf: { endpoint: W.endpoint, port: W.port, subnet: W.subnet, server_pub: W.server_pub } });
  }
  // {action: "approve" | "revoke" | "label" | "assign" | "add", pub, label?, d?}. Approving only marks the key in the registry: the
  // line to run on the WireGuard server (`wg set …`, or the [Peer] block for wg0.conf) is shown by the page and is still a person's job.
  if (p === "/admin/wg" && req.method === "POST") {
    const b = await req.json().catch(() => ({}));
    const { action, pub } = b;
    if (!env.WG || !["approve", "revoke", "label", "assign", "add"].includes(action) || typeof pub !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(pub)) return json({ error: "bad request" }, 400);
    if (action === "add") {   // a key made elsewhere (the page's own key generator, a phone's app): enrolled and approved at once
      const r0 = await reg(env, "enroll", { pub });
      if (!r0.ok) return json(await r0.json().catch(() => ({})), r0.status);
      await reg(env, "approve", { pub });
      if (b.label) await reg(env, "label", { pub, label: b.label });
      return json({ ok: true, n: (await r0.json()).n });
    }
    if (action === "label") { const r = await reg(env, "label", { pub, label: b.label }); return json(await r.json().catch(() => ({})), r.status); }
    if (action === "assign") {   // a key belongs to at most one gadget; d "" frees it
      const devs = await devicesGet(env);
      if (b.d && !devs[b.d]) return json({ error: "unknown device" }, 404);
      for (const e of Object.values(devs)) if (e.wg_pub === pub) delete e.wg_pub;
      if (b.d) devs[b.d].wg_pub = pub;
      await env.CFG.put("devices", JSON.stringify(devs));
      return json({ ok: true });
    }
    if (action === "revoke") { const devs = await devicesGet(env); for (const e of Object.values(devs)) if (e.wg_pub === pub) delete e.wg_pub; await env.CFG.put("devices", JSON.stringify(devs)); }
    const r = await reg(env, action, { pub });
    return json(await r.json().catch(() => ({})), r.status);
  }
  if (p === "/admin/wg/conf" && req.method === "GET") {   // ?pub=…&type=server|client: plain text to copy
    const pub = url.searchParams.get("pub") || "";
    const peer = (await wgList(env, all.cfg.wg)).find((x) => x.pub === pub);
    if (!peer) return text("unknown key", 404);
    return text(url.searchParams.get("type") === "server" ? wgServerBlock(peer) : wgClientConf(all.cfg.wg, peer));
  }
  if (p === "/admin/voices" && req.method === "GET") {         // the vendor's full live voice list
    if (!all.S.azure_key) return json({ error: "先填 Azure Speech 密钥并保存" }, 400);
    let host;
    try { host = azureHost(url.searchParams.get("region") || all.cfg.tts.region, "tts"); } catch (e) { return json({ error: "区域名不对：只能是 eastasia 这样的名字" }, 400); }
    const r = await fetch(`https://${host}/cognitiveservices/voices/list`, { headers: { "Ocp-Apim-Subscription-Key": all.S.azure_key } });
    if (!r.ok) return json({ error: "Azure 返回 " + r.status + "（密钥或区域不对？）" }, 502);
    return json({ voices: (await r.json()).map((v) => ({ n: v.ShortName, d: [v.LocalName, v.Locale, v.Gender].filter(Boolean).join(" · ") })) });
  }
  if (p === "/admin/test" && req.method === "POST") {
    const { service, config } = await req.json().catch(() => ({}));
    const t0 = Date.now();
    if (config) {   // test with the values currently shown on the page (unsaved); keys still come from storage
      const merged = { ...all.cfg };
      for (const k of ["asr", "tts", "bot", "wg"]) if (config[k] && typeof config[k] === "object") merged[k] = { ...all.cfg[k], ...config[k] };
      all = { ...all, cfg: merged };
    }
    try {
      if (service === "tts") {
        const { audio, parts } = await synthAll(all.cfg, all.S, "你好，我是圆圆。这是一段语音合成的测试，如果你能听到我说话，说明这项服务已经配置好了。");
        return new Response(audio, { headers: { "content-type": "audio/mpeg", "x-ms": String(Date.now() - t0), "x-parts": String(parts) } });
      }
      if (service === "asr") {
        // A real round trip when there is an Azure key: synthesise a sentence as 16 kHz WAV and recognise it.
        if (all.S.azure_key) {
          const sentence = "今天北京天气怎么样，需要带伞吗";
          const wavBytes = await synthAzure(all.cfg, all.S, sentence, "riff-16khz-16bit-mono-pcm");
          const heard = await recognise(all.cfg, all.S, wavBytes, all.AI);
          return json({ ok: true, ms: Date.now() - t0, text: heard || "(空)", note: "用 Azure 合成了一句“" + sentence + "”，再用所选的识别服务识别回来（用时包含合成）" });
        }
        const heard = await recognise(all.cfg, all.S, wav(new Uint8Array(32000), 16000), all.AI);   // 1 s of silence
        return json({ ok: true, ms: Date.now() - t0, text: heard || "(空)", note: "没有 Azure 密钥，只能发 1 秒静音：这只能说明请求没报错，不能说明识别效果；Cloudflare 的识别对静音不会去调 Whisper" });
      }
      if (service === "bot") {   // one real question to the bot, up to 90 s
        const wait = await botAsk(req, env, all, "请回答：今天是几月几号？");
        const answer = await wait2(wait, 90000);
        return json({ ok: !!answer, ms: Date.now() - t0, text: answer || "", note: answer ? "机器人收到问题并把答案送回来了" : "机器人收到了 Webhook，但 90 秒内没有回调。请检查它的“允许访问的外部地址”里有没有本网关的域名 " + new URL(req.url).hostname });
      }
      return json({ error: "unknown service" }, 400);
    } catch (e) { return json({ ok: false, ms: Date.now() - t0, error: String(e).slice(0, 300) }, 200); }
  }
  return text("not found", 404);
}
const wait2 = (wait, ms) => {
  const stop = { done: false }, timer = new Promise((r) => setTimeout(() => r(null), ms));
  return Promise.race([wait(stop), timer]).finally(() => { stop.done = true; });   // the wait in the background ends with the race
};

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname.replace(/\/+$/, "").startsWith("/bot-reply")) return await botReply(req, env, url);   // the bot calls this: a one-time token, not the gateway token
    // The settings page itself is a static file with no data in it; the token is asked for by the page and sent in a header, so it
    // never has to be in a URL (an old ?k= bookmark still works: the page moves it to sessionStorage and clears the address bar).
    if (url.pathname === "/admin" && req.method === "GET") return new Response(adminHtml, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } });
    const want = isAdminPath(url.pathname) ? (env.ADMIN_TOKEN || env.GATEWAY_TOKEN) : env.GATEWAY_TOKEN;
    let allowed = !!want && (await safeEq(givenToken(req, url), want));
    const asDevice = allowed && !isAdminPath(url.pathname);   // a gadget's own call (not the settings page's)
    // The settings page (admin token) also reads the badge pictures the device reads (device token) to show them.
    if (!allowed && env.ADMIN_TOKEN && req.method === "GET" && /^\/badge\/(list|\d)$/.test(url.pathname)) allowed = await safeEq(givenToken(req, url), env.ADMIN_TOKEN);
    if (!allowed) return text("forbidden", 403);
    // A gadget names itself with d=<id> or the X-Device header; its own settings (recognition, voice, bot mode) then apply to /stt /chat /tts.
    const dev = asDevice ? devParam(url) || (DEVICE_RE.test(req.headers.get("x-device") || "") ? req.headers.get("x-device") : "") : "";
    if (dev && (await devicesGet(env))[dev]?.blocked) return text("blocked", 403);   // a lost gadget (settings page: Devices → Block)
    const all = await loadAll(env, dev);
    if (dev && ["/stt", "/chat", "/tts"].includes(url.pathname)) ctx.waitUntil(deviceSeen(env, dev).catch(() => {}));
    try {
      if (url.pathname.startsWith("/admin")) return await admin(req, env, url, all);
      if (url.pathname === "/wg/peers" && req.method === "GET") return text((await wgList(env, all.cfg.wg)).map((p) => p.cmd + "   # asked " + p.at + (p.ok ? " (approved)" : "")).join("\n") + "\n");
      if (url.pathname === "/health") return json({ ok: true, asr: all.cfg.asr.provider, tts: "azure:" + all.cfg.tts.voice, bot: !!(all.S.grokbot_url && all.S.grokbot_auth), wg: !!(all.cfg.wg.server_pub && all.cfg.wg.endpoint) });
      if (url.pathname === "/badge/list" && req.method === "GET") return await badgeList(env, url, asDevice);
      if (/^\/badge\/\d$/.test(url.pathname) && req.method === "GET") return await badgeGet(env, url, parseInt(url.pathname.slice(7), 10), asDevice);
      if (url.pathname === "/avatar/view" && req.method === "GET") return await avatarView(env, url);
      if (req.method !== "POST") return text("method", 405);
      if (url.pathname === "/badge/set") return await badgeSet(req, env, url);
      if (url.pathname === "/badge/delete") return await badgeDelete(req, env, url);
      if (url.pathname === "/stt") return await stt(req, env, all);
      if (url.pathname === "/tts") return await tts(req, env, all);
      if (url.pathname === "/chat") return await chat(req, env, all);
      if (url.pathname === "/wg/enroll") return await wgEnroll(req, env, all);
      if (url.pathname === "/avatar") return await avatarGet(env, url, asDevice);
      if (url.pathname === "/avatar/delete") return await avatarDelete(env, url);
      if (url.pathname === "/avatar/set") return await avatarSet(req, env, url);
      return text("not found", 404);
    } catch (e) {
      console.log("error", String(e).slice(0, 300));
      return json({ error: "internal" }, 500);
    }
  },
};
