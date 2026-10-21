# 网关（`worker/`，Cloudflare 版）

固件只会说几个 HTTP 接口，网关把它们翻译成云服务的 API。这份文档讲 `worker/` 里这个精简的 Cloudflare 版：接口、令牌、设置页、防护、免费额度，以及验证到了哪一步。部署的步骤在 [README](../README.md)（`tools/muse-cloud.py gateway` 一条命令完成）。

## 接口

| 接口 | 谁调用 | 作用 |
|---|---|---|
| `POST /stt` | 设备 | 16 kHz PCM 录音 → `{"text": "…"}`，用 Cloudflare Whisper 或 Azure 识别 |
| `POST /tts` | 设备 | `{"text": "…"}` → MP3（16 kHz），用 Azure 合成，长句拆成小段并行合成再拼接 |
| `POST /chat` | 设备 | `{"text", "away"}`：`away` 为真时把问题交给 Grok Bot 并流式返回答案；否则返回 503，表示"这句话交给 Muse"。机器人失败时，回复里出现 `\u0001` 加代码（`bot_timeout` / `bot_unreachable`），固件显示成错误 |
| `POST /bot-reply/<id>/<令牌>` | 机器人 | 机器人把答案送回来。一次性令牌，不需要网关令牌；id 带签名，伪造的请求在碰到存储之前就被拒绝 |
| `POST /wg/enroll` | 设备 | 设备提交自己的 WireGuard 公钥，得到服务器信息和隧道地址 |
| `POST /avatar` | 设备 | 下载你放在网关上的圆形图 |
| `GET /admin?k=…` | 你 | 设置页 |
| `/admin/api`、`/admin/wg`、`/admin/test`、`/admin/voices`、`GET /wg/peers`、`POST /avatar/set`、`GET /health` | 你 | 管理接口 |

## 两个令牌

- **设备令牌** `GATEWAY_TOKEN`：写在固件里，所以谁拿到设备谁就拿到它。只能用于 `/stt` `/tts` `/chat` `/wg/enroll` 和下载头像。
- **管理令牌** `ADMIN_TOKEN`：只在你的浏览器里，用于设置页和所有管理接口，也可以放在 `Authorization: Bearer …` 头里。设备令牌打不开它们。
- 没设 `ADMIN_TOKEN` 时，设备令牌仍能打开管理接口（旧部署继续能用），设置页会提示。`tools/muse-cloud.py init` 会生成两个不同的随机令牌。
- 令牌必须是长随机串（`openssl rand -hex 24`）。网关对错误令牌不做次数限制；想要限制，可以在 Cloudflare 里加速率限制规则（免费版是否可用我没有核实）。令牌在 URL 的 `?k=` 里，会出现在访问日志中。

## 设置页

`https://<你的worker>.workers.dev/admin?k=<管理令牌>`，一个页面里设置全部，每一项都有"测试"按钮：

- **这个网关**：固件里要填的三个地址，Workers AI、Durable Object、管理令牌三个状态。
- **语音识别**：Cloudflare Workers AI（Whisper large-v3-turbo，免费、不要密钥）或 Azure Speech，和语言。
- **语音合成**：Azure 的区域、音色（可以拉取完整的几百个音色）、Azure Speech 密钥。
- **Grok Bot**：Webhook 地址和授权（存成密钥，页面只显示末四位）、可选的回调域名，以及“测试 Grok Bot”按钮（会真的问它一句）。机器人的“允许访问的外部地址”里要加上页面里显示的这个网关的域名。
- **WireGuard**：服务器公钥、地址、端口、隧道网段；下面列出申请过隧道的设备，每个设备一行 `wg set` 命令和“复制命令”按钮，你把它在 WireGuard 服务器上执行就是批准，再点“标记为已批准”；“吊销并释放地址”会释放它的隧道地址。页面里不存任何私钥。

保存是按段合并的，只改你改的那一段。**保存后最多约一分钟生效**：Cloudflare KV 的读取有缓存。页面保存的密钥放在你自己 Cloudflare 账号的 KV 里（明文），页面只显示末四位；更严格的做法是用 `wrangler secret put AZURE_SPEECH_KEY`、`GROKBOT_URL`、`GROKBOT_AUTH`（WireGuard 的服务器信息也可以用 `WG_SERVER_PUB`、`WG_ENDPOINT`、`WG_PORT`、`WG_SUBNET`）。

## 防护

- 请求大小有上限：`/stt` 2 MB、`/tts` 600 字、`/chat` 1000 字、头像 120 KB，超过返回 413。
- Azure 区域只接受 `eastasia` 这样的名字；Bot 的 Webhook 和回调地址只接受公网域名上的 https。这样管理页面被误用时，Azure 密钥和机器人凭证也不会被发到别处。
- WireGuard 登记在一个 Durable Object 里（`wrangler.toml` 的 `WG` 绑定和 `v2` 迁移，`wrangler deploy` 会一并创建）：并发登记不会拿到同一个地址，最多 20 个公钥同时等待批准，一周内没批准的会被忘掉。
- 令牌比较是常量时间的。
- Azure 免费档同时只能有 1 个实时请求，网关对合成最多并行 3 路，被限流（429）时会退避重试。
- Whisper 对静音会编出“字幕志愿者”之类的字幕，网关在录音几乎没有声音时直接返回空，并过滤这类字幕。

## Grok Bot 在 Cloudflare 上

网关**先**让设备念“收到，我去问小黑，请稍等。”，再发 Webhook，然后保持连接最长 270 秒，等机器人通过 `/bot-reply` 把答案送回来，再流给设备念出来。等待的状态放在 Durable Object 里（强一致，免费版可用 SQLite 版）；没有 `BOT` 绑定时退回 KV 轮询（最终一致，回答可能晚到最多一分钟）。**机器人的“允许访问的外部地址”里必须加入你的 `*.workers.dev` 域名**，否则 Webhook 能发出去，但回调被拦，网关会等满 270 秒才说机器人没有回话。机器人所在的网络如果把域名解析成 `198.18.x.x` 这类假地址，网关会用公共 DNS 查到真实 IP，写进说明里让机器人用 `curl --resolve`。

## 免费额度（需要自己核对最新数字）

- Azure Speech 免费档（F0）按[官方定价页](https://azure.microsoft.com/pricing/details/cognitive-services/speech-services)：语音识别每月 5 小时音频，神经语音合成每月 50 万字符，同时只能有 1 个实时请求。按一次问答录音约 5 秒、回答约 600 字估算，约合每月 3600 次提问或约 800 次长回答，**这是估算，不是实测**。
- Cloudflare Workers 免费版按[官方限制页](https://developers.cloudflare.com/workers/platform/limits/)：每天 10 万次请求，每次请求 10 毫秒 CPU 时间（等待网络不算），每次请求最多 50 个子请求。KV 每天约 1000 次写入的数字我只在第三方文章里见过，请以官方为准。一轮问答约 1 次识别加十几次语音请求，每天几千轮也用不完请求数。
- **没有长期数据的地方**：每次请求 10 毫秒 CPU 够不够拼接多段 MP3 和做流式转换——到目前为止几次完整的长回复都没有报超出限制，但没有长期的数字；Grok Bot 的回调状态放在 Durable Object 里，它在等待机器人时一直活着，免费额度能支持每天多少次对话我没有核实。

**Cloudflare Workers AI 的识别**：用 `@cf/openai/whisper-large-v3-turbo`，按[官方定价](https://developers.cloudflare.com/workers-ai/platform/pricing/)每音频分钟 46.63 个 Neurons，免费每天 10,000 个，约 200 分钟。用同一段中文录音经真实的 Worker 测过：识别正确（简体），稳定后约 1.2 秒，冷启动那一次 5.2 秒。**不要选 `@cf/openai/whisper`（不是 turbo 版）**，同一段话它输出繁体还错了一个字。语音合成不建议用 Workers AI 的 MeloTTS：它输出 44.1 kHz 的 WAV，而固件只解 MP3，Worker 免费版的 10 毫秒 CPU 又编不了 MP3，需要固件另加 WAV 播放，目前没做。

## 验证状态（如实说明）

| 项 | 状态 |
|---|---|
| 部署到 Cloudflare 免费账号；识别（Whisper、Azure）、合成、设置页和设置接口、真机器人、WireGuard 申请 | 通过 |
| 设置页在浏览器里逐项点过（桌面和手机宽度） | 通过（复制按钮的剪贴板内容没能确认，复制失败时会改为选中文字并提示） |
| 真机器人经 Cloudflare 免费账号：确认话立即出，约 11 到 22 秒拿到答案，Worker 这一段 CPU 时间只有 1 到 4 毫秒 | 通过（直接请求 Worker 测过，也在圆圆上测过一次完整的 Muse 一轮） |
| 圆圆上 Muse 的完整一轮（纯云端构建，所有请求只指向 Worker）：1469 字的回答分 11 次取语音，念了 94 秒，整轮 112 秒，没有超出 CPU 限制 | 通过 |
| 登记的并发（12 个同时）、地址耗尽、输入上限、区域和地址白名单、伪造回调、两个令牌 | 本地和真实 Worker 实测通过 |
| 机器人失败时设备显示错误 | 在圆圆上实测通过 |
| 免费版每次请求 10 毫秒 CPU 在更长的使用下是否一直够 | 没有长期数据 |
| Durable Object 免费额度（等待机器人时它一直活着）能支持每天多少次对话 | 没有核实 |
| 在没有任何背景的人按文档从零做一遍 | 没有验证 |
