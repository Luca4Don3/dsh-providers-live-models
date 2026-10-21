# Why the OpenAI group can disappear (evidence status)

Investigating `dsh-workbuddy-connect` + this plugin. This note separates what was
proven from source, what was proven by mock, and what remains unproven.

## Proven from source

1. The installed host ships pi-ai 1.1.0, whose built-in `openai-codex` catalog
   contains only `gpt-5.3-codex-spark`, `gpt-5.5`, `gpt-5.6-luna`, `gpt-5.6-sol`.
   The profile configures `gpt-6-astra`, `gpt-6-luna`, `gpt-6.1-sol` — none of them
   exist in that built-in catalog.
2. `PiAiAdapter.listModels` returns `snapshot.models.getModels(provider)`; it does
   not read the configured list. A model missing from the snapshot is therefore
   absent from the picker even though configuration names it.
3. `modelOf` throws `UNKNOWN_MODEL` when the snapshot has no descriptor, and
   `INVALID_CONFIG` when the profile carries a `modelErrors` entry or a
   `catalogError` (which happens when the whole route failed to resolve).
4. This plugin repairs those descriptors through `loadNativeCatalogs()`, which
   imports `@earendil-works/pi-ai/providers/*.models` **bare** from the plugin's own
   location, then writes them into that same imported object.
5. dsh-app-boot resolves bare imports from a profile-local copy first when one
   exists; host modules under the installation keep their own copy. So a hoisted
   `@earendil-works/pi-ai` in the profile (which WorkBuddy 0.7.8 brings, at 1.3.0)
   makes step 4 write into a different object than the one the host adapter reads.

## Proven by mock

`buildModelCatalog` isolates `listModels` per provider, but resolves the models of
one provider with an unguarded `Promise.all`. One failing model moves the whole
provider into `failures` and out of `groups`, so the entire OpenAI group vanishes
rather than a single row. Verified against the real function, with mocks.

## Not proven

Why only the OpenAI group failed that time. `opencode-go` is also configured with
models absent from the built-in catalog, so "absent from the built-in catalog"
alone does not explain the difference; the failing step (UNKNOWN_MODEL vs
INVALID_CONFIG vs an unrelated throw) was never captured. No host log from that
session survives, and the profile no longer contains WorkBuddy.

WorkBuddy itself is not the direct cause: its patch only inserts its own entry, it
registers only `workbuddy`/`workbuddy-ai`, and it sends a global
`llm/adapters-updated`. The plausible harm is indirect — the hoisted pi-ai copy.

## How to confirm next time

When the group is missing, open the GUI's model-catalog response (RPC
`session/modelCatalog`) and read `failures`: it names the provider and the message.
`UNKNOWN_MODEL` points at a descriptor/snapshot gap; `INVALID_CONFIG` points at a
route/profile resolution failure. That single field distinguishes the two paths.

## One-shot confirmation (needs the user's go-ahead)

This changes the profile, so it has not been run. It distinguishes the hypothesis
from a lookalike failure in about ten minutes.

1. Install WorkBuddy 0.7.8 through the plugin manager and restart DSH.
2. `node scripts/check-pi-ai-duplication.mjs ~/.dsh/profiles/desktop 1.1.0`
   Expect `SPLIT` and exit 1. Without it, the hypothesis is wrong and the cause
   lies elsewhere.
3. Open the model picker: the OpenAI group should be missing.
4. Open the GUI's model-catalog response (RPC `session/modelCatalog`) and copy the
   `failures` entry for `openai-codex`. `UNKNOWN_MODEL` means the snapshot lacked
   the descriptors; `INVALID_CONFIG` means the route failed to resolve.
5. Remove WorkBuddy, restart, and re-run the detector. It should say `OK` and the
   group should return, which ties the two states to the same cause.

The detector is read-only. It never reads credentials, never writes the profile,
and was checked against a synthetic split profile (reports `SPLIT`), a matching
version (reports `OK`), and this machine's current profile (no copy, `OK`).

## Node-level proof of the split

Run against two synthetic trees under `.temp/duplication-lab` (a host tree with
pi-ai 1.1.0, a profile tree with 1.3.0, each carrying a plugin that bare-imports
`@earendil-works/pi-ai/providers/openai-codex.models`):

```
host    -> ["gpt-5.6-sol"]      // 1.1.0 catalog
profile -> ["gpt-6.1-sol"]      // 1.3.0 catalog
```

Same specifier, same process, two different objects. So step 4 of the chain —
"the plugin imports pi-ai from its own location" — is not a guess about DSH's
resolver; it is ordinary Node resolution, and the host adapter keeps reading its
own copy because an installation module's importer never walks into the profile.

## Still missing: why only the OpenAI group

`opencode-go` and `opencode` have live rosters (`rosterUrl`) and cached catalogs;
`openai-codex` has `rosterUrl: null` in this plugin and relies on the native
catalog plus the pi.dev catalog. That asymmetry is the best available explanation
for the blast radius, but it was not demonstrated: the cache from 2026-10-19
already contained the gpt-6.x rows, and a last-known-good catalog should have
survived a failed refresh. Without the `failures` message from that session, the
difference between "empty group" and "stale group" cannot be settled.

## What would prevent it

Do not rely on a bare `import()` of pi-ai from a profile plugin. Resolve the
host's own copy (`ctx.get('pluginPackages').packageOf(...)` plus
`resolvePluginResource`, as the new OpenDesign bridge does) and refuse to patch
when the copies differ.
