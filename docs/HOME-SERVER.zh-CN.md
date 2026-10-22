# 家里服务器版（`worker-home/`）

[English](HOME-SERVER.md) · **中文**

这份文档讲**完整版网关**：多家云服务商、本地识别、家里的大模型，跑在你自己的服务器上，局域网里用，出门时再给它一个公网入口。如果你只想要最简单的纯云端部署，不需要看这份，回到 [README](../README.md)。

先看这一版和纯云端版的区别：

| | 纯云端版 `worker/` | 家里版 `worker-home/` |
|---|---|---|
| 跑在哪里 | Cloudflare 免费账号 | 家里的服务器（`wrangler dev --local`），也可以部署到 Cloudflare |
| 识别 | Cloudflare Whisper（免费）或 Azure | 另外还有阿里、火山、本地 SenseVoice |
| 大模型 | 没有 | 通义、豆包、DeepSeek、任意 OpenAI 兼容服务（含 Gemini 订阅代理） |
| 合成 | Azure | 另外还有阿里 CosyVoice、火山 |
| 谁来回答 | Muse、Grok Bot | Muse、Grok Bot、模型；Muse 或 Bot 失败时模型接手 |
| 固件的编译选项 | `MUSE_MODEL_ANSWERS=n` | `MUSE_MODEL_ANSWERS=y`（默认） |

## 支持的服务商（完整版 `worker-home/`）

`worker/`（Cloudflare 版）只有 Cloudflare Workers AI（Whisper）和 Azure Speech 两家；下表是完整版的。

| | 阿里云百炼 | 火山引擎 | 微软 | 其他 |
|---|---|---|---|---|
| 大模型 | 通义千问，支持联网搜索（`enable_search`） | 方舟豆包，联网搜索走 Responses API 的 `web_search` 工具 | | DeepSeek；任意 OpenAI 兼容服务（含家里的 Ollama） |
| 语音识别 | Qwen3-ASR-Flash | 豆包录音文件识别极速版 | **Azure Speech**（短音频 REST，与语音合成同一把密钥和区域）；**Cloudflare Workers AI**（Whisper large-v3-turbo，免费、不需要密钥，只能在部署到 Cloudflare 的网关上用） | **本地服务器**（SenseVoice 经 sherpa-onnx，WAV 进、`{"text"}` 出） |
| 语音合成 | CosyVoice（WebSocket，输出 16 kHz MP3） | 豆包语音合成（HTTP v1） | **Azure Speech**（Neural 音色，REST，16 kHz MP3） | |

**用 CLIProxyAPI 接入 ChatGPT / Gemini 订阅（仅限家里网关，我自己实测过一次）**：[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 在内网提供 OpenAI 兼容接口，云端 Worker 够不到它，所以只能配在家里网关上。两种用法：

- **Gemini + 谷歌搜索（推荐，约 3 秒）**：服务商选"自定义"，接口地址填 `http://<你的内网地址>:8317/v1`，模型填 `gemini-3-flash`，"额外参数"填 `{"tools":[{"google_search":{}}]}`，不勾网关自己的联网搜索。
- **GPT + 搜索（约 17 秒才出第一个字，因为先搜索后写）**：服务商选"Responses 接口"，模型填 `gpt-5.6-sol` 一类，勾选联网搜索，额外参数可填 `{"reasoning":{"effort":"low"}}`。Gemini 走 Responses 接口时**不会搜索**，要用上一种。

这是把订阅账号经非官方代理当 API 用，可能违反服务条款，额度和封号风险自行评估。

网关会在系统提示里给模型当天日期，并要求涉及"今年、最新"的问题先搜索；回复里的 `*`、`#`、反引号会被去掉，避免字幕和语音里出现格式符号。

Azure 的音色很多：设置页的"刷新完整列表"会用你的密钥向 Azure 取回全部音色（几百个）供选择。

## 不在家也能用（家里网关的公网入口）

家里网关只监听内网地址。想让圆圆离家后继续用家里的识别、大模型和语音合成，可以给它一个公网入口，并让固件**按连的 Wi-Fi 名选地址**：是家里的 Wi-Fi 就走内网，其他网络一律走公网，与 Muse 是否配对、能否连上无关。

1. **HTTPS 转发**：`home/gw-proxy.mjs`（Node，无依赖）监听一个公网端口，只放行 `POST /chat`、`/tts`、`/stt`、`/bot-reply`、`/wg/enroll`、`/avatar`，其余一律 404；每个来源地址每分钟最多 60 次请求，连续 10 次令牌错误（403）会被封 10 分钟。用 `systemd --user` 常驻：先 `mkdir -p ~/gw-proxy && cp home/gw-proxy.mjs ~/gw-proxy/`，再装 `home/gw-proxy.service`（它启动 `~/gw-proxy/gw-proxy.mjs`；把 `YOUR_DOMAIN` 换成你的域名，把转发目标写进环境变量 `UP_HOST`）。
2. **证书**：家庭宽带的 80/443 通常是封的，所以用 [acme.sh](https://github.com/acmesh-official/acme.sh) 的 **DNS 验证**签 Let's Encrypt 证书；续期后给转发服务发 `SIGHUP` 即可热加载，不用重启。密钥只放在你自己服务器上权限 600 的文件里。
3. **路由器**：加一条 `公网端口 → 网关所在机器:同一端口` 的 DNAT 转发。如果公网地址是动态的，用 DDNS 让域名跟着走。
4. **固件**：Kconfig 里设置 `MUSE_HOME_SSID`（家里 Wi-Fi 名），以及三个备用地址 `MUSE_STT_FALLBACK_URL`、`MUSE_BRAIN_FALLBACK_URL`、`MUSE_TTS_FALLBACK_URL`（指向公网入口）。没设置 `MUSE_HOME_SSID` 时，固件改为对内网地址做 1.5 秒的 TCP 连接探测，不通就在 90 秒内改用备用地址。内网地址上请求失败（没收到任何数据）时，也会在备用地址上重试一次。

我在真机上用手机热点验证过：识别、回答、语音合成都走了公网入口并正常播出。**注意**：曾试过 Cloudflare 隧道做这个入口，从我家出口到 Cloudflare 绕美国，`/chat` 要 4 到 9 秒、`/tts` 要 4 到 40 秒且波动很大，所以改成了直接开端口。你的网络不同，结果可能不同。

## 接一个云端代理（Webhook 机器人）

有些代理（比如 Grok Bot）不是同步问答：收到 Webhook 后过几十秒才回话，而且回话不在 HTTP 响应里。网关为此做了一条通路（只在家里网关上配，需要上面的公网入口）：

1. **触发**：固件在不是家里 Wi-Fi 时，每次请求带 `"away": true`，网关把这一轮交给机器人；在家时只有说出机器人的名字（"问小黑……"）才交给它，其余仍走普通大模型。机器人联系不上时自动退回普通大模型。固件的 Answers 菜单里选 Grok Bot，则在家也每一轮都交给机器人。
2. **发出**：网关 `POST` 你的 Webhook，请求体 `{"message": "<你说的话> + 一段说明"}`，说明里要机器人用 HTTP `POST` 把答案发到 `https://<你的域名>:<端口>/bot-reply/<id>/<令牌>`，请求体 `{"reply": "…"}`（`text`、`message` 字段也认）。`id` 和令牌是**每次请求一对的一次性令牌**，10 分钟内有效，只能成功一次，不需要网关令牌。令牌放在路径里而不是查询参数里，是因为有的 Webhook 会把 `&` 转义成 `&amp;`；旧的 `?id=&t=` 写法仍然兼容。转发服务要把 `/bot-reply` 加进白名单，否则回调会被它拒绝成 404。
3. **等待**：网关**先**让设备念一句"收到，我去问小黑，请稍等。"，再发 Webhook（Webhook 发不出去时，网关接着用普通大模型把答案补在同一条回复里），然后保持连接，最长等 270 秒，机器人回调后把答案接着流给设备念出来；超时会说"小黑一直没有回话"。固件的读超时因此放宽到 300 秒，并且逐字节读流：ESP-IDF 的 `esp_http_client_read` 会一直等到缓冲区读满才返回，一句很短的确认话后面跟着几十秒空白，就会被卡在读取里，要等答案到了才被念出来。
4. **配置**：网关环境变量 `GROKBOT_URL`、`GROKBOT_AUTH`（Webhook 地址和密钥）、`BOT_CALLBACK_BASE`（公网入口的完整前缀）。密钥放在你自己服务器权限 600 的文件里，不要进仓库。机器人如果有"允许访问的外部地址"名单，要把你的域名加进去。
5. **可选：经一台有公网 IP 的中转服务器（`GROKBOT_VIA`）**。用 SSH 反向隧道把家里网关接到中转服务器（`home/bot-tunnel.service`），中转服务器的 nginx 按 `home/relay-nginx.conf` 放行回调路径、转发 Webhook。好处：回调走标准 443 和固定地址，不依赖家里的公网 IP 和入站端口；Webhook 也从路由更好的服务器发出。网关设置 `GROKBOT_VIA=http://127.0.0.1:18790` 后先走中转，中转不通时自动直连；`BOT_CALLBACK_BASE` 改成中转域名，`BOT_CALLBACK_FALLBACK` 写网关自己的公网地址：Webhook 改走直连时，给机器人的回调地址也同步换成这个，免得答案送到一条已经断了的路上。两种情况我都实测过（中转正常 15 秒；停掉隧道后 41 秒，答案仍然回得来）。两个坑：nginx 反向代理默认用 HTTP/1.0，有的机器人会回 `426 Upgrade Required`，要加 `proxy_http_version 1.1`；Webhook 路径是机密，中转站点要关掉访问日志。
6. **一个坑**：有的机器人所在的网络会把域名解析成 `198.18.x.x` 这类假地址（本地代理的假 IP）。网关会用公共 DNS 查到真实 IP，写进说明里，让机器人用 `curl --resolve` 直连。

我用真实的 Grok Bot 测过：发出、回调、接着念，全程 18.6 秒。设备上完整的"离家"那一轮在手机热点上也实测过：松手后约 11 秒听到确认话，约 32 秒拿到答案，整轮 99 秒（念了 60 秒）；请求的来源是热点出口，没有绕隧道。

## 在家里的服务器上跑网关

同一份 Worker 代码可以不经 Cloudflare，直接在家里的服务器上用 Cloudflare 开源的本地运行时（workerd，通过 `wrangler dev --local`）跑起来，只在局域网里可访问，文件在 `home/`：

```bash
mkdir -p ~/home-gateway/src && cd ~/home-gateway
cp /path/to/repo/home/package.json /path/to/repo/home/wrangler.toml .
cp /path/to/repo/worker-home/src/index.js /path/to/repo/worker-home/src/admin.html src/
npm install
printf 'GATEWAY_TOKEN=%s\n' "$(openssl rand -hex 24)" > .dev.vars && chmod 600 .dev.vars
# then install home/muse-home-gateway.service (fill in YOUR_USER and YOUR_LAN_IP) as a systemd unit
```

设置页在 `http://<内网地址>:8787/admin?k=<令牌>`，设置和密钥存在 `./state`（磁盘上的模拟 KV，明文）。为什么要有它：**云上的 Worker 对国内的服务商很慢**。实测（作者的网络，到 Cloudflare 的线路落在美国西海岸）同一句话合成云上 2.6 到 6.4 秒，家里版 0.7 到 1.3 秒；阿里云识别 2 到 4 秒对 0.5 秒；旧的“回到 Muse”模式下网关的 503 应答 0.4 秒加 TLS 握手对 15 毫秒（这个模式已经去掉）。内网用 http，ESP32 还省掉每次请求的 TLS 握手。

## Muse 怎么被问到

网关上不再有“回到 Muse”开关：谁来回答由设备决定，在设置 → Answers 里选。选 Muse 时，设备自己把识别出的文字发给 Muse，网关不参与这一问。如果 Muse 连不上，或者在设定时间（`MUSE_BRAIN_GIVEUP_SECONDS`，默认 30 秒）内一个字也没回，固件会带 `muse_down: true` 去问网关，这时网关用你选的大模型回答，不让回合失败。识别和播报始终用网关里选的服务商，录音不会上传给 Muse。（对旧固件：一个不带 `away`、`gemini`、`muse_down` 任何一个标记的问题，网关像以前一样回 `503`，意思是“这句话交给 Muse”。）

## 本地语音识别（可选）

固件可以把录音直接发给家里的识别服务（最快，录音不出家门），失败再回退到网关。如果想让**云上**的网关也用家里的识别服务，需要一条回家的通路，`homebox/asr_gate.py` 是一个带令牌校验的小网关（只听本机端口），再用 Cloudflare Tunnel 把一个域名接到它。**注意**：作者的家里出口到 Cloudflare 的线路很远，这条路径实测每个请求约 3.5 秒，比内网直连慢得多，所以仅作备用。

## 延迟与取舍

- 一轮对话的时间主要花在三处：识别（约 2 到 4 秒，含上传和 TLS）、大模型第一个字（普通问题不到 1 秒，需要真正联网搜索时 3 到 6 秒）、第一句合成。网关把长句拆成 10 到 40 字的小段并行合成再拼接，换来更短的首句等待。
- 拼接后的 MP3 在小段衔接处是否有可听见的瑕疵，我没有用耳朵逐段确认。
- 你的语音和对话内容会发给你选择的云服务商，这与使用 Muse 自己的云不同。

## 家里版的令牌

和纯云端版一样有两个令牌：设备令牌 `GATEWAY_TOKEN`（写进固件）和管理令牌 `ADMIN_TOKEN`（只在你的浏览器里，设置页 `http://<内网地址>:8787/admin?k=<管理令牌>`）。两个都写在 `.dev.vars` 里：

```bash
printf 'GATEWAY_TOKEN=%s\nADMIN_TOKEN=%s\n' "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" > .dev.vars && chmod 600 .dev.vars
```

家里版的设置页保存配置时是**整份覆盖**（不像纯云端版按段合并）：用接口改配置前，先读全量，改完再整份写回。
