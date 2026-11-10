# dsh-providers-live-models

[English](README.md) | 中文

[![test](https://github.com/Luca4Don3/dsh-providers-live-models/actions/workflows/test.yml/badge.svg)](https://github.com/Luca4Don3/dsh-providers-live-models/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

为 **DeepSeek Harness（DSH）** 提供实时模型目录：OpenCode Go、OpenCode Zen、原生 OpenAI Codex 与 OpenDesign。插件在运行时刷新各路由，提供逐模型开关、登录入口与订阅额度，并保留 OpenCode 网关要求的会话头和提示缓存；OpenDesign 的 DeepSeek 模型也会请求长提示缓存。插件不内置模型，上游变化无需这里发版。

另含压缩恢复：长历史按容量分段摘要，失败或取消保留原历史。

## 支持的路由

| 路由 | 目录 | 登录 / 凭据 | 额度 |
| --- | --- | --- | --- |
| `opencode-go` | Pi + Go 实时名单 | `OPENCODE_GO_API_KEY` | Go 额度 |
| `opencode`（Zen） | Pi + Zen 实时名单 | API Key 或 Console 设备登录 | Zen 余额 |
| `openai-codex` | Pi 公开目录 | 原生 ChatGPT OAuth | OpenAI 订阅 |
| `opendesign`（预发布） | 账号目录 | API Key 或设备授权 | 账号模式显示额度与钱包 |

## 安装

桌面端：**插件 → 添加插件**，粘贴 `github:Luca4Don3/dsh-providers-live-models`，点**立即启用**并重启 DSH。

CLI：

```sh
dsh plugin --profile desktop add github:Luca4Don3/dsh-providers-live-models
```

需要 DSH 0.1.5-rc.1+。OpenDesign 接受 DSH 0.2.x 搭配明确验证过的 pi-ai 1.1.x 或 1.3.x。已发布的组合全部通过离线宿主烟测：0.2.1-rc.5 配官方补丁版 pi-ai 1.1.0，0.2.2-alpha.2 / alpha.3 / rc.1 配官方补丁版 pi-ai 1.3.0。pi-ai 1.5.0 虽尚未随任何发行版发布，但配 0.2.2-rc.1 适配器通过了同一套测试，因此也放行。未验证的 pi-ai 版本线仍拒绝，注册前还会核对实际适配器及传输方法。不匹配时只停用 OpenDesign。`github:` spec 需要宿主机能访问 GitHub。

## 使用

1. 在 DSH 的 `llm-pi-ai` 中配置要用的路由。Codex 用原生 OAuth，Go 与 Zen 读取下面的 Key 引用。
2. 打开**插件 → dsh-providers-live-models**：登录 ChatGPT、OpenCode Console 或 OpenDesign，在**模型展示**中开关模型，点**保存选择**生效。
3. 打开**设置 → 账号与余额**查看额度；点**刷新额度**强制查询。卡片会跨重启缓存，`freshMs` 默认 5 分钟。

所有登录只写插件自己的凭据记录，不改写模型 API Key 或 Codex OAuth。

## 配置

在 `providers-live-models` 条目上设置：

```yaml
config:
  freshMs: 300000
  timeoutMs: 15000
  goApiKeyRef: OPENCODE_GO_API_KEY
  zenApiKeyRef: OPENCODE_API_KEY
  openDesign:
    protocol: chat-completions # 或 responses
    stripTemperature: false
```

`stripTemperature` 只在 OpenDesign 网关拒绝 `temperature` 时开启；`quotaSource` 可选 `auto`、`vela`、`control`。

OpenDesign 在宿主默认可重试集合之外，额外重试 `MALFORMED_RESPONSE`。自 DSH 0.2.2 起，单个不可用的工具参数串会在任何工具执行之前让整个助手回合失败，而宿主默认不重试该错误码。若网关把两个并行工具调用合并进同一个 `arguments` 字符串，回合会直接结束，只能由用户再发一条消息继续。重试次数与退避沿用宿主默认值。详见 [`docs/opendesign.md`](docs/opendesign.md#retry-policy)。

OpenDesign 中 ID 以 `deepseek` 开头的模型声明 `compat.supportsLongCacheRetention: true`，请求默认使用 `cacheRetention: long`。Chat Completions 和 Responses 传输据此发送 `prompt_cache_retention: "24h"` 及基于会话的 `prompt_cache_key`（需要会话 ID）；显式传输选项优先，其他模型不变。这是请求偏好，不保证网关实际保留时长或命中率。

## 限制

- 缺少完整描述符或协议不支持的模型只报告、不猜测，也不进入选择器。
- 目录每 5 分钟刷新；端点、间隔和缓存期固定在源码中。网关 base URL 刻意固定，远端目录不能改变请求目标。
- 会话头和 DeepSeek 长提示缓存是插件做的两项请求改写；请求或模型上显式配置的头始终优先。
- Zen 计费接口返回 403 只表示接口拒绝访问，不代表 Key 缺少权限；优先使用 Console 登录。
- 依赖 `llm-pi-ai` 内部接口；DSH 更新导致接口变化时会告警并保留原目录。
- DSH 内置 pi-ai 0.87.1 的 Go 路由没有 Google 传输，`gemini-4-argon-contributor` 在该路由不可用。

## 开发

```sh
npm test
```

离线固件，无需联网或凭据；CI 跑 Node 18 与 24。

可选真实宿主烟测（Node 24.9+）：在独立测试目录安装精确版本的宿主及官方补丁版 pi-ai，然后运行 `node --experimental-import-meta-resolve scripts/verify-opendesign-host.mjs <fixture-dir>`。脚本禁止实际 HTTP 请求，使用合成凭据和本地 SSE 固件；不验证上游接受情况或正在运行的 GUI。退出码 2 表示 OpenDesign 宿主版本门拒绝该环境。

更多：[OpenDesign](docs/opendesign.md) · [Provider 契约](docs/provider-contract.md) · [协议探测](docs/protocol-probing.md) · [目录注入](docs/catalog-injection.md)

## 许可证

MIT
