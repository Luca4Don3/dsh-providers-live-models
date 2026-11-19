# DSH host compatibility

## Verified package combinations

| Host adapter | Host-owned pi-ai | Status |
| --- | --- | --- |
| `@deepseek-ai/dsh-llm-pi-ai@0.2.1-rc.5` | `1.1.0` (patched) | PASS |
| `@deepseek-ai/dsh-llm-pi-ai@0.2.2-alpha.2` | `1.3.0` (patched) | PASS |
| `@deepseek-ai/dsh-llm-pi-ai@0.2.2-alpha.3` | `1.3.0` (patched) | PASS |
| `@deepseek-ai/dsh-llm-pi-ai@0.2.2-rc.1` | `1.3.0` (patched) | PASS |
| `@deepseek-ai/dsh-llm-pi-ai@0.2.2-rc.2` | `1.3.0` (patched) | PASS |
| `@deepseek-ai/dsh-llm-pi-ai@0.2.2-rc.3` | `1.3.0` (patched) | PASS |
| `@deepseek-ai/dsh-llm-pi-ai@0.2.2-rc.4` | `1.3.0` (patched) | PASS |
| `@deepseek-ai/dsh-llm-pi-ai@0.2.2-rc.5` | `1.3.0` (patched) | PASS |
| `@deepseek-ai/dsh-llm-pi-ai@0.2.2-rc.1` | `1.5.0` (unpatched, ahead of release) | PASS |

`0.2.2-rc.4` and `0.2.2-rc.5` were smoke-tested against the real published packages, not inferred from rc.3: `scripts/verify-opendesign-host.mjs` passes for both protocols plus the overlay check on rc.5, and `adapter.ts` is byte-identical across rc.3 and rc.5 (`f3f9ac00`).

The gate accepts DSH 0.2.x and **only** the verified pi-ai 1.1.x / 1.3.x lines, plus 1.5.0 which passes the same smoke test against the 0.2.2-rc.1 adapter ahead of any release shipping it. It does not permit arbitrary pi-ai 1.x releases. Malformed versions, missing adapter/transport methods and unproven package ownership are rejected before route registration. It always uses the host-owned package rather than a profile peer.

`engines.dsh` is `>=0.2.1-rc.5 <0.3.0-0`, matching how the runtime gate treats the 0.2 line: a new 0.2.x patch or pre-release installs without a plugin release, while 0.3.0 and every 0.3 pre-release is refused until the adapter is re-checked against its actual surface. The upper bound is `<0.3.0-0` rather than `<0.3.0` so a 0.3.0 pre-release cannot slip in under SemVer's prerelease ordering.

## What was exercised

The optional [real-host smoke script](../scripts/verify-opendesign-host.mjs) imports the actual published adapter and patched pi-ai, prohibits real HTTP requests, and uses synthetic keys with local SSE responses.

For each host combination and each OpenDesign protocol (Chat Completions / Responses), it checks:

- Signed-out discovery does not fetch a roster or expose models.
- Model listing, resolution and prepared calls work with the real host.
- Text and tool-call streams decode; the cache-read usage counter is preserved.
- DeepSeek sends `prompt_cache_retention: "24h"` and a session cache key; other models do not acquire the long-retention preference.
- An old prepared request cannot run with a different account; cancellation sends no request.
- In-memory model visibility preferences are respected without rewriting them.
- OpenDesign disposal removes only its own registration.

It also mounts the main overlay on a real host `PiAiAdapter` / pi-ai `Models` collection and checks OpenCode session/cache options, unchanged Codex options, collection rebuilds and restoration on unload. The stream providers in that overlay-only check are synthetic; no OpenCode/Codex network or OAuth flow is exercised.

The ordinary offline suite additionally checks version rejection and missing-method guards. No user credential store or production profile is used by these tests.

## Reproducing the optional smoke test

Use Node 24.9+ and an isolated fixture directory containing the chosen host package. Pin the pi-ai version explicitly: the host npm caret dependency can otherwise resolve a newer, unverified release. Apply the corresponding official DSH patch:

- [rc.5 workspace](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/pnpm-workspace.yaml), [pi-ai 1.1.0 patch](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/patches/%40earendil-works__pi-ai%401.1.0.patch)
- [alpha.2 workspace](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-alpha.2/pnpm-workspace.yaml), [pi-ai 1.3.0 patch](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-alpha.2/patches/%40earendil-works__pi-ai%401.3.0.patch)

Run from the plugin checkout:

```sh
node --experimental-import-meta-resolve scripts/verify-opendesign-host.mjs <fixture-dir>
```

Exit code 0 means all package-level checks passed; 2 means the compatibility gate rejected the host, and an assertion failure is a test failure.

## Limits

This is not a live desktop/browser end-to-end test and does not prove provider-side login, quota access, acceptance of cache hints, cache hits or actual cache TTL. The settings UI uses private component wrappers; static review and the mock UI suite do not replace checking the UI after an actual upgrade. DSH and pi-ai internal API changes still require re-verification.