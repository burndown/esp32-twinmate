// Muse gateway: the three HTTP calls the gadget firmware makes (/stt, /chat, /tts), answered by cloud providers.
// Providers, models and keys are chosen on the admin page (/admin?k=<token>) and kept in KV; Worker secrets
// (DASHSCOPE_API_KEY, GATEWAY_TOKEN) still work as fallbacks. Every request needs ?k=<GATEWAY_TOKEN>.
import adminHtml from "./admin.html";

const DEFAULTS = {
  system: "你是放在家里桌上的语音助手，对方是通过麦克风和你说话的。回答要口语化，像聊天一样自然。" +
          "不要使用 Markdown、列表、编号、表情符号或括号说明，因为你的话会被直接读出来。" +
          "用户用什么语言提问，你就用什么语言回答。需要最新信息时先联网搜索。",
  history_turns: 6,
  muse_mode: false,   // true: /chat answers 503 so the firmware asks Muse itself (recognition and speech stay here)
  max_tokens: 4000,
  llm: { provider: "dashscope", model: "qwen-plus", search: true, base_url: "", extra: "" },
  tts: { provider: "cosyvoice", model: "cosyvoice-v2", voice: "longxiaochun_v2", cluster: "volcano_tts", region: "eastasia" },
  asr: { provider: "qwen3-asr-flash", model: "qwen3-asr-flash", url: "" },
};
const DASHSCOPE = "https://dashscope.aliyuncs.com";
const ARK = "https://ark.cn-beijing.volces.com/api/v3";
const VOLC_SPEECH = "https://openspeech.bytedance.com";
// secret name -> env fallback
const SECRET_NAMES = { dashscope_key: "DASHSCOPE_API_KEY", ark_key: "ARK_API_KEY", deepseek_key: "DEEPSEEK_API_KEY",
  custom_key: "CUSTOM_LLM_KEY", volc_appid: "VOLC_APPID", volc_token: "VOLC_TOKEN",
  azure_key: "AZURE_SPEECH_KEY", homebox_token: "HOMEBOX_ASR_TOKEN" };

async function loadAll(env) {
  let over = null, sec = null;
  try { over = env.CFG ? await env.CFG.get("config", "json") : null; } catch (e) { /* defaults */ }
  try { sec = env.CFG ? await env.CFG.get("secrets", "json") : null; } catch (e) { /* env only */ }
  const cfg = { ...DEFAULTS, ...(over || {}) };
  for (const k of ["llm", "tts", "asr"]) cfg[k] = { ...DEFAULTS[k], ...((over || {})[k] || {}) };
  const S = {};
  for (const [name, envName] of Object.entries(SECRET_NAMES)) S[name] = (sec && sec[name]) || env[envName] || "";
  return { cfg, S, stored: sec || {}, AI: env.AI || null };   // AI: the Workers AI binding of this request, when the Worker has one
}

const text = (s, status = 200, type = "text/plain; charset=utf-8") => new Response(s, { status, headers: { "content-type": type } });
const json = (o, status = 200) => text(JSON.stringify(o), status, "application/json");

// ---- limits and checks (a device token must not be a way to burn quotas or to aim the keys elsewhere) ------------------
const MAX_PCM = 2 * 1024 * 1024;     // 60 s of 16 kHz PCM is 1.9 MB, which is also the most Azure takes
const MAX_TTS_CHARS = 600;           // the firmware sends at most 480 bytes at a time
const MAX_CHAT_CHARS = 1000;
const MAX_AVATAR = 120 * 1024;       // 233x233 RGB565 is 108 KB
const MAX_PENDING_PEERS = 20;        // device keys that asked for a tunnel and nobody has approved yet
const tooLarge = () => json({ error: "too large" }, 413);
// A /chat reply is plain text that gets spoken. When the bot fails, the rest of the reply is not an answer: it starts with this
// control character, followed by a short code (bot_timeout, bot_unreachable); the firmware shows an error instead of speaking it.
const ERR = "\u0001";

// ---- two tokens --------------------------------------------------------------------------------------------
// GATEWAY_TOKEN is in every device's firmware (whoever holds a device holds it) and opens only what a device needs.
// ADMIN_TOKEN stays in your browser and opens the settings page and the other management routes. Without ADMIN_TOKEN the device
// token still opens them (an old deployment keeps working) and the settings page says so.
const isAdminPath = (p) => p.startsWith("/admin") || p === "/wg/peers" || p === "/avatar/set" || p === "/health";
const givenToken = (req, url) => url.searchParams.get("k") || (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");

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
function unb64(s) { const b = atob(s), o = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) o[i] = b.charCodeAt(i); return o; }

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

// ---- ASR ---------------------------------------------------------------------------------------------
// audio: wav or mp3 bytes. Returns recognised text ("" for silence).
async function recognise(cfg, S, audio, mime, AI) {
  const A = cfg.asr;
  if (A.provider === "homebox") {
    // The speech server at home (SenseVoice) takes WAV or raw PCM; it is reached through a Cloudflare Tunnel hostname
    // that sits in front of a small token-checking gate.
    if (!A.url) throw new Error("homebox ASR url not set");
    if (mime !== "audio/wav") throw new Error("homebox ASR takes WAV only");
    const hdr = { "content-type": "audio/wav", "X-Sample-Rate": "16000" };
    if (S.homebox_token) hdr.Authorization = "Bearer " + S.homebox_token;   // the tunnel gate needs it; the LAN server does not
    const r = await fetch(A.url, { method: "POST", headers: hdr, body: audio });
    if (!r.ok) throw new Error("homebox asr http " + r.status);
    const d = await r.json();
    return (d.text || "").trim();
  }
  if (A.provider === "cloudflare") {
    // Workers AI, free allowance 10,000 neurons a day (about 200 audio minutes for this model). No key: it is a binding.
    if (!AI) throw new Error("Workers AI binding missing: add [ai] binding = \"AI\" to wrangler.toml and deploy to Cloudflare");
    if (mime !== "audio/wav") throw new Error("Workers AI ASR takes WAV only");
    const args = { audio: b64(audio) };
    if (A.language !== "auto") args.language = A.language || "zh";
    const r = await AI.run("@cf/openai/whisper-large-v3-turbo", args);
    return (r.text || "").trim();
  }
  if (A.provider === "azure") {
    // Azure Speech short-audio REST API: the same resource, key and region as Azure text-to-speech (60 s of audio at most).
    if (!S.azure_key) throw new Error("Azure Speech key not set");
    if (mime !== "audio/wav") throw new Error("Azure ASR takes WAV only");
    const host = azureHost(cfg.tts.region, "stt");
    const lang = A.language || "zh-CN";
    const r = await fetch(`https://${host}/speech/recognition/conversation/cognitiveservices/v1?language=${encodeURIComponent(lang)}&format=simple`, {
      method: "POST",
      headers: { "Ocp-Apim-Subscription-Key": S.azure_key, "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000", Accept: "application/json" },
      body: audio });
    if (!r.ok) throw new Error("azure asr http " + r.status);
    const d = await r.json();
    if (d.RecognitionStatus === "NoMatch" || d.RecognitionStatus === "InitialSilenceTimeout") return "";
    if (d.RecognitionStatus !== "Success") throw new Error("azure asr " + d.RecognitionStatus);
    return (d.DisplayText || "").trim();
  }
  if (A.provider === "volcengine") {
    if (!S.volc_appid || !S.volc_token) throw new Error("volcengine speech app id / token not set");
    const r = await fetch(VOLC_SPEECH + "/api/v3/auc/bigmodel/recognize/flash", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Api-App-Key": S.volc_appid, "X-Api-Access-Key": S.volc_token,
        "X-Api-Resource-Id": "volc.bigasr.auc_turbo", "X-Api-Request-Id": crypto.randomUUID(), "X-Api-Sequence": "-1" },
      body: JSON.stringify({ user: { uid: S.volc_appid }, audio: { data: b64(audio) }, request: { model_name: "bigmodel", enable_itn: true, enable_punc: true } }),
    });
    const code = r.headers.get("X-Api-Status-Code") || "";
    if (code === "20000003") return "";                         // silence
    if (code !== "20000000") throw new Error("volc asr " + code + " " + (r.headers.get("X-Api-Message") || r.status));
    const d = await r.json();
    return (d.result?.text || "").trim();
  }
  if (!S.dashscope_key) throw new Error("dashscope key not set");
  const r = await fetch(DASHSCOPE + "/compatible-mode/v1/chat/completions", {
    method: "POST", headers: { Authorization: "Bearer " + S.dashscope_key, "content-type": "application/json" },
    body: JSON.stringify({ model: A.model || "qwen3-asr-flash", stream: false, asr_options: { enable_itn: false },
      messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: "data:" + mime + ";base64," + b64(audio) } }] }] }),
  });
  if (!r.ok) throw new Error("asr http " + r.status);
  const d = await r.json();
  return (d.choices?.[0]?.message?.content || "").trim();
}

async function stt(req, env, all) {
  if ((+req.headers.get("content-length") || 0) > MAX_PCM) return tooLarge();
  const pcm = new Uint8Array(await req.arrayBuffer());
  if (pcm.length > MAX_PCM) return tooLarge();
  const rate = parseInt(req.headers.get("x-sample-rate") || "16000", 10);
  if (pcm.length < 3200) return json({ text: "" });           // under 0.1 s: nothing to recognise
  try { return json({ text: await recognise(all.cfg, all.S, wav(pcm, rate), "audio/wav", all.AI) }); }
  catch (e) { console.log("asr", String(e).slice(0, 200)); return json({ error: String(e).slice(0, 200) }, 502); }
}

// ---- LLM ---------------------------------------------------------------------------------------------
function nowZh() {
  return new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "long", day: "numeric", weekday: "long", hour: "2-digit", minute: "2-digit", hour12: false });
}

// The system prompt with today's date and the rules that stop a model from answering "this year" questions from memory.
function sysPrompt(cfg) {
  return cfg.system + " 现在是北京时间" + nowZh() + "。凡是涉及现在、今年、最新、近期的问题，先联网搜索，以搜索结果和今天的日期为准，不要凭记忆回答，也不要把今年说成去年。回答里不要出现链接、星号、井号等格式符号。";
}

function llmTarget(cfg, S) {
  const L = cfg.llm;
  switch (L.provider) {
    case "ark": return { base: ARK, key: S.ark_key, name: "ark" };
    case "deepseek": return { base: "https://api.deepseek.com", key: S.deepseek_key, name: "deepseek" };
    case "responses": return { base: (L.base_url || "").replace(/\/+$/, ""), key: S.custom_key, name: "responses" };   // OpenAI Responses API (cliproxy, OpenAI)
    case "custom": return { base: (L.base_url || "").replace(/\/+$/, ""), key: S.custom_key, name: "custom" };
    default: return { base: DASHSCOPE + "/compatible-mode/v1", key: S.dashscope_key, name: "dashscope" };
  }
}

// Opens an upstream request that streams text deltas. Returns a ReadableStream of plain-text bytes plus a
// promise of the full reply (used for chat memory).
async function llmStream(cfg, S, messages) {
  const L = cfg.llm, T = llmTarget(cfg, S);
  if (!T.key) throw new Error(T.name + " key not set");
  let extra = {};
  if (L.extra) { try { extra = JSON.parse(L.extra); } catch (e) { throw new Error("llm extra is not valid JSON"); } }
  const headers = { Authorization: "Bearer " + T.key, "content-type": "application/json" };

  let up = null, mode = "chat";
  if ((T.name === "ark" || T.name === "responses") && L.search) {   // Responses API with the web_search tool
    const sys = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    up = await fetch(T.base + "/responses", { method: "POST", headers, body: JSON.stringify({
      model: L.model, stream: true, instructions: sys, tools: [{ type: "web_search" }],
      input: messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content })), ...extra }) });
    if (up.ok && up.body) mode = "responses";
    else if (T.name === "responses") throw new Error("llm http " + up.status + " " + (await up.text().catch(() => "")).slice(0, 160));
    else { console.log("ark responses", up.status); up = null; }
  }
  if (!up) {
    const body = { model: L.model, stream: true, max_tokens: cfg.max_tokens, messages, ...extra };
    if (T.name === "dashscope" && L.search) body.enable_search = true;
    up = await fetch(T.base + "/chat/completions", { method: "POST", headers, body: JSON.stringify(body) });
    if (!up.ok || !up.body) throw new Error("llm http " + up.status + " " + (await up.text().catch(() => "")).slice(0, 160));
  }

  let reply = "", buf = "", done;
  const donePromise = new Promise((r) => { done = r; });
  const dec = new TextDecoder(), enc = new TextEncoder();
  const ts = new TransformStream({
    transform(chunk, ctl) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        const p = line.slice(5).trim();
        if (p === "[DONE]") continue;
        try {
          const j = JSON.parse(p);
          const t = mode === "responses" ? (j.type === "response.output_text.delta" ? j.delta : "") : j.choices?.[0]?.delta?.content;
          if (t) {
            const clean = t.replace(/[*#`]+/g, "");   // markdown marks would be shown in the captions and may be spoken
            if (clean) { reply += clean; ctl.enqueue(enc.encode(clean)); }
          }
        } catch (e) { /* partial line */ }
      }
    },
    flush() { done(reply); },
  });
  return { stream: up.body.pipeThrough(ts), reply: donePromise };
}

async function chat(req, env, all, ctx) {
  const { text: userText, muse_down: museDown, away, gemini } = await req.json().catch(() => ({}));
  // Muse mode: the first ask is answered with 503 so the firmware sends the text to Muse. If Muse stays silent for 30 s
  // the firmware asks again with muse_down:true, and then the configured model answers instead of failing the turn.
  // gemini: the device is away and the user chose the model for that case, so neither Muse nor the bot is asked.
  if (all.cfg.muse_mode && !museDown && !gemini) return json({ muse: true }, 503);
  if (!userText || typeof userText !== "string") return json({ error: "no text" }, 400);
  if (userText.length > MAX_CHAT_CHARS) return tooLarge();
  // Away from home (the firmware says so when it is not on the home Wi-Fi) every turn goes to the Grok Bot; at home
  // only when the bot's name is said first. If the bot cannot be reached the normal model answers.
  const asked = gemini ? "" : (away ? userText : botAsked(userText));
  if (asked && env.GROKBOT_URL && env.GROKBOT_AUTH) {
    const r = await botChat(req, env, asked, all);
    if (r) return r;
  }
  const { cfg, S } = all;
  const hKey = "h:" + (req.headers.get("x-device") || "muse-gadget");
  let hist = [];
  try { hist = (env.CFG && (await env.CFG.get(hKey, "json"))) || []; } catch (e) { hist = []; }
  hist = hist.slice(-cfg.history_turns * 2);
  const messages = [{ role: "system", content: sysPrompt(cfg) }, ...hist, { role: "user", content: userText }];
  let r;
  try { r = await llmStream(cfg, S, messages); } catch (e) { return json({ error: String(e).slice(0, 200) }, 502); }
  ctx.waitUntil(r.reply.then((reply) => {
    if (reply && env.CFG) return env.CFG.put(hKey, JSON.stringify([...hist, { role: "user", content: userText }, { role: "assistant", content: reply }]), { expirationTtl: 1800 });
  }));
  return new Response(r.stream, { headers: { "content-type": "text/plain; charset=utf-8" } });
}

// ---- Grok Bot ----------------------------------------------------------------------------------------
// A cloud agent that takes a webhook and answers later (30 s to a few minutes). The device speaks "ask" at once, the
// gateway keeps the response open, and the bot POSTs its answer to /bot-reply with a one-time token; the answer is then
// streamed on. Triggered by saying the bot's name first ("问小黑…"); everything else goes to the normal model.
const BOT_TRIGGER = /^\s*(?:请|麻烦|帮我)?\s*(?:让|叫|问问?|找|交给|跟|和)?\s*(?:小黑|小嘿|grok|格罗克|机器人)\s*[，,、：:。.！!]?\s*(?:帮我|帮忙|给我|替我)?/i;
const BOT_WAIT_MS = 270000;

function botAsked(userText) {
  const m = userText.match(BOT_TRIGGER);
  if (!m) return null;
  const rest = userText.slice(m[0].length).trim();
  return rest || null;
}

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

// ---- state of one Grok Bot question ------------------------------------------------------------------
// A question waits for the bot's answer, which arrives as a separate request (/bot-reply), possibly handled by another
// copy of this Worker. On Cloudflare that state lives in a Durable Object (one per question, strongly consistent, free
// with the SQLite-backed kind); KV is only eventually consistent, so there it would delay the answer by up to a minute.
// Without the BOT binding (the home gateway) the state is a KV key, polled.
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
      if (!v) return Response.json({ text: null });
      if (!v.text) await new Promise((res) => { this.waiters.push(res); setTimeout(res, Math.min(+b.ms || 30000, 60000)); });
      const w = (await this.state.storage.get("v")) || {};
      return Response.json({ text: w.text || null });
    }
    if (path === "/done") { await this.state.storage.deleteAll(); return new Response("ok"); }
    return new Response("not found", { status: 404 });
  }
  async alarm() { await this.state.storage.deleteAll(); }
}
const botStub = (env, id) => env.BOT.get(env.BOT.idFromName(id));
const doCall = (env, id, path, body) => botStub(env, id).fetch("https://bot/" + path, { method: "POST", body: JSON.stringify(body || {}) });

async function botInit(env, id, tok) {
  if (env.BOT) await doCall(env, id, "init", { tok });
  else await env.CFG.put("bot:" + id, JSON.stringify({ tok, text: null }), { expirationTtl: 600 });
}
// Waits up to ms for the answer; returns its text or null.
async function botWait(env, id, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (env.BOT) {
      const r = await doCall(env, id, "wait", { ms: Math.min(until - Date.now(), 30000) });
      const t = (await r.json().catch(() => ({}))).text;
      if (t) { await doCall(env, id, "done"); return t; }
    } else {
      await new Promise((r) => setTimeout(r, 1500));
      let v = null;
      try { v = await env.CFG.get("bot:" + id, "json"); } catch (e) { /* retry */ }
      if (v && v.text) { await env.CFG.delete("bot:" + id); return v.text; }
    }
  }
  return null;
}
// True when the token matched and the answer was stored.
async function botSet(env, id, tok, reply) {
  if (env.BOT) return (await doCall(env, id, "reply", { tok, text: reply })).ok;
  const v = await env.CFG.get("bot:" + id, "json").catch(() => null);
  if (!v || v.tok !== tok || v.text) return false;
  await env.CFG.put("bot:" + id, JSON.stringify({ tok: v.tok, text: reply }), { expirationTtl: 600 });
  return true;
}

async function botChat(req, env, ask, all) {
  const id = await signedId(env), tok = hex(16);
  await botInit(env, id, tok);
  const auth = /^bearer\s/i.test(env.GROKBOT_AUTH) ? env.GROKBOT_AUTH : "Bearer " + env.GROKBOT_AUTH;
  // The message to the bot names where to send the answer: the relay's address when the Webhook goes out through the relay,
  // the gateway's own public address (BOT_CALLBACK_FALLBACK) when the relay is down, so an answer is never sent to a dead road.
  const messageFor = async (origin) => {
    const host = new URL(origin).hostname, port = new URL(origin).port || "443";
    const ip = await realIp(host);
    const hint = ip ? " 如果这个域名在你那里被解析成 198.18.x.x 之类的假地址，请改用真实地址：curl --resolve " + host + ":" + port + ":" + ip + " ，仍然使用上面的域名和 https。" : "";
    return ask + "\n\n（这是桌上小圆屏设备的语音提问。请用中文纯文本简短回答，不要 Markdown。回答好以后，请用 HTTP POST 把答案发到 "
      + origin + "/bot-reply/" + id + "/" + tok + " ，请求头 Content-Type: application/json，请求体 {\"reply\":\"你的回答\"}。请逐字使用这个地址（里面没有问号和 & 符号）。这个地址只用一次，10 分钟内有效，不需要任何密钥或其他请求头。" + hint + "）";
  };
  const send = async (url, origin) => fetch(url, { method: "POST", headers: { Authorization: auth, "content-type": "application/json" }, body: JSON.stringify({ message: await messageFor(origin) }), signal: AbortSignal.timeout(20000) });
  const direct = env.BOT_CALLBACK_FALLBACK || env.BOT_CALLBACK_BASE || new URL(req.url).origin;
  // Sends the Webhook (through the relay when there is one, straight when it is down). True when the bot took it.
  const sendWebhook = async () => {
    if (env.GROKBOT_VIA) {
      try {
        const u = new URL(env.GROKBOT_URL);
        const r = await send(new URL(u.pathname + u.search, env.GROKBOT_VIA).toString(), env.BOT_CALLBACK_BASE || direct);
        console.log("bot webhook via relay", r.status);
        if (r.ok) return true;
        if (r.status < 500) return false;   // the bot said no: not a relay problem
      } catch (e) { console.log("bot relay failed", String(e).slice(0, 100)); }
    }
    try {
      const r = await send(env.GROKBOT_URL, direct);
      console.log("bot webhook", r.status);
      return r.ok;
    } catch (e) { console.log("bot webhook failed", String(e).slice(0, 120)); return false; }
  };
  const enc = new TextEncoder();
  const body = new ReadableStream({
    async start(ctl) {
      const say = (t) => ctl.enqueue(enc.encode(t));
      // The acknowledgement goes out before the Webhook, so it is heard at once even when the Webhook is slow.
      say("收到，我去问小黑，请稍等。");
      if (!(await sendWebhook())) {
        // The bot could not be reached: the normal model answers after the acknowledgement, in the same reply.
        try {
          const { cfg, S } = all;
          const r = await llmStream(cfg, S, [{ role: "system", content: sysPrompt(cfg) }, { role: "user", content: ask }]);
          const rd = r.stream.getReader();
          say("\n");
          for (;;) { const { done, value } = await rd.read(); if (done) break; ctl.enqueue(value); }
        } catch (e) { say(ERR + "bot_unreachable"); }
        ctl.close();
        return;
      }
      const answer = await botWait(env, id, BOT_WAIT_MS);
      if (answer) { say("\n" + answer.replace(/[*#`]+/g, "")); ctl.close(); return; }
      say(ERR + "bot_timeout");
      ctl.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
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

// ---- TTS ---------------------------------------------------------------------------------------------
function splitText(t, [minLen, maxLen] = [10, 40]) {
  // Cut after every stop or comma, then merge tiny pieces: ~10..40 characters each, so even one long sentence
  // is synthesised in parallel (CosyVoice runs at roughly 0.6x real time per request).
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

async function synthCosy(cfg, S, t) {
  if (!S.dashscope_key) throw new Error("dashscope key not set");
  const T = cfg.tts;
  const resp = await fetch(DASHSCOPE + "/api-ws/v1/inference/", { headers: { Upgrade: "websocket", Authorization: "Bearer " + S.dashscope_key } });
  const ws = resp.webSocket;
  if (!ws) throw new Error("tts ws " + resp.status);
  ws.accept();
  ws.binaryType = "arraybuffer";   // default delivers Blobs, which cannot be read synchronously
  const id = crypto.randomUUID().replace(/-/g, "");
  const send = (action, payload) => ws.send(JSON.stringify({ header: { action, task_id: id, streaming: "duplex" }, payload }));
  const parts = [];
  try {
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("tts timeout")), 25000);
      ws.addEventListener("message", (ev) => {
        if (typeof ev.data !== "string") { parts.push(new Uint8Array(ev.data)); return; }
        const e = JSON.parse(ev.data).header?.event;
        if (e === "task-started") { send("continue-task", { input: { text: t } }); send("finish-task", { input: {} }); }
        else if (e === "task-finished") { clearTimeout(to); resolve(); }
        else if (e === "task-failed") { clearTimeout(to); reject(new Error(ev.data)); }
      });
      ws.addEventListener("close", () => { clearTimeout(to); resolve(); });
      ws.addEventListener("error", () => { clearTimeout(to); reject(new Error("ws error")); });
      send("run-task", { task_group: "audio", task: "tts", function: "SpeechSynthesizer", model: T.model,
        parameters: { text_type: "PlainText", voice: T.voice, format: "mp3", sample_rate: 16000 }, input: {} });
    });
  } finally { try { ws.close(); } catch (e) { /* closed */ } }
  const total = parts.reduce((n, p) => n + p.length, 0);
  if (!total) throw new Error("no audio");
  const out = new Uint8Array(total); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function synthVolc(cfg, S, t) {
  if (!S.volc_appid || !S.volc_token) throw new Error("volcengine speech app id / token not set");
  const T = cfg.tts;
  const r = await fetch(VOLC_SPEECH + "/api/v1/tts", {
    method: "POST", headers: { "content-type": "application/json", Authorization: "Bearer;" + S.volc_token },
    body: JSON.stringify({ app: { appid: S.volc_appid, token: S.volc_token, cluster: T.cluster || "volcano_tts" }, user: { uid: "muse" },
      audio: { voice_type: T.voice, encoding: "mp3", rate: 16000, speed_ratio: 1.0 },
      request: { reqid: crypto.randomUUID(), text: t, text_type: "plain", operation: "query" } }),
  });
  const d = await r.json().catch(() => ({}));
  if (!d.data) throw new Error("volc tts " + (d.code ?? r.status) + " " + (d.message || ""));
  return unb64(d.data);
}

const xmlEsc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function synthAzure(cfg, S, t) {
  if (!S.azure_key) throw new Error("azure speech key not set");
  const T = cfg.tts;
  const host = azureHost(T.region, "tts");
  const lang = (T.voice || "zh-CN-XiaoxiaoNeural").split("-").slice(0, 2).join("-");
  const ssml = `<speak version='1.0' xml:lang='${lang}'><voice name='${T.voice || "zh-CN-XiaoxiaoNeural"}'>${xmlEsc(t)}</voice></speak>`;
  const r = await fetch(`https://${host}/cognitiveservices/v1`, {
    method: "POST",
    headers: { "Ocp-Apim-Subscription-Key": S.azure_key, "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "audio-16khz-128kbitrate-mono-mp3", "User-Agent": "muse-gateway" },
    body: ssml,
  });
  if (!r.ok) throw new Error("azure tts http " + r.status + " " + (await r.text().catch(() => "")).slice(0, 120));
  const out = new Uint8Array(await r.arrayBuffer());
  if (!out.length) throw new Error("no audio");
  return out;
}

async function synthAll(cfg, S, t) {
  const prov = cfg.tts.provider;
  const one = prov === "azure" ? synthAzure : prov === "volcengine" ? synthVolc : synthCosy;   // volcengine free tier: 2 concurrent requests
  const pieces = splitText(t, prov === "azure" ? [30, 110] : prov === "volcengine" ? [10, 40] : [20, 70]);   // Azure sounds better on whole sentences and the free tier allows few requests per minute
  const results = new Array(pieces.length);
  let next = 0;
  // The vendors rate-limit short bursts (Alibaba answers Throttling.RateQuota): back off and retry instead of failing the whole reply.
  const withRetry = async (piece) => {
    for (let attempt = 0; ; attempt++) {
      try { return await one(cfg, S, piece); }
      catch (e) {
        if (attempt >= 3 || !/Throttl|rate|quota|429|limit/i.test(String(e))) throw e;
        await new Promise((r) => setTimeout(r, 350 * 2 ** attempt));
      }
    }
  };
  const worker = async () => { while (next < pieces.length) { const i = next++; results[i] = await withRetry(pieces[i]); } };
  await Promise.all(Array.from({ length: Math.min(prov === "azure" ? 3 : 2, pieces.length) }, worker));
  const bodies = results.map((r, i) => (i ? stripId3(r) : r));
  const total = bodies.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total); let o = 0;
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
        if (Object.values(peers).filter((x) => !x.ok).length >= MAX_PENDING_PEERS) return Response.json({ error: "too many waiting" }, { status: 429 });
        const used = new Set(Object.values(peers).map((x) => x.n));
        let n = 2;
        while (used.has(n) && n <= 250) n++;
        if (n > 250) return Response.json({ error: "no addresses left" }, { status: 507 });
        p = peers[b.pub] = { n, at: new Date().toISOString(), ok: false };
        await this.state.storage.put("peers", peers);
        await this.state.storage.setAlarm(Date.now() + 86400000);
      }
      return Response.json({ n: p.n });
    }
    if (path === "/import") {   // once: the registry starts from the peers an older version kept in KV
      if (!(await this.state.storage.get("imported"))) {
        await this.state.storage.put("peers", { ...b.peers, ...peers });
        await this.state.storage.put("imported", true);
      }
      return Response.json({ ok: true });
    }
    if (path === "/list") return Response.json({ peers });
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

const wgConf = (env) => ({ server_pub: env.WG_SERVER_PUB || "", endpoint: env.WG_ENDPOINT || "", port: parseInt(env.WG_PORT) || 51820, subnet: env.WG_SUBNET || "10.77.0." });
// Peers that were registered before the registry existed (KV keys wg:list / wg:p:<key>) are taken over once, as approved.
async function wgImport(env) {
  const list = (env.CFG && (await env.CFG.get("wg:list", "json"))) || [];
  const peers = {};
  for (const pub of list) {
    const p = await env.CFG.get("wg:p:" + pub, "json");
    const n = p && parseInt(String(p.ip).split(".").pop());
    if (n) peers[pub] = { n, at: p.at, ok: true };
  }
  await reg(env, "import", { peers });
}
async function wgEnroll(req, env, all) {
  const W = wgConf(env);
  if (!env.WG) return json({ error: "the WG Durable Object is not bound (see wrangler.toml)" }, 503);
  if (!W.server_pub || !W.endpoint) return json({ error: "wireguard not set up" }, 503);
  await wgImport(env);
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
  await wgImport(env);
  const { peers } = await (await reg(env, "list")).json();
  return Object.entries(peers).sort((a, b) => a[1].n - b[1].n).map(([pub, p]) => ({ pub, ip: W.subnet + p.n, at: p.at, ok: !!p.ok, cmd: `sudo wg set wg0 peer '${pub}' allowed-ips ${W.subnet}${p.n}/32` }));
}

// ---- avatar picture ---------------------------------------------------------------------------------
// One picture for the round screen: 16-byte header ("MAV1", width, height, byte count) + RGB565 pixels, made by
// tools/make-avatar-img.py. POST /avatar sends it to the device; POST /avatar/set stores a new one (LAN only: the
// public proxy does not pass it).
async function avatarGet(env) {
  const b = env.CFG && (await env.CFG.get("avatar", "arrayBuffer"));
  if (!b) return json({ error: "no picture" }, 404);
  return new Response(b, { headers: { "content-type": "application/octet-stream", "content-length": String(b.byteLength) } });
}

async function avatarSet(req, env) {
  if ((+req.headers.get("content-length") || 0) > MAX_AVATAR) return tooLarge();
  const b = await req.arrayBuffer();
  if (b.byteLength > MAX_AVATAR) return tooLarge();
  const v = new DataView(b);
  if (b.byteLength < 16 || v.getUint32(0, true) !== 0x3156414d) return json({ error: "not a MAV1 picture" }, 400);
  const w = v.getUint16(4, true), h = v.getUint16(6, true), n = v.getUint32(8, true);
  if (w > 240 || h > 240 || n !== w * h * 2 || b.byteLength !== 16 + n) return json({ error: "bad size" }, 400);
  await env.CFG.put("avatar", b);
  return json({ ok: true, w, h, bytes: n });
}

// ---- admin ---------------------------------------------------------------------------------------------
const mask = (v) => (v ? "已设置 ••••" + v.slice(-4) : "");

async function admin(req, env, url, all) {
  const p = url.pathname;
  if (p === "/admin" && req.method === "GET") return text(adminHtml, 200, "text/html; charset=utf-8");
  if (p === "/admin/api" && req.method === "GET") {
    const secrets = {};
    for (const n of Object.keys(SECRET_NAMES)) secrets[n] = mask(all.S[n]);
    return json({ config: { muse_mode: !!all.cfg.muse_mode, system: all.cfg.system, history_turns: all.cfg.history_turns, max_tokens: all.cfg.max_tokens, llm: all.cfg.llm, tts: all.cfg.tts, asr: all.cfg.asr }, secrets });
  }
  if (p === "/admin/api" && req.method === "POST") {
    if (!env.CFG) return json({ error: "KV not bound" }, 500);
    const body = await req.json().catch(() => null);
    if (!body) return json({ error: "bad json" }, 400);
    if (body.config) {
      const c = body.config, keep = {};
      for (const k of ["system"]) if (typeof c[k] === "string") keep[k] = c[k];
      if (typeof c.muse_mode === "boolean") keep.muse_mode = c.muse_mode;
      for (const k of ["history_turns", "max_tokens"]) if (Number.isFinite(+c[k])) keep[k] = +c[k];
      for (const k of ["llm", "tts", "asr"]) if (c[k] && typeof c[k] === "object") {
        keep[k] = {};
        for (const [f, v] of Object.entries(c[k])) if (["string", "boolean"].includes(typeof v)) keep[k][f] = v;
      }
      if (keep.tts && keep.tts.region) { try { azureHost(keep.tts.region, "tts"); } catch (e) { return json({ error: "区域名不对：只能是 eastasia 这样的名字" }, 400); } }
      await env.CFG.put("config", JSON.stringify(keep));
    }
    if (body.secrets) {
      const cur = all.stored;
      for (const [n, v] of Object.entries(body.secrets)) {
        if (!(n in SECRET_NAMES)) continue;
        if (v === null) delete cur[n]; else if (typeof v === "string" && v.trim()) cur[n] = v.trim();
      }
      await env.CFG.put("secrets", JSON.stringify(cur));
    }
    return json({ ok: true });
  }
  if (p === "/admin/wg" && req.method === "POST") {   // {action: "approve" | "revoke", pub}
    const { action, pub } = await req.json().catch(() => ({}));
    if (!env.WG || !["approve", "revoke"].includes(action) || typeof pub !== "string" || !/^[A-Za-z0-9+\/]{43}=$/.test(pub)) return json({ error: "bad request" }, 400);
    const r = await reg(env, action, { pub });
    return json(await r.json().catch(() => ({})), r.status);
  }
  if (p === "/admin/voices" && req.method === "GET") {         // the full live voice list of the vendor (Azure)
    if (!all.S.azure_key) return json({ error: "先在“密钥”里填 Azure Speech 密钥并保存" }, 400);
    let host;
    try { host = azureHost(url.searchParams.get("region") || all.cfg.tts.region, "tts"); } catch (e) { return json({ error: "区域名不对：只能是 eastasia 这样的名字" }, 400); }
    const r = await fetch(`https://${host}/cognitiveservices/voices/list`, { headers: { "Ocp-Apim-Subscription-Key": all.S.azure_key } });
    if (!r.ok) return json({ error: "Azure 返回 " + r.status + "（密钥或区域不对？）" }, 502);
    const list = await r.json();
    return json({ voices: list.map((v) => ({ n: v.ShortName, d: [v.LocalName, v.Locale, v.Gender].filter(Boolean).join(" · ") })) });
  }
  if (p === "/admin/test" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const { service } = body;
    const t0 = Date.now();
    if (body.config) {   // test with the values currently shown on the page (unsaved); keys still come from storage
      const c = body.config, merged = { ...all.cfg };
      for (const k of ["llm", "tts", "asr"]) if (c[k] && typeof c[k] === "object") merged[k] = { ...all.cfg[k], ...c[k] };
      all = { ...all, cfg: merged };
    }
    try {
      if (service === "llm") {
        const r = await llmStream(all.cfg, all.S, [{ role: "system", content: sysPrompt(all.cfg) }, { role: "user", content: "用一两句话介绍一下你自己，再告诉我今天几号。" }]);
        const reply = await new Response(r.stream).text();
        return json({ ok: true, ms: Date.now() - t0, text: reply.slice(0, 400) });
      }
      if (service === "tts") {
        const { audio, parts } = await synthAll(all.cfg, all.S, "你好，我是圆圆。这是一段语音合成的测试，如果你能听到我说话，说明这项服务已经配置好了。");
        return new Response(audio, { headers: { "content-type": "audio/mpeg", "x-ms": String(Date.now() - t0), "x-parts": String(parts) } });
      }
      if (service === "asr" && (["homebox", "azure", "cloudflare"].includes(all.cfg.asr.provider))) {
        const text0 = await recognise(all.cfg, all.S, wav(new Uint8Array(32000), 16000), "audio/wav", all.AI);   // 1 s of silence
        return json({ ok: true, ms: Date.now() - t0, text: text0 || "(空)", note: "连通和密钥正常。这里发的是 1 秒静音：SenseVoice 对纯静音会乱猜一个字，Azure 会返回空，Whisper 可能给出一两个字；云端没法把 MP3 转成录音来测识别效果，真实效果以说话为准" });
      }
      if (service === "asr") {
        const { audio } = await synthAll(all.cfg, all.S, "今天天气怎么样，需要带伞吗");
        const heard = await recognise(all.cfg, all.S, stripId3(audio), "audio/mpeg", all.AI);
        return json({ ok: true, ms: Date.now() - t0, text: heard, note: "用语音合成生成一句“今天天气怎么样，需要带伞吗”再识别回来" });
      }
      return json({ error: "unknown service" }, 400);
    } catch (e) { return json({ ok: false, ms: Date.now() - t0, error: String(e).slice(0, 300) }, 200); }
  }
  return text("not found", 404);
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname.replace(/\/+$/, "").startsWith("/bot-reply")) return await botReply(req, env, url);   // the cloud bot calls this: a one-time token, not the gateway token
    const want = isAdminPath(url.pathname) ? (env.ADMIN_TOKEN || env.GATEWAY_TOKEN) : env.GATEWAY_TOKEN;
    if (!want || !(await safeEq(givenToken(req, url), want))) return text("forbidden", 403);
    const all = await loadAll(env);
    try {
      if (url.pathname.startsWith("/admin")) return await admin(req, env, url, all);
      if (url.pathname === "/wg/peers" && req.method === "GET") return text((await wgList(env, wgConf(env))).map((p) => p.cmd + "   # asked " + p.at + (p.ok ? " (approved)" : "")).join("\n") + "\n");
      if (url.pathname === "/health") return json({ ok: true, muse_mode: !!all.cfg.muse_mode, llm: all.cfg.llm.provider + ":" + all.cfg.llm.model, search: !!all.cfg.llm.search, tts: all.cfg.tts.provider + ":" + all.cfg.tts.voice, asr: all.cfg.asr.provider });
      if (req.method !== "POST") return text("method", 405);
      if (url.pathname === "/avatar") return await avatarGet(env);
      if (url.pathname === "/avatar/set") return await avatarSet(req, env);
      if (url.pathname === "/wg/enroll") return await wgEnroll(req, env);
      if (url.pathname === "/stt") return await stt(req, env, all);
      if (url.pathname === "/chat") return await chat(req, env, all, ctx);
      if (url.pathname === "/tts") return await tts(req, env, all);
      if (url.pathname === "/reset") { if (env.CFG) await env.CFG.delete("h:" + (req.headers.get("x-device") || "muse-gadget")); return json({ ok: true }); }
      return text("not found", 404);
    } catch (e) {
      console.log("error", String(e).slice(0, 300));
      return json({ error: "internal" }, 500);
    }
  },
};
