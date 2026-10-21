# The home server edition (`worker-home/`)

**English** · [中文](HOME-SERVER.zh-CN.md)

This page is about the **full edition of the gateway**: several cloud providers, local recognition, a language model at home, run on a server of your own, used on the local network, with a public entrance added for when you are away. If you only want the simplest cloud-only setup you do not need this page; go back to the [README](../README.md).

First, how this edition differs from the cloud-only one:

| | Cloud-only `worker/` | Home edition `worker-home/` |
|---|---|---|
| Runs on | A free Cloudflare account | A server at home (`wrangler dev --local`); it can also be deployed to Cloudflare |
| Recognition | Cloudflare Whisper (free) or Azure | Also Alibaba, Volcano Engine, a local SenseVoice |
| Language model | None | Tongyi, Doubao, DeepSeek, any OpenAI-compatible service (including a Gemini subscription proxy) |
| Synthesis | Azure | Also Alibaba CosyVoice, Volcano Engine |
| Who answers | Muse, Grok Bot | Muse, Grok Bot, the model; the model takes over when Muse or the bot fails |
| Firmware build option | `MUSE_MODEL_ANSWERS=n` | `MUSE_MODEL_ANSWERS=y` (the default) |

## Supported providers (full edition `worker-home/`)

`worker/` (the Cloudflare edition) has only Cloudflare Workers AI (Whisper) and Azure Speech. The table below is for the full edition.

| | Alibaba Bailian | Volcano Engine | Microsoft | Others |
|---|---|---|---|---|
| Language model | Qwen (Tongyi), with web search (`enable_search`) | Ark Doubao; web search goes through the Responses API's `web_search` tool | | DeepSeek; any OpenAI-compatible service (including Ollama at home) |
| Speech recognition | Qwen3-ASR-Flash | Doubao recorded-audio recognition (fast edition) | **Azure Speech** (short-audio REST; the same key and region as synthesis); **Cloudflare Workers AI** (Whisper large-v3-turbo, free, no key, only on a gateway deployed to Cloudflare) | **A local server** (SenseVoice through sherpa-onnx: WAV in, `{"text"}` out) |
| Speech synthesis | CosyVoice (WebSocket, 16 kHz MP3 output) | Doubao speech synthesis (HTTP v1) | **Azure Speech** (neural voices, REST, 16 kHz MP3) | |

**Using a ChatGPT / Gemini subscription through CLIProxyAPI (home gateway only; I have tested it once myself).** [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) offers an OpenAI-compatible interface on your own network. A Worker in the cloud cannot reach it, so it can only be set up on the home gateway. Two ways to use it:

- **Gemini with Google search (recommended, about 3 seconds).** Choose the provider "Custom", set the address to `http://<your LAN address>:8317/v1`, the model to `gemini-3-flash`, and the "extra parameters" to `{"tools":[{"google_search":{}}]}`. Do not tick the gateway's own web search.
- **GPT with search (about 17 seconds to the first character, because it searches before it writes).** Choose the provider "Responses API", a model such as `gpt-5.6-sol`, tick web search, and the extra parameters may be `{"reasoning":{"effort":"low"}}`. Gemini through the Responses API **does not search**, so use the first way for Gemini.

This uses a subscription account as an API through an unofficial proxy, which may violate the terms of service; weigh the quota and ban risks yourself.

The gateway puts today's date into the system prompt and asks the model to search first for anything about "this year" or "the latest". The `*`, `#` and backticks in replies are removed, so that no formatting symbols appear in captions or speech.

Azure has many voices: "Refresh the full list" on the settings page fetches all of them (several hundred) with your key so you can choose.

## Using it away from home (a public entrance to the home gateway)

The home gateway listens only on the local network. To let the device keep using your home recognition, model and synthesis when you are out, give it a public entrance and let the firmware **choose the address by the Wi-Fi name it is joined to**: on the home Wi-Fi it uses the LAN, on every other network it uses the public address, whether or not Muse is paired or reachable.

1. **HTTPS forwarding.** `home/gw-proxy.mjs` (Node, no dependencies) listens on a public port and lets through only `POST /chat`, `/tts`, `/stt`, `/bot-reply` and `/wg/enroll`, `/avatar`; everything else gets 404. Each source address may make at most 60 requests a minute, and 10 wrong tokens in a row (403) get it blocked for 10 minutes. Run it with `systemd --user`: first `mkdir -p ~/gw-proxy && cp home/gw-proxy.mjs ~/gw-proxy/`, then install `home/gw-proxy.service` (it starts `~/gw-proxy/gw-proxy.mjs`; replace `YOUR_DOMAIN` with your domain, and give the forwarding target in the environment variable `UP_HOST`).
2. **Certificate.** Ports 80 and 443 of home broadband are often blocked, so sign a Let's Encrypt certificate with [acme.sh](https://github.com/acmesh-official/acme.sh) using **DNS validation**; after renewal send `SIGHUP` to the forwarder and it reloads without a restart. Keep the keys only in files with permissions 600 on your own server.
3. **Router.** Add a DNAT rule `public port → the gateway machine:the same port`. If your public address changes, use dynamic DNS so the name follows it.
4. **Firmware.** In Kconfig set `MUSE_HOME_SSID` (the name of the home Wi-Fi) and the three fallback addresses `MUSE_STT_FALLBACK_URL`, `MUSE_BRAIN_FALLBACK_URL`, `MUSE_TTS_FALLBACK_URL` (pointing at the public entrance). Without `MUSE_HOME_SSID` the firmware instead makes a 1.5-second TCP probe to the LAN address, and if that fails it uses the fallback addresses for 90 seconds. If a request to the LAN address fails (no data at all arrives), it is retried once on the fallback address.

I tested this on a real device with a phone hotspot: recognition, answers and synthesis went through the public entrance and played normally. **Note:** I once tried a Cloudflare tunnel as the entrance; from my home, the route to Cloudflare goes round through the United States, `/chat` took 4 to 9 seconds and `/tts` 4 to 40 seconds with large swings, so I switched to opening a port directly. Your network is different and your results may differ.

## Connecting a cloud agent (a Webhook bot)

Some agents (the Grok Bot, for example) do not answer synchronously: they reply tens of seconds after the Webhook, and the reply is not in the HTTP response. The gateway has a path for this (configured on the home gateway only, and it needs the public entrance above):

1. **Triggering.** When the device is not on the home Wi-Fi, every request carries `"away": true` and the gateway hands that turn to the bot. At home the bot gets a turn only if you say its name first ("ask Xiaohei …"); all other turns go to the ordinary language model. If the bot cannot be reached, the ordinary model answers instead. In the firmware's Answers menu, choosing Grok Bot sends every turn to the bot, at home too.
2. **Sending.** The gateway sends `POST` to your Webhook with the body `{"message": "<what you said> + an instruction"}`. The instruction asks the bot to send its answer with an HTTP `POST` to `https://<your domain>:<port>/bot-reply/<id>/<token>`, with the body `{"reply": "…"}` (the fields `text` and `message` are accepted too). The `id` and the token are a **one-time pair made for each request**, valid for 10 minutes, usable successfully once, and no gateway token is needed. The token is in the path rather than in a query parameter because some Webhooks turn `&` into `&amp;`; the older `?id=&t=` form still works. The forwarder must have `/bot-reply` in its allow-list, or the callback is refused with 404.
3. **Waiting.** The gateway **first** makes the device say an acknowledgement ("收到，我去问小黑，请稍等。" — "Got it, I'll ask Xiaohei, please wait."; this phrase is in Chinese in the source), then sends the Webhook (if the Webhook cannot be sent, the gateway adds an answer from the ordinary model in the same reply), then keeps the connection open for up to 270 seconds; when the bot calls back, the answer is streamed on and spoken. If it times out, the device shows an error. The firmware's read timeout is therefore 300 seconds, and it reads the stream one byte at a time: ESP-IDF's `esp_http_client_read` waits until its buffer is full before returning, so a very short acknowledgement followed by tens of seconds of silence would sit stuck in the read until the answer arrived.
4. **Configuration.** The gateway's environment variables `GROKBOT_URL`, `GROKBOT_AUTH` (the Webhook address and secret) and `BOT_CALLBACK_BASE` (the full prefix of the public entrance). Keep secrets in files with permissions 600 on your own server and never in the repository. If the bot has a list of outside addresses it may call, add your domain to it.
5. **Optional: through a relay server with a public IP (`GROKBOT_VIA`).** Connect the home gateway to the relay with an SSH reverse tunnel (`home/bot-tunnel.service`), and let the relay's nginx pass the callback path and forward the Webhook as in `home/relay-nginx.conf`. The benefit: the callback uses the standard port 443 and a fixed address and does not depend on your home's public IP and inbound ports; the Webhook also goes out from a server with a better route. With `GROKBOT_VIA=http://127.0.0.1:18790` set, the gateway tries the relay first and goes direct if the relay is down; set `BOT_CALLBACK_BASE` to the relay's domain and `BOT_CALLBACK_FALLBACK` to the gateway's own public address: when the Webhook goes direct, the callback address given to the bot is switched to that one too, so the answer is never sent down a road that is down. I tested both cases (relay working: 15 seconds; with the tunnel stopped: 41 seconds, and the answer still came back). Two traps: an nginx reverse proxy speaks HTTP/1.0 by default and some bots answer `426 Upgrade Required`, so add `proxy_http_version 1.1`; and the Webhook path is a secret, so turn off the access log on the relay site.
6. **One more trap.** A bot's network may resolve host names to fake addresses such as `198.18.x.x` (a local proxy's fake IPs). The gateway looks up the real IP through a public DNS and writes it into the instruction so the bot can connect with `curl --resolve`.

I tested with a real Grok Bot: sending, callback and speaking took 18.6 seconds in all. A whole "away" turn on the device was also tested on a phone hotspot: the acknowledgement was heard about 11 seconds after release, the answer arrived about 32 seconds after, and the turn took 99 seconds (60 of them speech); the requests came from the hotspot's address and did not go round by the tunnel.

## Running the gateway on a server at home

The same Worker code can run on a server at home without Cloudflare, using Cloudflare's open-source local runtime (workerd, through `wrangler dev --local`), reachable only from the local network. The files are in `home/`:

```bash
mkdir -p ~/home-gateway/src && cd ~/home-gateway
cp /path/to/repo/home/package.json /path/to/repo/home/wrangler.toml .
cp /path/to/repo/worker-home/src/index.js /path/to/repo/worker-home/src/admin.html src/
npm install
printf 'GATEWAY_TOKEN=%s\nADMIN_TOKEN=%s\n' "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" > .dev.vars && chmod 600 .dev.vars
# then install home/muse-home-gateway.service (fill in YOUR_USER and YOUR_LAN_IP) as a systemd unit
```

The settings page is at `http://<LAN address>:8787/admin?k=<admin token>`. Settings and keys are kept in `./state` (a simulated KV on disk, in plain text). Why this edition exists: **a Worker in the cloud is slow to reach providers inside China.** Measured on the author's network (the route to Cloudflare lands on the US west coast): the same sentence took 2.6 to 6.4 seconds to synthesise in the cloud and 0.7 to 1.3 seconds on the home edition; Alibaba recognition 2 to 4 seconds against 0.5; the gateway's 503 answer in the old "back to Muse" mode 0.4 seconds plus a TLS handshake against 15 milliseconds (that mode is gone). On the LAN, plain http also saves the ESP32 a TLS handshake on every request.

Like the cloud-only edition it has two tokens: the device token `GATEWAY_TOKEN` (written into the firmware) and the admin token `ADMIN_TOKEN` (only in your browser, for the settings page). The device token cannot open the settings page. Unlike the cloud-only edition, **saving settings on the home edition's page replaces the whole configuration** (the cloud-only edition merges section by section): before you change the configuration through its API, read all of it, change it, and write the whole thing back.

## How Muse is asked

There is no "back to Muse" switch on the gateway any more: the device decides, in Settings → Answers. With Muse chosen, the device sends the recognised text to Muse itself and the gateway is not involved in the question. If Muse cannot be reached, or sends not a single character within the set time (`MUSE_BRAIN_GIVEUP_SECONDS`, 30 seconds by default), the firmware asks the gateway with `muse_down: true`, and then the gateway answers with the language model you chose so the turn does not fail. Recognition and speaking always use the providers chosen on the gateway, and the recording is never uploaded to Muse. (For older firmware, a question that arrives with none of the flags `away`, `gemini` or `muse_down` is answered with `503`, meaning "this one is for Muse", as before.)

## Local speech recognition (optional)

The firmware can send the recording straight to a recogniser at home (fastest, and the recording never leaves your house), and falls back to the gateway if that fails. If you want the gateway in the **cloud** to use your home recogniser too, there has to be a way back home: `homebox/asr_gate.py` is a small token-checking gateway (listening only on the local machine), and a Cloudflare Tunnel connects a domain name to it. **Note:** from the author's home the route to Cloudflare is long, this path measured about 3.5 seconds per request, much slower than the LAN, so it is only a fallback.

## Latency and trade-offs

- The time of one exchange goes mainly to three things: recognition (about 2 to 4 seconds, including upload and TLS), the language model's first character (under 1 second for an ordinary question, 3 to 6 seconds when it really searches the web), and the first sentence of synthesis. The gateway cuts a long sentence into pieces of 10 to 40 characters, synthesises them in parallel and joins them, trading a shorter wait for the first sentence.
- I did not listen to the joins between the pieces of the joined MP3 to check for audible flaws.
- Your voice and conversations go to the cloud services you choose, which is different from using Muse's own cloud.
