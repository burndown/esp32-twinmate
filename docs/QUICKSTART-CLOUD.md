# 纯云端快速上手：一块 Waveshare 1.75C，用 Muse 和 Grok Bot

目标：不需要家里的电脑。圆屏上设置 → Answers 里选 Muse 或 Grok Bot；识别用 Cloudflare Whisper（或 Azure），合成用 Azure；Muse 或 Cloudflare 在你那里连不上时，通过一台你自己的 WireGuard 服务器出去。

## 要准备的

| 东西 | 说明 |
|---|---|
| 板子 | Waveshare ESP32-S3-Touch-AMOLED-1.75C 和一根 USB-C 数据线 |
| Muse | 一个 Muse 账号，和你的 SDK token（在 [gadgets.muse.ai](https://gadgets.muse.ai) 取，格式是 `mgst_` 开头的 48 个字符），并遵守其条款 |
| Cloudflare | 一个免费账号 |
| Azure | 一个 Speech 资源（免费档 F0）的密钥和区域 |
| Grok Bot | 可选。一个接收 Webhook、会把答案 POST 回来的机器人（见 README 的"接一个云端代理"） |
| WireGuard 服务器 | 可选，只有 Muse 或 Cloudflare 在你的网络里连不上时才需要。一台海外 Linux 服务器，见 [wireguard-server.md](wireguard-server.md) |

## 1. 部署 Cloudflare 网关

```bash
cd worker
npx wrangler login
npx wrangler kv namespace create muse-gateway-cfg      # 把输出的 id 填进 wrangler.toml 的 REPLACE_WITH_KV_ID
openssl rand -hex 24                                    # 生成网关令牌，记下来
npx wrangler secret put GATEWAY_TOKEN                   # 粘贴令牌
npx wrangler deploy
```

打开 `https://<你的worker>.workers.dev/admin?k=<令牌>`，依次填：Azure 区域和密钥，识别选 Cloudflare Workers AI（免费、不要密钥），Grok Bot 的 Webhook 地址和授权，点每一项的"测试"。机器人的"允许访问的外部地址"里要加上页面里显示的 Worker 域名。保存后最多约一分钟生效。

## 2. （可选）WireGuard 服务器

按 [wireguard-server.md](wireguard-server.md) 装好。每台设备在**刷机之前**运行一次：

```bash
python3 tools/make-wg-config.py --address 10.77.0.2 --server-key <服务器公钥> --endpoint <服务器地址> --append my-cloud.defaults
```

它把这台设备的 WireGuard 配置（含私钥）追加进 `my-cloud.defaults`，并打印要在服务器上执行的一行 `sudo wg set …`，先执行它。

## 3. 编译并刷固件

装好 [ESP-IDF 6.0.1](https://docs.espressif.com/projects/esp-idf/en/v6.0.1/esp32s3/get-started/index.html)，然后：

```bash
git clone https://github.com/facebookincubator/muse-gadget-sdk.git
cd muse-gadget-sdk && git checkout fa07304
git apply /path/to/muse-gadget-cloud/firmware/muse-cloud.patch
```

把 `firmware/sdkconfig.cloud-only.example` 复制成 `my-cloud.defaults`（第 2 步用过的话就是同一个文件），把带 `YOUR_` 的地方填上：Worker 地址、网关令牌、WireGuard 服务器信息（不用隧道就删掉 WireGuard 那一段），再加一行 `CONFIG_GADGET_SDK_TOKEN="mgst_…"`。**这个文件含令牌和私钥，不要提交。**

```bash
cd esp32
. ~/esp/esp-idf-v6.0.1/export.sh
idf.py -B build -DIDF_TARGET=esp32s3 -DSDKCONFIG=build/sdkconfig \
  -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;devices/sdkconfig.muse;devices/sdkconfig.muse-waveshare-s3-175c;/绝对路径/my-cloud.defaults" build
cd build && python -m esptool --chip esp32s3 --port <串口> -b 460800 write-flash "@flash_args"
```

第一次要把引导程序、分区表和应用一起刷（`@flash_args` 就是这样），因为分区表里新增了存头像的分区。如果 esptool 连不上：按住 BOOT，点一下 RST，再松开 BOOT，进入下载模式。

## 4. 配对并使用

刷好后在 Muse App 里配对。圆屏上滑进入设置：**Answers** 选 Muse 或 Grok Bot；**WireGuard** 里看状态（Auto 是只在连不上时才起隧道）。

## 验证到哪一步了（如实说明）

| 步骤 | 状态 |
|---|---|
| 补丁打在干净的上游 `fa07304` 上，用这份模板（填入占位值）从零编译 | **通过**（2026-10-21；第一次发现补丁漏了一个头文件，已修） |
| `worker/` 的配置能被 `wrangler deploy` 接受（`--dry-run`） | 通过 |
| 同样的 Worker 部署到 Cloudflare 免费账号，识别、合成、设置接口、真机器人、WireGuard 申请 | 通过 |
| 圆圆上 Muse、Grok Bot 各完整一轮（纯云端构建），网关请求走 WireGuard | 通过（在家里强制 Always 模式；Muse 走隧道在热点上单独验证过） |
| 提前生成密钥，刷机后隧道自动连上 | 通过 |
| **一个没有任何相关经历的人，只照这份文档从零做一遍** | **没有验证** |
| 对一块擦除过的全新板子做第一次完整刷机、配对 | 没有验证（我的板子是已经配过对的） |
| Muse SDK token 的申请、ESP-IDF 的安装 | 没有验证，写的是上游文档的做法 |
