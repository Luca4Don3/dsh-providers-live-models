# OpenDesign integration (0.12.0-rc.1 prerelease)

This page records what the local prerelease adds, where its behaviour comes from,
and what has **not** been verified. It is a development build; it has not been
installed into the running DSH profile or published.

## Scope

A fourth provider, `opendesign`, is registered beside the existing
`opencode-go`, `opencode` and native `openai-codex` routes. Nothing replaces,
patches or unregisters another provider. Disabling OpenDesign or a failed
OpenDesign startup leaves the other three untouched (covered by a synthetic
`workbuddy` registration in the provider tests).

## Authentication

Two isolated modes, both stored in the plugin-owned credential record
`dsh-providers-live-models/opendesign`:

| Mode | What is stored | Models | Quota |
| --- | --- | --- | --- |
| API key (manual) | `sk-amr-…` runtime key only | yes | unsupported; reported as unsupported, never as zero |
| Account (device authorization) | runtime key + `vela_ctrl_…` control key | yes | subscription windows and wallet |

Rules enforced in code and tests:

- The runtime key is sent only to `https://amr-link.open-design.ai`; the control
  key is sent only to `https://amr-api.open-design.ai`. Neither crosses over.
- Control-plane requests use `redirect: 'error'`, reject userinfo and a different
  origin, and cap response bodies.
- No read of the OpenDesign desktop app's own credentials, no `vela` CLI, no
  environment fallback, no session-history scan.
- Logout deletes only the plugin record, and only through the host's public
  `deleteRecord`; when that is unavailable it reports `unsupported` rather than
  faking deletion.
- Local HTTP controls accept only a loopback Host, a same-origin page and JSON
  POST bodies; status responses are field-whitelisted and never contain keys.

The device-authorization endpoints, request fields and quota endpoints follow a
**community** OpenCode/magpie adapter (dbydd/opencode-opendesign-auth, commit
8201bbe). They are not an official protocol guarantee and were not exercised
against a real account here.

## Models

`GET https://amr-link.open-design.ai/v1/models` is fetched per active account.

- `metadata.context_limit` becomes the context window.
- `metadata.context_budget` is **not** treated as an output cap; it is retained in
  diagnostics only.
- `metadata.output_budget` is informational, not an enforced vendor limit.
- Invalid descriptors are rejected individually; valid rows survive and the
  rejected count is shown in the detail page.
- No static Go roster is presented as an account's entitlement.

## Protocols

Chat Completions is the default, matching the supplied DSH reference plugin
(EliteOtaku/dsh-opendesign-go). Responses remains available explicitly; the
vendor supports it, but this repository only exercised Responses through wire
mocks, not against the vendor endpoint.

Existing OpenCode per-model protocol selection and the native Codex Responses
transport are not altered.

## Request budget

`outputTokenBudget` (default 8192) is a **local request budget**, not a claim
about the vendor's capability. An explicit caller cap is honoured up to that
budget.

## Why the launcher is never imported

An earlier build resolved the host's pi-ai through
`@deepseek-ai/dsh-app-boot`'s `resolvePluginResource`. Importing the launcher from
a **profile plugin** turned out to stall startup: the application became
unusably slow and the Models page rendered empty. Removing that import — and
reading the host package's `exports` map instead — restored normal startup
immediately, on a machine where the profile still carries a second pi-ai copy.

The rule that follows: a profile plugin may read host package metadata, but must
never import the boot module graph. `lib/host-resolve.js` exists to make that
possible, and `grep -r "dsh-app-boot" lib/` should only ever match comments.

## Host bridge and versions

`loadOpenDesignHost` gates on:

- `@deepseek-ai/dsh-llm-pi-ai` **0.2.1-rc.2**, resolved from the host importer and
  required to be the installation copy;
- `@earendil-works/pi-ai` **1.1.0**, located through the host package's own
  `pluginPackages.packageOf()`. Its `exports` map is read straight from the parsed
  manifest, so the file a loader would pick is found **without importing
  `@deepseek-ai/dsh-app-boot`** — the launcher never enters this plugin's module
  graph, at startup or later;
- a bare `import(specifier)` is used only when both sides provably resolve to the
  same directory; a differing copy is refused instead of patched.

Any mismatch disables OpenDesign alone. No pi-ai dependency is declared — note
that this package previously carried `"@earendil-works/pi-ai": "*"` as an optional
peer, which let pnpm bind it to whatever copy the profile resolved (1.3.0 once
another plugin hoisted one). That peer is gone; the plugin now consumes the
host's copy exclusively.

The resolved-profile object passed to `PiAiAdapter` is a version-bound shim for
0.2.1-rc.2, because that release does not export a profile resolver. It is not a
stable public API and must be re-reviewed on a DSH upgrade.
## Choosing which models to offer

The plugin page lists the roster with one checkbox per model. Only checked models
are offered to the harness; the rest stay in the list (dimmed) so they can be
turned back on. "全部开启 / 全部关闭" flips the whole set. Selections are stored in
`<profile>/.dsh-providers-live-models/opendesign.json` — ids only, never a
credential — and the route is republished immediately, so the change applies
without a restart.

The endpoint rejects ids the current roster does not carry, so a stale preference
cannot accumulate and silently filter a model that reappears later.

## Reasoning levels

The picker offers a reasoning control only for models whose accepted levels are
documented. Both DeepSeek and GLM document three control values — `low`, `high`
and `max` — so those families declare exactly three levels and nothing else. A
level the table omits is declared unsupported (`null` in `thinkingLevelMap`), and
an unset `off` means "send no reasoning parameter". Every other model declares
nothing, so the picker shows no control rather than an option the gateway might
reject.

These levels are documented vendor behaviour, not something this plugin verified
against the live endpoint; a level that turns out to be refused surfaces as the
gateway's own error.

## Known unverified items

- Real account authorization, device approval in a browser, and key revocation.
- Whether `vela_ctrl_` currently permits `/billing/preflight`; a community CLI
  channel and a console-session channel use different permissions.
- Real `/v1/models` payload variety and the vendor's Responses streaming path.
- Whether a real `billing/summary` 403 occurs; the adapter keeps verified windows
  and warns about an unknown wallet instead of discarding them.

## Configuration

```yaml
config:
  openDesign:
    enabled: true
    protocol: chat-completions # or responses
    outputTokenBudget: 8192
    stripTemperature: false
```

### Quota channels

Two ways to read the remaining Design Plan allowance and wallet:

| Source | Needs | What it reads |
| --- | --- | --- |
| `vela` | Open Design desktop app installed and signed in | `team-projects list`, `billing funding-check`, optional `billing summary` |
| `control` | This plugin's device-account authorization | `workspaces/current`, `billing/preflight`, optional `billing/summary` |

`quotaSource` defaults to `auto`: when a `vela` binary is found the desktop
login is used and no plugin credential is needed; otherwise the control-plane
path runs and API-key-only installs report `unsupported` rather than zero.
`control` forces the control plane even when `vela` exists, and `vela` forces the
CLI.

`vela` discovery is deliberately narrow: `OPENDESIGN_VELA_PATH`, then the
official install directory, then `PATH`. It is a private CLI, so every field is
validated; a window missing a duration or credit amount is dropped, an unusable
set is an explicit error, and `billing summary` failing (it returned 403 on
2026-10-19) falls back to the documented 10,000 credits/USD instead of erasing
already-read windows. Nothing from `vela` is logged.
### stripTemperature

Default **off**. Enabled, it removes only the `temperature` member from request
bodies sent to OpenDesign and leaves every other field untouched. It exists
because the shared Chat Completions transport forwards `temperature`
unconditionally (`openai-completions.js` writes it whenever it is defined, with no
capability check), while some models behind the gateway reject the parameter.

The Auto preset's reviewer always sends `temperature: 0`, so switching a session to
an OpenDesign model can surface that rejection as a failed tool call. This switch
fixes that path without editing the reviewer or touching another provider; the
cost is that an explicit temperature is also dropped for OpenDesign requests.

