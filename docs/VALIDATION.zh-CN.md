# 验证记录

[English](VALIDATION.md) · **中文** · [返回 README](../README.md)

本文保存原 README 中已有的 2026-10-21 测试记录。整理文档时未重新部署、编译或刷写设备；以下“通过”表示此前记录的结果。

## 构建与部署

- 补丁可应用到干净的上游提交 `fa07304`，从 `muse-cloud.toml` 生成配置并从零编译；固件包含补丁功能和新增分区。包含启用 WireGuard 的编译组合。
- 已运行 `tools/muse-cloud.py` 的 `init`、`check`、`gateway`、`status`、`firmware`。网关真实部署到 Cloudflare 免费账号，测试 Worker 随后已删除。

## 脚本刷写后的 Muse 语音交互

在 Waveshare ESP32-S3-Touch-AMOLED-1.75C 上使用 `firmware --flash` 刷写，设置 `wireguard.enabled = false`，完成一轮 Muse 交互。识别使用 Cloudflare Whisper，语音合成使用 Azure，两者均通过自己的 Worker。

| 指标 | 原记录 |
|---|---|
| 问题 | 1 句，11 个字 |
| 回复语音请求 | 20 次 |
| 播放时长 | 55 秒 |
| 整轮耗时 | 135 秒 |
| 最低可用内部内存 | 12 KB |

首次尝试时，脚本遗漏 `CONFIG_ESP_NETIF_BRIDGE_EN`，设备约每 4 秒重启一次，并丢失配对。修复后固件强制要求该选项，在 Muse App 中重新配对，第二次测试通过。

## 擦除全部闪存后的重建与配对

同一块开发板的全部闪存擦为 `0xFF` 后，由脚本从零获取上游、应用补丁、编译和刷写。设备进入配对状态，在 Muse App 中配对后，完成语音识别、Muse 回答和语音合成一轮，整轮耗时 39 秒，没有重启。

这块开发板的出厂数据分区原本为空。**该测试不能替代全新出厂开发板的首次使用验证**。

## 尚未覆盖的场景

- 使用脚本刷写后，在设备上完成 Grok Bot 回答。已有 Worker 端的机器人通路验证，不能据此判定该设备流程已通过。
- 启用 WireGuard，并在设备上使用脚本生成的密钥。编译成功不等于设备端连接已通过。
- 没有相关经验的使用者，仅按 README 从零完成设置。
- 全新出厂开发板的首次刷写和配对。
- 其他开发板，以及 Windows 原生环境。脚本通过 `bash` 调用 ESP-IDF 的 `export.sh`，Windows 可能需要 WSL。
