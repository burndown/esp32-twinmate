# The gateway (`worker/`, Cloudflare edition)

**English** · [中文](GATEWAY.zh-CN.md)

The firmware speaks only a few HTTP calls. The gateway turns them into calls to cloud services. This page describes the slim Cloudflare edition in `worker/`: its calls, tokens, settings page, protections, free allowances, and how far it has been verified. How to deploy it is in the [README](../README.en.md) (one command: `tools/muse-cloud.py gateway`).

## Calls

| Call | Who makes it | What it does |
|---|---|---|
| `POST /stt` | device | 16 kHz PCM recording → `{"text": "…"}`, recognised by Cloudflare Whisper or Azure |
| `POST /tts` | device | `{"text": "…"}` → MP3 (16 kHz), synthesised by Azure; a long sentence is cut into small pieces, synthesised in parallel and joined |
| `POST /chat` | device | `{"text", "away"}`: when `away` is true the question goes to the Grok Bot and the answer is streamed back; otherwise the reply is `503`, meaning "this one is for Muse". When the bot fails, the reply contains `\u0001` followed by a code (`bot_timeout` / `bot_unreachable`), and the firmware shows it as an error |
| `POST /bot-reply/<id>/<token>` | the bot | The bot sends its answer here. The token is one-time and the gateway token is not needed; the id is signed, so a forged request is refused before it touches any storage |
| `POST /wg/enroll` | device | The device sends its own WireGuard public key and gets the server details and a tunnel address |
| `POST /avatar` | device | Downloads the round picture you put on the gateway |
| `GET /badge/list`, `GET /badge/<n>` | device (the settings page reads them with the admin token) | The badge pictures the device copies into its badge partition (Settings > Badge > Sync) |
| `GET /admin` | you | The settings page (a static page; it asks for the token) |
| `/admin/api`, `/admin/wg`, `/admin/test`, `/admin/voices`, `GET /wg/peers`, `POST /avatar/set`, `GET /avatar/view`, `POST /avatar/delete`, `POST /badge/set?n=N`, `POST /badge/delete?n=N`, `GET /health` | you | Management calls |

## Two tokens

- **Device token** `GATEWAY_TOKEN`: it is written into the firmware, so whoever holds the device holds it. It can only be used for `/stt`, `/tts`, `/chat`, `/wg/enroll` and downloading the avatar and badge pictures.
- **Admin token** `ADMIN_TOKEN`: it stays in your browser. It opens the settings page and all management calls, and may also be sent in an `Authorization: Bearer …` header. The device token does not open them.
- If `ADMIN_TOKEN` is not set, the device token still opens the management calls (so an old deployment keeps working) and the settings page warns you. `tools/muse-cloud.py init` makes two different random tokens.
- Tokens must be long random strings (`openssl rand -hex 24`). The gateway does not limit how many wrong tokens are tried; you can add a rate-limiting rule in Cloudflare (I have not checked whether the free plan allows it). The **device** token is in the `?k=` part of the URL the firmware calls (the Worker also accepts `Authorization: Bearer`, but the firmware does not send it yet), so it appears in access logs. The admin token is no longer sent in URLs by the settings page.

## The settings page

`https://<your-worker>.workers.dev/admin`. The page itself is a static file with no data in it; it asks for the admin token, keeps it in the browser tab (`sessionStorage`) and sends it in an `Authorization: Bearer` header, so the token is never in a request URL. An old `/admin?k=<admin token>` bookmark still works: the page moves the token out of the address bar at once (that first request is still logged with `?k=`). The page has tabs (Overview, Voice, Bot, Network, Appearance); the Save bar is shown on the tabs that have settings to save, and every setting has a **Test** button:

- **This gateway**: the three addresses to put in the firmware, and the state of the Workers AI binding, the Durable Object binding and the admin token.
- **Speech recognition**: Cloudflare Workers AI (Whisper large-v3-turbo, free, no key) or Azure Speech, and the language.
- **Speech synthesis**: the Azure region, the voice (the full list of several hundred voices can be fetched), and the Azure Speech key.
- **Grok Bot**: the Webhook address and the authorisation (stored as secrets; the page shows only the last four characters), an optional callback host name, and a "Test Grok Bot" button (it really asks the bot a question). Add the host name shown on the page to the bot's list of outside addresses it may call.
- **Devices**: avatars and badge pictures are kept per device (a device names itself with `d=<node id>`; it is listed the first time it asks, and can be renamed or removed). Pictures uploaded before this was added stay as the older single set, which a device without an id still gets; a button copies it to a device.
- **Avatar**: the picture avatar of the round screen. Choose a photo and edit it in the round preview (drag to move, the slider or the wheel to zoom, rotate, reset, and an optional clock written over it to see how a watch face would sit on it); your browser then crops it to 233×233, blacks out the corners and sends it. On the device: Settings > Avatar > Get picture.
- **Badge pictures**: up to 9 full-screen pictures (466×466, about 430 KB each), edited and made in your browser the same way. On the device: Settings > Badge > Sync with gateway, or hold a picture for a second and a half. Only the pictures whose version changed are copied; a picture you delete here disappears from the device at its next sync. The Badge page needs a build with the badge partition (`partitions_muse_badge.csv`).
- **WireGuard**: the server's public key, address, port and the tunnel's address prefix. Below that are the devices that asked for a tunnel, each with a `wg set` command and a "copy command" button. Running that command on the WireGuard server approves the device; then press "mark as approved". "Revoke and free the address" releases its tunnel address. The page stores no private key.

Saving merges by section, so only the section you changed is changed. **A saved change takes up to about a minute to take effect**, because Cloudflare KV reads are cached. Keys saved on the page are kept in the KV of your own Cloudflare account (as plain text; the page shows only the last four characters). A stricter way is `wrangler secret put AZURE_SPEECH_KEY`, `GROKBOT_URL`, `GROKBOT_AUTH` (the gateway reads these environment variables too, and the WireGuard server details can be given as `WG_SERVER_PUB`, `WG_ENDPOINT`, `WG_PORT`, `WG_SUBNET`).

Two details. The **Test Grok Bot** button waits at most 90 seconds for the callback, while a real question waits 300 seconds, so a slow bot can pass in real use and still fail the test. Tunnel addresses for devices that enrol themselves are handed out from `.10` up; `.2` to `.9` are left for devices whose address is written into the firmware, so the two never collide. Saved values are checked (voice names, languages, the recognition provider, and the WireGuard key, host, port and address prefix), and a wrong one is refused with `400`.

## Settings per device and WireGuard management

The page has a "settings for" selector at the top: the global defaults, or one gadget. A gadget can override three sections: recognition (`asr`: provider, language), synthesis (`tts`: region, voice) and the bot mode (`bot.mode`: `auto`, `always`, `off`). A section it does not override follows the global value, and a gadget with no overrides at all behaves exactly as before. Overrides are KV `devcfg:<id>`. The Webhook address and authorization, the callback domain, the Azure key and the WireGuard server details stay global (the page locks them while a gadget is selected).

Bot mode: `auto` is the old rule (the bot answers only when the device says it is away from home, anything else is for Muse), `always` sends every question that reaches `/chat` to the bot, `off` never does (Muse answers).

A gadget is recognised on `/stt`, `/chat` and `/tts` by `d=<node id>` or an `X-Device: homelink-xxxxxx` header, after its token was checked. **A firmware that sends neither, such as the stock patch, is not recognised and uses the global settings**, so per-device settings only take effect once the firmware puts its node id in those requests (avatar and badge pictures already use `d=`).

The WireGuard tab lists the keys that asked for a tunnel. Each can be labelled, assigned to a gadget, approved (a mark in the registry only) or revoked, and the page shows the `wg set` line, the `[Peer]` block to append to `wg0.conf`, and a client config template (a key the device made itself has its private key only on the device). "New key" makes an X25519 key pair in the browser, registers and approves the public key, and shows the full client config once; the private key is never sent to the gateway. The page works over plain http, so the key generator is plain JavaScript (BigInt) instead of WebCrypto. Putting the peer on the WireGuard server stays a manual step. Calls: `GET /admin/api?d=<id>`, `POST /admin/api?d=<id>` (body `{config, over: ["asr","tts","bot"]}`), `GET /admin/wg`, `POST /admin/wg` (`approve`, `revoke`, `label`, `assign`, `add`), `GET /admin/wg/conf?pub=…&type=server|client`.

A lost gadget can be blocked on the Devices tab ("Block", with a confirmation; "Unblock" undoes it). Once blocked, every gadget call that carries its id (`/stt`, `/chat`, `/tts`, `/wg/enroll`, the badge and avatar downloads) gets `403 blocked`, and its tunnel key is revoked in the registry (unblocking does not approve the key again; do that on the WireGuard tab). The settings page itself is not affected. **Limit:** the gadget token is shared by all gadgets, so a request without an id, an old firmware, or someone who strips the id is not stopped by this. For a gadget that is really gone, also remove its peer on the WireGuard server and, if needed, replace the gadget token.

## Protections

- Requests have size limits: `/stt` 2 MB, `/tts` 600 characters, `/chat` 1000 characters, the picture 120 KB. Anything larger gets `413`.
- The Azure region is accepted only as a name such as `eastasia`, and the bot's Webhook and callback addresses only as `https` on a public host name. So if the settings page is misused, the Azure key and the bot's credentials still cannot be sent elsewhere.
- WireGuard enrolment lives in a Durable Object (the `WG` binding and the `v2` migration in `wrangler.toml`; `wrangler deploy` creates them): concurrent requests never receive the same address, at most 20 public keys can wait for approval at once, and a key nobody approves within a week is forgotten.
- Tokens are compared in constant time.
- Because the device token is in every firmware, anyone who holds one could register made-up gadget ids or WireGuard keys. When the list of 8 gadgets is full, a gadget you have not touched (not renamed, no tunnel key, no picture or settings saved, not blocked) is pushed out by a newcomer; gadgets you worked on are never pushed out. When 20 tunnel requests are waiting, the oldest one is dropped once it is a day old, otherwise new ones get `429`. A patient attacker can still fill the lists with pending entries, so remove made-up ones on the settings page and replace the device token if you see them.
- The Azure free tier allows only one real-time request at a time. The gateway synthesises up to three pieces in parallel and backs off and retries when it is throttled (`429`).
- Whisper invents subtitle credits for silence. When a recording is almost silent the gateway returns an empty result, and it filters such credits.

## Language of the spoken phrases

The gateway speaks and sends a few fixed phrases, and they are **in Chinese** in `worker/src/index.js`: the acknowledgement the device says before the bot answers ("收到，我去问小黑，请稍等。", "Got it, I'll ask Xiaohei, please wait."), and the instruction text placed after your question in the Webhook message (it asks the bot to answer briefly, in Chinese, in plain text). The synthesis voice and recognition language come from the settings, but if you use another language you should edit these strings in `worker/src/index.js` (search for them). The firmware's on-screen texts are in English.

## The Grok Bot on Cloudflare

The gateway **first** makes the device say the acknowledgement, then sends the Webhook, then keeps the connection open for up to 300 seconds until the bot sends its answer to `/bot-reply`, and then streams the answer on so the device speaks it. The waiting state is kept in a Durable Object (strongly consistent; the SQLite-backed kind is available on the free plan). Without the `BOT` binding it falls back to polling KV (only eventually consistent, so an answer can be up to a minute late). **Your `*.workers.dev` host name must be in the bot's list of outside addresses it may call.** Otherwise the Webhook goes out but the callback is blocked, and the gateway waits the full 300 seconds before saying the bot did not answer. If the bot's network resolves host names to fake addresses such as `198.18.x.x`, the gateway looks up the real address through a public DNS and writes it into the instructions so the bot can use `curl --resolve`.

## Free allowances (check the current numbers yourself)

- The Azure Speech free tier (F0), from [Azure's pricing page](https://azure.microsoft.com/pricing/details/cognitive-services/speech-services): 5 hours of recognition and 500,000 characters of neural synthesis a month, and one real-time request at a time. If one question has about 5 seconds of recording and the answer about 600 characters, that is roughly 3,600 questions or 800 long answers a month. **This is an estimate, not a measurement.**
- The Cloudflare Workers free plan, from [Cloudflare's limits page](https://developers.cloudflare.com/workers/platform/limits/): 100,000 requests a day, 10 ms of CPU time per request (time spent waiting for the network does not count), and at most 50 subrequests per request. I have seen the figure of about 1,000 KV writes a day only in third-party articles, so check it against Cloudflare's own documents. One exchange is about one recognition request plus a dozen or so speech requests, so thousands of exchanges a day will not use up the request allowance.
- **Where there is no long-term data.** Whether 10 ms of CPU per request is always enough to join several MP3 pieces and stream: so far several complete long replies raised no limit error, but there are no long-term figures. The Grok Bot's callback state is held in a Durable Object that stays alive while it waits for the bot, and I have not checked how many exchanges a day the free allowance supports.

**Recognition with Cloudflare Workers AI** uses `@cf/openai/whisper-large-v3-turbo`. By [Cloudflare's pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) it costs 46.63 Neurons per audio minute, and the free allowance is 10,000 Neurons a day, about 200 minutes. Tested with the same Chinese recording through a real Worker: correct text (simplified characters), about 1.2 seconds once warm, 5.2 seconds on the cold start. **Do not choose `@cf/openai/whisper` (the non-turbo model)**: for the same sentence it printed traditional characters and got one character wrong. I do not recommend Workers AI's MeloTTS for synthesis: it outputs 44.1 kHz WAV, the firmware plays only MP3, and the free plan's 10 ms of CPU cannot encode MP3, so the firmware would need a WAV player, which has not been written.

## What has been verified (honestly)

| What | Status |
|---|---|
| Deployed to a free Cloudflare account; recognition (Whisper and Azure), synthesis, the settings page and its calls, a real bot, WireGuard enrolment | Passed |
| Blocking a lost gadget (2026-10-24): the Worker run locally with workerd; a gadget with an id is refused on `/chat` (header), `/tts` (`d=`) and `/wg/enroll` once blocked, another gadget and the settings page are not affected, its tunnel key is revoked, unblocking restores it | Passed locally; not deployed to a real Worker, not tried on a real device |
| Settings per device and the WireGuard tab (2026-10-24): the Worker run locally with workerd and its calls tested, the page clicked through in a browser (device switch, lock and unlock, save, new key) | Passed locally; not yet deployed to a Cloudflare Worker, not tested with a device that sends its id |
| The settings page clicked through item by item in a browser (desktop and phone width) | Passed (the clipboard content of the copy button could not be confirmed; if copying fails it selects the text and tells you) |
| A real bot through a free Cloudflare account: the acknowledgement comes at once, the answer in about 11 to 22 seconds, and the Worker's CPU time for that part is only 1 to 4 ms | Passed (requested directly from the Worker, and once as a full Muse turn on the device) |
| A full Muse turn on the device (cloud-only build, every request going only to the Worker): a 1,469-character answer fetched as 11 pieces of speech, 94 seconds of speech, 112 seconds in all, no CPU limit exceeded | Passed |
| Concurrent enrolment (12 at once), exhausting the addresses, input limits, region and address allow-lists, forged callbacks, the two tokens | Passed, tested locally and on a real Worker |
| The device shows an error when the bot fails | Passed, tested on the device |
| Whether 10 ms of CPU per request on the free plan stays enough over longer use | No long-term data |
| How many exchanges a day the Durable Object free allowance supports (it stays alive while waiting for the bot) | Not checked |
| A person with no background doing it from scratch by following the document | Not verified |
