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
  return { cfg, S, stored: sec || {} };
}

const text = (s, status = 200, type = "text/plain; charset=utf-8") => new Response(s, { status, headers: { "content-type": type } });
const json = (o, status = 200) => text(JSON.stringify(o), status, "application/json");

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
async function recognise(cfg, S, audio, mime) {
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
  const pcm = new Uint8Array(await req.arrayBuffer());
  const rate = parseInt(req.headers.get("x-sample-rate") || "16000", 10);
  if (pcm.length < 3200) return json({ text: "" });           // under 0.1 s: nothing to recognise
  try { return json({ text: await recognise(all.cfg, all.S, wav(pcm, rate), "audio/wav") }); }
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
  const { text: userText, muse_down: museDown, away } = await req.json().catch(() => ({}));
  // Muse mode: the first ask is answered with 503 so the firmware sends the text to Muse. If Muse stays silent for 30 s
  // the firmware asks again with muse_down:true, and then the configured model answers instead of failing the turn.
  if (all.cfg.muse_mode && !museDown) return json({ muse: true }, 503);
  if (!userText) return json({ error: "no text" }, 400);
  // Away from home (the firmware says so when it is not on the home Wi-Fi) every turn goes to the Grok Bot; at home
  // only when the bot's name is said first. If the bot cannot be reached the normal model answers.
  const asked = away ? userText : botAsked(userText);
  if (asked && env.GROKBOT_URL && env.GROKBOT_AUTH) {
    const r = await botChat(req, env, asked);
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

async function botChat(req, env, ask) {
  const id = hex(8), tok = hex(16);
  const origin = env.BOT_CALLBACK_BASE || new URL(req.url).origin;
  await env.CFG.put("bot:" + id, JSON.stringify({ tok, text: null }), { expirationTtl: 600 });
  const host = new URL(origin).hostname, port = new URL(origin).port || "443";
  const ip = await realIp(host);
  const hint = ip ? " 如果这个域名在你那里被解析成 198.18.x.x 之类的假地址，请改用真实地址：curl --resolve " + host + ":" + port + ":" + ip + " ，仍然使用上面的域名和 https。" : "";
  const message = ask + "\n\n（这是桌上小圆屏设备的语音提问。请用中文纯文本简短回答，不要 Markdown。回答好以后，请用 HTTP POST 把答案发到 "
    + origin + "/bot-reply?id=" + id + "&t=" + tok + " ，请求头 Content-Type: application/json，请求体 {\"reply\":\"你的回答\"}。这个地址只用一次，10 分钟内有效，不需要任何密钥或其他请求头。" + hint + "）";
  const auth = /^bearer\s/i.test(env.GROKBOT_AUTH) ? env.GROKBOT_AUTH : "Bearer " + env.GROKBOT_AUTH;
  try {
    const r = await fetch(env.GROKBOT_URL, { method: "POST", headers: { Authorization: auth, "content-type": "application/json" }, body: JSON.stringify({ message }) });
    console.log("bot webhook", r.status);
    if (!r.ok) return null;             // the normal model answers instead
  } catch (e) { console.log("bot webhook failed", String(e).slice(0, 120)); return null; }
  const enc = new TextEncoder();
  const body = new ReadableStream({
    async start(ctl) {
      const say = (t) => ctl.enqueue(enc.encode(t));
      say("收到，我去问小黑，请稍等。");
      const until = Date.now() + BOT_WAIT_MS;
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, 1500));
        let v = null;
        try { v = await env.CFG.get("bot:" + id, "json"); } catch (e) { /* retry */ }
        if (v && v.text) { say("\n" + v.text.replace(/[*#`]+/g, "")); await env.CFG.delete("bot:" + id); ctl.close(); return; }
      }
      say("\n小黑一直没有回话，我先不等了。");
      ctl.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
}

async function botReply(req, env, url) {
  if (req.method !== "POST") return text("method", 405);
  const id = url.searchParams.get("id") || "", t = url.searchParams.get("t") || "";
  const v = id ? await env.CFG.get("bot:" + id, "json").catch(() => null) : null;
  if (!v || v.tok !== t || v.text) return text("forbidden", 403);
  const b = await req.json().catch(() => null);
  const reply = (b && (b.text || b.reply || b.message) || "").toString().slice(0, 4000);
  if (!reply.trim()) return json({ error: "no text" }, 400);
  await env.CFG.put("bot:" + id, JSON.stringify({ tok: v.tok, text: reply }), { expirationTtl: 600 });
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
  const host = (T.region || "eastasia").includes(".") ? T.region : `${T.region || "eastasia"}.tts.speech.microsoft.com`;
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
  if (!t) return json({ error: "no text" }, 400);
  try {
    const { audio, parts } = await synthAll(all.cfg, all.S, t);
    return new Response(audio, { headers: { "content-type": "audio/mpeg", "x-parts": String(parts) } });
  } catch (e) {
    console.log("tts failed", String(e).slice(0, 200));
    return json({ error: "tts failed", detail: String(e).slice(0, 200) }, 502);
  }
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
  if (p === "/admin/voices" && req.method === "GET") {         // the full live voice list of the vendor (Azure)
    if (!all.S.azure_key) return json({ error: "先在“密钥”里填 Azure Speech 密钥并保存" }, 400);
    const region = url.searchParams.get("region") || all.cfg.tts.region || "eastasia";
    const host = region.includes(".") ? region : `${region}.tts.speech.microsoft.com`;
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
      if (service === "asr" && all.cfg.asr.provider === "homebox") {
        const text0 = await recognise(all.cfg, all.S, wav(new Uint8Array(32000), 16000), "audio/wav");   // 1 s of silence
        return json({ ok: true, ms: Date.now() - t0, text: text0 || "(空)", note: "连通和令牌正常。这里发的是 1 秒静音，SenseVoice 对纯静音会乱猜一个字，属正常现象；云端没法把 MP3 转成录音来测识别效果，真实效果以说话为准" });
      }
      if (service === "asr") {
        const { audio } = await synthAll(all.cfg, all.S, "今天天气怎么样，需要带伞吗");
        const heard = await recognise(all.cfg, all.S, stripId3(audio), "audio/mpeg");
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
    if (url.pathname === "/bot-reply") return await botReply(req, env, url);   // the cloud bot calls this: a one-time token, not the gateway token
    if (!env.GATEWAY_TOKEN || url.searchParams.get("k") !== env.GATEWAY_TOKEN) return text("forbidden", 403);
    const all = await loadAll(env);
    try {
      if (url.pathname.startsWith("/admin")) return await admin(req, env, url, all);
      if (url.pathname === "/health") return json({ ok: true, muse_mode: !!all.cfg.muse_mode, llm: all.cfg.llm.provider + ":" + all.cfg.llm.model, search: !!all.cfg.llm.search, tts: all.cfg.tts.provider + ":" + all.cfg.tts.voice, asr: all.cfg.asr.provider });
      if (req.method !== "POST") return text("method", 405);
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
