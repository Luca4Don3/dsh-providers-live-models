# dsh-providers-live-models

English | [中文](README.zh-CN.md)

[![test](https://github.com/Luca4Don3/dsh-providers-live-models/actions/workflows/test.yml/badge.svg)](https://github.com/Luca4Don3/dsh-providers-live-models/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Live model catalogs for **DeepSeek Harness (DSH)**: OpenCode Go, OpenCode Zen, native OpenAI Codex and OpenDesign. The plugin refreshes each route at runtime, adds per-model switches, sign-in and subscription usage, and keeps OpenCode's gateway headers and prompt-cache retention. Nothing is bundled, so upstream changes need no release here.

It also adds compaction recovery: long histories are summarized in capacity-aware batches, and failures or cancellation preserve the original history.

## Routes

| Route | Catalog | Sign-in / credential | Usage |
| --- | --- | --- | --- |
| `opencode-go` | Pi + live Go roster | `OPENCODE_GO_API_KEY` | Go quota |
| `opencode` (Zen) | Pi + live Zen roster | API key or Console device login | Zen balance |
| `openai-codex` | Pi public catalog | native ChatGPT OAuth | OpenAI subscription |
| `opendesign` (prerelease) | account catalog | API key or device authorization | quota and wallet in account mode |

## Install

Desktop: **Plugins → Add plugin**, paste `github:Luca4Don3/dsh-providers-live-models`, choose **Enable now**, restart DSH.

CLI:

```sh
dsh plugin --profile desktop add github:Luca4Don3/dsh-providers-live-models
```

Requires DSH 0.1.5-rc.1 or newer. OpenDesign also needs DSH 0.2.1-rc.2 with pi-ai 1.1.0; a mismatch disables only OpenDesign. The host needs GitHub access for the `github:` spec.

## Use

1. Configure the routes you use in DSH's `llm-pi-ai` providers. Codex uses native OAuth; Go and Zen read the key references below.
2. Open **Plugins → dsh-providers-live-models**. Sign in to ChatGPT, OpenCode Console or OpenDesign, switch models under **Model display (模型展示)**, then **Save selection**.
3. Open **Settings → Account & balance** for usage. **Refresh usage** forces a query; cards are cached across restarts and `freshMs` defaults to five minutes.

All sign-ins write only the plugin's own credential records; model API keys and Codex OAuth are not overwritten.

## Configuration

Set these on the `providers-live-models` entry:

```yaml
config:
  freshMs: 300000
  timeoutMs: 15000
  goApiKeyRef: OPENCODE_GO_API_KEY
  zenApiKeyRef: OPENCODE_API_KEY
  openDesign:
    protocol: chat-completions # or responses
    stripTemperature: false
```

`stripTemperature` is only for OpenDesign gateways that reject `temperature`. `quotaSource` accepts `auto`, `vela` or `control`.

## Limits

- A model without a complete descriptor, or with an unsupported protocol, is reported and skipped, not guessed.
- Catalogs refresh every five minutes. Endpoints, interval and cache age are fixed in the source; gateway base URLs are deliberately fixed, so a remote catalog cannot redirect requests.
- OpenCode session headers and DeepSeek long prompt-cache retention are the plugin's two request rewrites; explicit request or model headers always win.
- A 403 from the Zen billing endpoint means the endpoint denied access, not that the key lacks permission; Console login is preferred.
- The plugin uses `llm-pi-ai` internals. A DSH update that changes them logs a warning and keeps the installed catalog.
- With DSH's bundled pi-ai 0.87.1, the OpenCode Go route has no Google transport, so `gemini-4-argon-contributor` is unavailable there.

## Development

```sh
npm test
```

Offline fixtures; no network or credentials needed. CI runs Node 18 and 24.

More: [OpenDesign](docs/opendesign.md) · [provider contract](docs/provider-contract.md) · [protocol probing](docs/protocol-probing.md) · [catalog injection](docs/catalog-injection.md)

## License

MIT
