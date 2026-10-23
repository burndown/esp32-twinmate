# 固件：补丁里有什么，怎么手工编译

[English](FIRMWARE.md) · **中文**

`firmware/muse-cloud.patch` 是对上游 Muse 固件 [muse-gadget-sdk](https://github.com/facebookincubator/muse-gadget-sdk) 提交 `fa07304` 的修改（28 个文件，主要在 `esp32/components/muse/`，命令注册在 `esp32/main/`）。平时用 `tools/muse-cloud.py firmware` 就够了，它会替你完成下面“手工编译”的全部步骤；这份文档讲补丁里每一项功能，以及不用那个脚本时怎么做。

目前只适配了 **Waveshare ESP32-S3-Touch-AMOLED-1.75C**（圆屏）。眼睛的倾斜和摇晃用的是板上的 QMI8658，别的板子没有适配。

## 补丁里的功能

识别、对话、合成三个客户端，Kconfig 选项，Unifont 16×16 中文字库，字幕和回复长度调整，以及这些保险：

- **识别回退**：`MUSE_STT_URL` 失败（或 5 秒没响应）就用 `MUSE_STT_FALLBACK_URL`。
- **Muse 等待时间**可配（`MUSE_BRAIN_GIVEUP_SECONDS`）。
- **Muse 连接中途断开**：还没收到字就改问网关；已经在回答就把收到的念完，而不是让整个回合失败。
- **`display.show_text` 命令**：让 Muse 把文字直接显示在圆屏上，不用渲染成图片。黑底白字，超过一屏就像提词器一样逐行向上滚，手指可以拖，点一下关闭；最长约 4000 字节（约 1300 个汉字）。默认同时用网关的 TTS 朗读（`speak: false` 只显示不念），滚动跟着朗读进度走（按字数比例估算，不是逐字对齐）。圆屏固件（Muse 显示后端）且没有开 TM1637 时启用。
- **所有消息（推送）**：设置 → Sound → All messages（默认关）。打开后，Muse 在没有回合等待它时发来的助手消息（Muse 主动写，或在**主对话**里打字的回复）会唤醒屏幕并用网关 TTS 念出来，空闲时也保持连接。实现改编自 [wupsbr/waveshare-muse-gadget-sdk](https://github.com/wupsbr/waveshare-muse-gadget-sdk) 的两个提交。线程会话里的消息只以 `sessions.updated` 摘要到达，不会被念。已在 Waveshare 1.75C 上用主对话实测过一次。
- **冻屏修复**：上游 PR #34（`muse_lcd_bands.c`）。LVGL 等刷屏时空转，可能把发送屏幕数据的任务饿死，屏幕冻住而其余固件照常。改成信号量阻塞。1.75C 上只验证了能编译、能运行，还没有长时间待机的数据。
- **眼睛头像**（设置 → Avatar → Eyes，默认；也可以选 Pixel Muse 或 Picture）：两只白色的眼睛，会眨眼、转眼神，形状跟着 Muse 的状态变（待机、聆听、思考、说话、出错），说话时眼睛随声音大小起伏。触摸手势：单击开心、双击惊讶、长按生气、按住拖动眼神跟着手指、上滑惊讶、下滑困倦（左右滑仍然是进入设置页）。倾斜板子视线跟着转，左右用力摇 4 下会发晕（用板上的 QMI8658，目前只适配了 Waveshare 1.75C）。眼睛的形状和手势改编自 [zongzhu-bot](https://github.com/Liu-zhongxian/zongzhu-bot)（MIT 许可，相关源文件头部保留了版权和许可说明）。
- **等待计时圈**：松手就开始计时，周围的圈 60 秒画满；等待期间回到思考状态，答案念出来时清零。
- **主屏干净**：状态图标、状态文字、喇叭按钮和按键提示平时隐藏，碰一下屏幕淡入，4 秒后淡出；隐藏期间点不到这些控件，第一下碰屏幕让它们出现，下一下才能操作。
- **不在家时不再后台试连 Muse**：设置了 `MUSE_HOME_SSID` 且连着别的 Wi-Fi 时，VM 会话、令牌刷新、Noise 会话和聊天会话的后台重连都暂停，回到家里的 Wi-Fi 后恢复。开机时连上 Wi-Fi 之前那一次试连无法避免。
- **WireGuard 隧道**（设置 → WireGuard：Off / Auto / Always）：给连不上 Muse 服务器的网络用。Auto 下，设备在联网后快速 TCP 连一下 Muse 的服务器，连得上就直连，连不上才拉起隧道；Always 一直走隧道；在 `MUSE_HOME_SSID` 那个 Wi-Fi 上 Auto 永远不走隧道。隧道起来后所有新连接都从服务器出去，域名也改由隧道里的 1.1.1.1 / 8.8.8.8 解析（路由器的 DNS 可能返回假地址或被污染的答案），换网络时重新判断。用的是 ESP-IDF 组件 [esphome/wireguard](https://components.espressif.com/components/esphome/wireguard)（BSD-3）。**配置不用在圆屏上输密钥**：设备自己生成密钥对（私钥不离开设备），向网关 `POST /wg/enroll` 提交公钥，网关回服务器公钥、地址和分给它的隧道 IP；没配置时设备会自己申请，菜单里的 Get config 可以重新申请，Forget 清掉。最后一步由人在 WireGuard 服务器上批准这把公钥：`GET /wg/peers` 会列出申请过的公钥和对应的 `wg set` 命令。网关要设 `WG_SERVER_PUB`、`WG_ENDPOINT`（服务器公网地址）、可选 `WG_PORT`、`WG_SUBNET`（默认 `10.77.0.`）。服务器端的搭法见 `docs/wireguard-server.md`。**纯云端配置下**（网关在 Cloudflare 上）：Kconfig 打开 `MUSE_GATEWAY_VIA_TUNNEL`，去网关的请求也走隧道，Auto 的判断会把网关一起算上（Muse 或网关任一个直连不通就起隧道）。**服务器地址也可以直接写在固件里**（`MUSE_WG_ENDPOINT`、`MUSE_WG_PORT`、`MUSE_WG_SERVER_KEY`、`MUSE_WG_ADDRESS`），这时不向网关申请，设备只是生成自己的密钥对；设置 → WireGuard 页会显示服务器、隧道地址和完整公钥（开机日志里也会打印），你把公钥加到服务器上当 peer 即可。**想在刷机前就把一切配好**：用 `tools/muse-cloud.py firmware` 时它自动做这一步（`[wireguard]` 里 `enabled = true`），下面是单独用的办法：对每台设备运行一次 `tools/make-wg-config.py --address 10.77.0.2 --server-key 服务器公钥 --endpoint 服务器地址 --append my-cloud.defaults`，它生成这台设备的密钥对（纯 Python，用 RFC 7748 的测试向量自检，生成的公钥我用真正的 `wg pubkey` 核对过一致），把配置（含私钥，`CONFIG_MUSE_WG_PRIVATE_KEY`）追加进你的构建配置，并打印服务器上要执行的那一行 `wg set`。刷机前先在服务器上执行，设备一开机就能连上，不需要任何第一次启动时的步骤。私钥在固件和那个配置文件里，不要提交。`CONFIG_MUSE_WG_DEFAULT_MODE` 决定出厂时的 WireGuard 模式（0 关、1 自动、2 一直开）。已在 Waveshare 1.75C 上、家里的 Wi-Fi、Always 模式下验证过：握手、解析出真实地址、连上 Muse。**Auto 模式在手机热点上也实测过：热点的 DNS 把 Muse 的域名解析成错误的地址，直连探测超时，设备自己起了隧道，隧道里解析出真实地址，连上了 Muse。**
- **谁来回答**（设置 → Answers：Muse / Grok Bot / Gemini，默认 Muse，在家在外都生效）：选 Muse 就问 Muse（连不上再回退到网关的模型，在外时用 WireGuard 连 Muse）；选 Grok Bot 每句话交给 Webhook 机器人；选 Gemini（网关配置的模型）既不问 Muse 也不问机器人。WireGuard 的 Auto 只在选 Muse 时才起隧道。去网关的请求（识别、对话、语音）绑定在 Wi-Fi 网卡上，隧道起着也直接走公网地址，不绕隧道服务器，只有连 Muse 的连接走隧道（在 WireGuard 服务器上抓 `wg0` 的包验证过：只有 Muse 的地址和隧道里的 DNS）。网关 `POST /chat` 新增 `gemini: true` 字段。
- **主页形象**（设置 → Avatar：Eyes / Pixel Muse / Picture）：Picture 是你自己的一张圆形图（233×233 RGB565，存在新增的 `avatar` 分区里，需要刷一次分区表）。`tools/make-avatar-img.py 照片.jpg` 裁成圆形并转成设备格式，`GW_AVATAR_URL='http://网关:8787/avatar/set?k=令牌' ... --upload` 传到网关（只在局域网，公网转发不放行 `/avatar/set`），设备上点 Get picture 下载。没有图片时选 Picture 会显示眼睛。
- **取语音缓冲 1 MB**（在 PSRAM 里）。早期版本里单段语音缓冲只有 256 KB（128 kbps 下 16 秒），超长的一句话会被无声截掉尾巴，下一段照常播放，听起来就是"丢了中间一句话"；现在约为最长一段（35 秒）的 1.8 倍，万一再被截断会在日志里报警。
- **内存**：这块板子的内部 RAM 很紧。每轮临时创建的网络任务（识别、对话、取语音）和 WireGuard 管理任务的栈放在 PSRAM 里（这些任务里不能写闪存），否则选 Muse 的长回复会在取语音时内存不够而中途停下。
- **错误标记**：网关在机器人失败时发 `\u0001` 加代码（`bot_timeout`、`bot_unreachable`），固件显示 `GROK BOT DIDN'T ANSWER` / `CAN'T REACH GROK BOT`，而不是把它当答案念出来。

## 设置菜单（圆屏左右滑进入）

| 菜单 | 说明 |
|---|---|
| Wi-Fi、Muse、Bluetooth、Sound、Sleep、Battery | 上游原有的 |
| **Answers** | 谁来回答：Muse / Grok Bot（编译时开着模型的话还有 Gemini）。默认 Muse。在家在外都生效 |
| **WireGuard** | Off / Auto / Always；状态、隧道地址、设备公钥；Get config 重新向网关申请；Forget 清掉（编译时写死了服务器的设备上不允许 Forget） |
| **Avatar** | Eyes / Pixel Muse / Picture（你自己的圆形图，点 Get picture 从网关下载） |

## 编译选项（Kconfig，在 `esp32/components/muse/Kconfig` 里）

用 `tools/muse-cloud.py` 的话，下面这些由 `muse-cloud.toml` 生成，不用自己写。

| 选项 | 作用 |
|---|---|
| `MUSE_STT_URL` `MUSE_TTS_URL` `MUSE_BRAIN_URL` | 识别、合成、对话三个网关地址（带 `?k=设备令牌`）。纯云端版三个都指向 Worker |
| `MUSE_*_FALLBACK_URL` | 不在家时用的备用地址（给家里的网关用，本仓库不含，留空） |
| `MUSE_HOME_SSID` | 家里 Wi-Fi 的名字。设了之后，在家用内网地址，其他网络用备用地址；纯云端留空 |
| `MUSE_MODEL_ANSWERS` | `y`：Answers 里有模型，Muse 或 Bot 失败时模型接手；`n`：只有 Muse 和 Grok Bot，失败就显示错误 |
| `MUSE_BRAIN_GIVEUP_SECONDS` | Muse 多久没回一个字就让网关的模型接手（默认 30） |
| `MUSE_GATEWAY_VIA_TUNNEL` | 去网关的请求也走 WireGuard（连不上 Cloudflare 的网络用） |
| `MUSE_WG_ENDPOINT` `_PORT` `_SERVER_KEY` `_ADDRESS` `_PRIVATE_KEY` | WireGuard 服务器和这台设备的密钥，编译时写死；不写则设备向网关申请 |
| `MUSE_WG_DEFAULT_MODE` | 出厂的 WireGuard 模式：0 关、1 自动、2 一直开 |
| `ESP_NETIF_BRIDGE_EN` | 用 WireGuard 时必须打开（ESP-IDF 6.0.1 的一个坑，不开就崩溃） |
| `MBEDTLS_CERTIFICATE_BUNDLE_CROSS_SIGNED_VERIFY` | 连 `*.workers.dev` 必须打开，见下 |
| `GADGET_SDK_TOKEN` | 你的 Muse SDK token（上游的选项） |

## 手工编译（不用脚本）

```bash
git clone https://github.com/facebookincubator/muse-gadget-sdk.git
cd muse-gadget-sdk && git checkout e6fe517
git apply /path/to/esp32-twinmate/firmware/muse-cloud.patch
```

把 `firmware/sdkconfig.cloud-only.example`（纯云端）复制成你**不提交**的文件，填好，然后（ESP-IDF 6.0.1）：

```bash
cd esp32
. ~/esp/esp-idf-v6.0.1/export.sh
idf.py -B build -DIDF_TARGET=esp32s3 -DSDKCONFIG=build/sdkconfig \
  -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;devices/sdkconfig.muse;devices/sdkconfig.muse-waveshare-s3-175c;/绝对路径/你的文件" build
cd build && python -m esptool --chip esp32s3 --port <串口> -b 460800 write-flash "@flash_args"
```

注意：
- `build/sdkconfig` 会记住上一次的值，而覆盖文件不会改写它。改了覆盖文件后，先删掉 `build/sdkconfig` 再编译。
- 第一次要把引导程序、分区表和应用一起刷（`@flash_args` 就是这样），因为分区表里新增了存头像的分区。
- esptool 连不上：按住 BOOT，点一下 RST，再松开 BOOT，进入下载模式。
- 用 esptool 只刷应用分区后，配对偶尔会丢，需要在 Muse App 里重新配。
- SDK token 的格式是 48 个字符：`mgst_` 加 43 个字符，最后一个字符有限制；不对会在配置阶段直接报错。

## 为什么要 `CROSS_SIGNED_VERIFY`

网关在 `*.workers.dev` 上，Cloudflare 发的是 Google Trust Services 经 GlobalSign 交叉签名的证书链。固件默认没打开 `CONFIG_MBEDTLS_CERTIFICATE_BUNDLE_CROSS_SIGNED_VERIFY`，会报 `Failed to verify certificate`（-0x3000）。示例覆盖文件和脚本生成的设置里已经打开。设备没有墙上时钟，证书日期校验是关着的。

## 补丁的重新生成

补丁是从作者的完整工作树生成的（`tools/make-cloud-patch.py` 不在这个仓库里）。你如果要改固件，直接在上游的检出上改，再 `git diff` 出自己的补丁就行。
