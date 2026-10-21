# The firmware: what the patch contains and how to build it by hand

**English** · [中文](FIRMWARE.zh-CN.md)

`firmware/muse-cloud.patch` modifies the upstream Muse firmware [muse-gadget-sdk](https://github.com/facebookincubator/muse-gadget-sdk) at commit `fa07304` (28 files, mostly in `esp32/components/muse/`; the command handling is in `esp32/main/`). Normally `tools/muse-cloud.py firmware` is all you need: it does every step of the "build by hand" section below for you. This page describes each feature in the patch, and what to do without the tool.

Only the **Waveshare ESP32-S3-Touch-AMOLED-1.75C** (the round screen) is supported so far. The eyes' tilt and shake use the board's QMI8658 sensor; no other board has been adapted.

## Features in the patch

Clients for recognition, chat and synthesis, Kconfig options, a Unifont 16×16 Chinese font, adjustments to captions and reply length, and these safeguards:

- **Recognition fallback.** If `MUSE_STT_URL` fails (or does not answer in 5 seconds), `MUSE_STT_FALLBACK_URL` is used.
- **How long to wait for Muse** is configurable (`MUSE_BRAIN_GIVEUP_SECONDS`).
- **The Muse connection drops midway.** If no text has arrived yet the question goes to the gateway instead; if the answer was already arriving, what arrived is spoken to the end instead of failing the whole turn.
- **The `display.show_text` command.** Lets Muse put text on the round screen directly, without rendering it as an image. White text on black; if it is longer than a screen it scrolls up line by line like a teleprompter, you can drag it with a finger, and a tap closes it. At most about 4,000 bytes (about 1,300 Chinese characters). By default it is also spoken with the gateway's synthesis (`speak: false` only shows it), and the scrolling follows the speech (estimated from the character count, not aligned word by word). It is enabled on the round-screen firmware (the Muse display backend) when TM1637 is not enabled.
- **All messages (push).** Settings → Sound → All messages (off by default). When on, an assistant message that Muse sends while no turn is waiting for it (Muse writing on its own, or a reply to something typed in the **main conversation**) wakes the screen and is spoken with the gateway's synthesis, and the connection is kept open while idle. Adapted from two commits of [wupsbr/waveshare-muse-gadget-sdk](https://github.com/wupsbr/waveshare-muse-gadget-sdk). Messages in thread conversations arrive only as a `sessions.updated` summary and are not spoken. Tested once on the Waveshare 1.75C in the main conversation.
- **Screen freeze fix.** Upstream PR #34 (`muse_lcd_bands.c`). LVGL's idle spinning while waiting for the display could starve the task that sends the screen data, so the screen froze while the rest of the firmware kept running. Now it blocks on a semaphore. On the 1.75C I verified only that it builds and runs; I have no data from a long standby.
- **Eyes avatar** (Settings → Avatar → Eyes, the default; Pixel Muse and Picture are the alternatives). Two white eyes that blink and look around; their shape follows Muse's state (idle, listening, thinking, speaking, error), and while speaking they move with the loudness. Touch gestures: tap — happy, double tap — surprised, long press — angry, press and drag — the eyes follow your finger, swipe up — surprised, swipe down — sleepy (swiping left or right still opens the settings). Tilting the board turns the gaze, and shaking it hard left and right four times makes the eyes dizzy (the board's QMI8658; only the Waveshare 1.75C is adapted). The eyes' shapes and gestures are adapted from [zongzhu-bot](https://github.com/Liu-zhongxian/zongzhu-bot) (MIT; the copyright and licence notice is kept at the top of the source files concerned).
- **Waiting ring.** When you release the button the ring around the screen starts timing and fills in 60 seconds, then clears and starts over; the device goes back to the thinking state while waiting, and the ring resets when the answer starts to be spoken.
- **A clean main screen.** The status icons, the status text, the speaker button and the button hints are hidden. A touch fades them in and 4 seconds later they fade out. While hidden they cannot be pressed: the first touch shows them, the next one uses them.
- **No background attempts to reach Muse when away.** With `MUSE_HOME_SSID` set and a different Wi-Fi joined, the background reconnects (the VM session, the token refresh, the Noise session and the chat session) pause and resume when the home Wi-Fi is back. The one attempt at boot, before Wi-Fi is joined, cannot be avoided.
- **WireGuard tunnel** (Settings → WireGuard: Off / Auto / Always). For networks from which Muse's server cannot be reached. In Auto, after the device is online it makes a quick TCP connection to Muse's server; if that works it stays direct, and only if it fails does it start the tunnel. Always uses the tunnel all the time. On the Wi-Fi named in `MUSE_HOME_SSID`, Auto never uses it. With the tunnel up, every new connection leaves through the server, and names are looked up through the tunnel with 1.1.1.1 / 8.8.8.8 (a router's DNS can return fake or poisoned answers); the decision is made again when the network changes. It uses the ESP-IDF component [esphome/wireguard](https://components.espressif.com/components/esphome/wireguard) (BSD-3). **You do not type keys on the round screen:** the device makes its own key pair (the private key never leaves it), sends the public key to the gateway with `POST /wg/enroll`, and the gateway returns the server's public key, address and the tunnel IP given to it. If it has no configuration the device asks by itself; "Get config" in the menu asks again, and Forget clears it. The last step is a person approving the key on the WireGuard server: `GET /wg/peers` lists the keys that asked, with the matching `wg set` commands. The gateway needs `WG_SERVER_PUB`, `WG_ENDPOINT` (the server's public address), and optionally `WG_PORT` and `WG_SUBNET` (default `10.77.0.`). How to set up the server side is in `docs/wireguard-server.md`. **In a cloud-only setup** (the gateway is on Cloudflare): turn on `MUSE_GATEWAY_VIA_TUNNEL` in Kconfig, so requests to the gateway also go through the tunnel, and Auto's decision counts the gateway too (the tunnel starts if either Muse or the gateway cannot be reached directly). **The server details can also be built into the firmware** (`MUSE_WG_ENDPOINT`, `MUSE_WG_PORT`, `MUSE_WG_SERVER_KEY`, `MUSE_WG_ADDRESS`); the device then does not ask the gateway, it only makes its own key pair, and the Settings → WireGuard page shows the server, the tunnel address and the full public key (the boot log prints it too); you add that key to the server as a peer. **To have everything configured before flashing**, `tools/muse-cloud.py firmware` does this by itself (`enabled = true` in `[wireguard]`); to do it separately, run once per device `tools/make-wg-config.py --address 10.77.0.2 --server-key SERVER_PUBLIC_KEY --endpoint SERVER_ADDRESS --append my-cloud.defaults`. It makes this device's key pair (pure Python, self-checked against the RFC 7748 test vector; I checked the public key it makes against the real `wg pubkey`), appends the settings (including the private key, `CONFIG_MUSE_WG_PRIVATE_KEY`) to your build settings, and prints the `wg set` line to run on the server. Run it on the server before flashing, and the device connects as soon as it boots, with nothing to do at the first start. The private key is in the firmware and in that settings file: do not commit them. `CONFIG_MUSE_WG_DEFAULT_MODE` sets the WireGuard mode out of the box (0 off, 1 auto, 2 always). Verified on the Waveshare 1.75C on the home Wi-Fi in Always mode: handshake, a real address resolved, connected to Muse. **Auto was also tested on a phone hotspot: the hotspot's DNS answered with a wrong address for Muse, the direct probe timed out, the device started the tunnel itself, the tunnel resolved the real address and Muse was reached.**
- **Who answers** (Settings → Answers: Muse / Grok Bot, and the model in a build that has it; default Muse; works at home and away). Muse: the question goes to Muse (if it cannot be reached, and the build has the model, the gateway's model answers; away, WireGuard is used to reach Muse). Grok Bot: every sentence goes to the Webhook bot. The model (the gateway's configured language model, only in the home-server setup): neither Muse nor the bot is asked. WireGuard's Auto starts the tunnel only when Muse is chosen. Requests to the gateway (recognition, chat, speech) are bound to the Wi-Fi interface, so even with the tunnel up they go straight to the public address and not round by the tunnel's server; only the connection to Muse uses the tunnel (checked with a packet capture on the WireGuard server: only Muse's addresses and the DNS inside the tunnel). `POST /chat` takes a `gemini: true` field for the model case.
- **Avatar** (Settings → Avatar: Eyes / Pixel Muse / Picture). Picture is a round picture of your own (233×233 RGB565, kept in a new `avatar` partition, so the partition table must be flashed once). `tools/make-avatar-img.py photo.jpg` crops it to a circle and converts it to the device's format, and `GW_AVATAR_URL='http://GATEWAY/avatar/set?k=ADMIN_TOKEN' … --upload` uploads it to the gateway (the admin token; the public proxy of the home setup does not pass `/avatar/set`); tap Get picture on the device to download it. If there is no picture, choosing Picture shows the eyes.
- **A 1 MB buffer for fetched speech** (in PSRAM). Early versions had a 256 KB buffer for one piece of speech (16 seconds at 128 kbps); a very long sentence was silently cut at the end while the next piece played normally, which sounded like a sentence missing from the middle. Now it is about 1.8 times the longest piece (35 seconds), and if a piece is cut anyway the log warns.
- **Memory.** This board's internal RAM is tight. The stacks of the per-turn network tasks (recognition, chat, fetching speech) and of the WireGuard manager task are in PSRAM (nothing in those tasks writes to flash); otherwise a long Muse reply stopped midway when fetching speech ran out of memory.
- **An error marker.** When the bot fails, the gateway sends `\u0001` followed by a code (`bot_timeout`, `bot_unreachable`), and the firmware shows `GROK BOT DIDN'T ANSWER` / `CAN'T REACH GROK BOT` instead of speaking it as if it were the answer.

## The settings menu (swipe left or right on the round screen)

| Menu | What it is |
|---|---|
| Wi-Fi, Muse, Bluetooth, Sound, Sleep, Battery | Upstream's own |
| **Answers** | Who answers: Muse / Grok Bot (plus the model if the build has it). Default Muse. Works at home and away |
| **WireGuard** | Off / Auto / Always; the state, the tunnel address and the device's public key; Get config asks the gateway again; Forget clears it (Forget is refused on a device whose server is built in) |
| **Avatar** | Eyes / Pixel Muse / Picture (a round picture of your own; tap Get picture to download it from the gateway) |

## Build options (Kconfig, in `esp32/components/muse/Kconfig`)

With `tools/muse-cloud.py` these are generated from `muse-cloud.toml`; you do not write them yourself.

| Option | What it does |
|---|---|
| `MUSE_STT_URL` `MUSE_TTS_URL` `MUSE_BRAIN_URL` | The three gateway addresses for recognition, synthesis and chat (with `?k=device token`). In the cloud-only setup all three point to the Worker |
| `MUSE_*_FALLBACK_URL` | Addresses to use when away from home (for the home-server setup; leave empty for cloud-only) |
| `MUSE_HOME_SSID` | The name of your home Wi-Fi. When set, the LAN addresses are used at home and the fallback addresses on any other network; leave empty for cloud-only |
| `MUSE_MODEL_ANSWERS` | `y`: Answers has the model, and it takes over when Muse or the bot fails. `n`: only Muse and the Grok Bot, and a failure shows an error |
| `MUSE_BRAIN_GIVEUP_SECONDS` | How long Muse may stay silent before the gateway's model is asked instead (default 30) |
| `MUSE_GATEWAY_VIA_TUNNEL` | Requests to the gateway also go through WireGuard (for networks that cannot reach Cloudflare) |
| `MUSE_WG_ENDPOINT` `_PORT` `_SERVER_KEY` `_ADDRESS` `_PRIVATE_KEY` | The WireGuard server and this device's key, built in; if not set, the device asks the gateway |
| `MUSE_WG_DEFAULT_MODE` | WireGuard mode out of the box: 0 off, 1 auto, 2 always |
| `ESP_NETIF_BRIDGE_EN` | Must be on when WireGuard is used (a trap in ESP-IDF 6.0.1: without it the chip crashes). The firmware now requires it itself |
| `MBEDTLS_CERTIFICATE_BUNDLE_CROSS_SIGNED_VERIFY` | Must be on to reach `*.workers.dev`; see below |
| `GADGET_SDK_TOKEN` | Your Muse SDK token (an upstream option) |

## Building by hand (without the tool)

```bash
git clone https://github.com/facebookincubator/muse-gadget-sdk.git
cd muse-gadget-sdk && git checkout fa07304
git apply /path/to/muse-gadget-cloud/firmware/muse-cloud.patch
```

Copy `firmware/sdkconfig.cloud-only.example` (cloud-only) or `firmware/sdkconfig.cloud.example` (home gateway) to a file that you **do not commit**, fill it in, and then (ESP-IDF 6.0.1):

```bash
cd esp32
. ~/esp/esp-idf-v6.0.1/export.sh
idf.py -B build -DIDF_TARGET=esp32s3 -DSDKCONFIG=build/sdkconfig \
  -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;devices/sdkconfig.muse;devices/sdkconfig.muse-waveshare-s3-175c;/absolute/path/to/your-file" build
cd build && python -m esptool --chip esp32s3 --port <serial port> -b 460800 write-flash "@flash_args"
```

Notes:
- `build/sdkconfig` remembers the values of the last run, and the overlay file does not overwrite them. After changing the overlay, delete `build/sdkconfig` before building.
- The first flash must write the bootloader, the partition table and the application together (`@flash_args` does that), because the partition table has a new partition for the avatar picture.
- If esptool cannot connect: hold BOOT, tap RST, then release BOOT to enter download mode.
- After flashing only the application partition with esptool, pairing is occasionally lost and you have to pair again in the Muse app.
- The SDK token is 48 characters: `mgst_` plus 43 more, and the last character is restricted; a wrong one stops the configuration step with an error.

## Why `CROSS_SIGNED_VERIFY`

The gateway is on `*.workers.dev`, and Cloudflare serves a Google Trust Services certificate chain that is cross-signed by GlobalSign. The firmware does not turn on `CONFIG_MBEDTLS_CERTIFICATE_BUNDLE_CROSS_SIGNED_VERIFY` by default and fails with `Failed to verify certificate` (-0x3000). The example overlay files and the settings the tool generates already turn it on. The device has no wall-clock time, so the certificate date check is off.

## Regenerating the patch

The patch is generated from the author's full working tree (`tools/make-cloud-patch.py` is not in this repository). If you want to change the firmware, edit the upstream checkout directly and `git diff` your own patch.
