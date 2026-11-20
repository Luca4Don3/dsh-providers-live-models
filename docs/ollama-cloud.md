# Ollama Cloud quota design

Status: **draft, not implemented.** Nothing in `lib/` reads Ollama yet.

## Why this is not just "another window provider"

Every provider so far reports *percentages of a limit*: Codex's 5-hour and weekly
windows, OpenCode Go's three windows, OpenDesign's two. Ollama's current plans do
not. They report **money**: a monthly pool of usage credits that refreshes on a
billing period, plus separately purchased credits that never expire.

Two consequence follow, and both shape the design:

1. The card must show a dollar pair (`remaining / allowance`), not only a percent.
2. The period length is the subscriber's billing cycle (28-31 days), so it cannot
   ride on the existing `windowMinutes` title scheme unchanged.

## Data sources (official, documented)

### `GET https://ollama.com/api/balance`

`Authorization: Bearer $OLLAMA_API_KEY`. No query parameters.

Current plans:

```json
{
  "included": {
    "balance_usd": 72.5,
    "allowance_usd": 100,
    "period": { "from": "2026-09-15T09:30:00Z", "until": "2026-10-15T09:30:00Z" }
  },
  "purchased": { "balance_usd": 25 }
}
```

Legacy plans return windows instead of a dollar pair:

```json
{
  "included": {
    "session": { "remaining_percent": 75, "resets_at": "2026-10-01T07:00:00Z" },
    "weekly": { "remaining_percent": 40, "resets_at": "2026-10-05T00:00:00Z" }
  },
  "purchased": { "balance_usd": 25 }
}
```

Rate limit: **10 requests/minute per user**, shared across keys and devices;
`429` carries `Retry-After`. The plugin's default `freshMs` is 5 minutes, so the
limit is not reachable by ordinary use.

### `GET https://ollama.com/api/usage?range=24h|7d|30d[&group_by=model]`

Returns request counts, token counts and `usage_usd` over the range. This is
**history**, not remaining quota, so it does not belong in the same line as the
balance. Optional.

### Unauthenticated behaviour

`GET /api/balance` without a key answers `401 {"error":"invalid credentials"}`,
which is how the adapter distinguishes "no key" from "wrong key".

## Plan names: use Ollama's own, exactly

The balance payload carries **no plan name**, so the name comes from Ollama's
published plan list and is matched on the allowance it publishes. Names are the
vendor's, verbatim — no invented tiers, no translations:

| Official plan | `allowance_usd` | Price |
| --- | --- | --- |
| Pay as you go | no pool | per token; purchased credits only |
| Pro | 60 | \$20/mo or \$200/yr |
| Max | 300 | \$100/mo |
| Team | 1000 | \$500/mo, shared across the team |
| Enterprise | custom | contact sales |

Matching rule: **exact equality on `allowance_usd`**, with a small tolerance only
for float representation (compare cents as integers). A value that matches no
published allowance stays unnamed — that is what protects a prorated first month
or a promotional pool from being labelled wrong.

`Pay as you go` reports no `included` pool at all, which is the signal for it:
when `included` is absent or `allowance_usd` is 0, name the plan `Pay as you go`
only if `purchased.balance_usd` is present; otherwise leave the line empty.

Two consequences worth stating:

- A **Team** allowance is shared, so the name alone does not imply whose usage it
  is. The card shows the number; the docs say the pool is shared.
- Allowances can change between plans (they did on 2026-08-31), so the table is
  the contract. When Ollama publishes new numbers, the table is updated in the
  same change as the tests.

## Card layout (same shape as every other card)

Current plans:

```
Ollama                              可用
Pro                                  (only under option B)
1月                          剩余 72.5%
US$72.50 / US$100.00
重置：2026/10/15 09:30:00
钱包余额：US$25.00                    (purchased credits only)
更新于 11/19 14:54
```

Legacy plans fall back to the existing window rows:

```
5小时                        剩余 75%
重置：2026/10/01 07:00:00
1周                          剩余 40%
重置：2026/10/05 00:00:00
```

Rules behind that:

- Synthesise one window: `{ id: 'monthly', remainingPercent, resetsAt: period.until }`
  and **no `windowMinutes`**. `windowTitle()` then returns `1月` from the id
  fallback table, so a 28-day and a 31-day cycle both read as one month instead of
  `4周` / `31天`.
- The dollar pair renders as one line under that window. It is the same number as
  the percent, shown in the unit the vendor bills in.
- `purchased.balance_usd` is a wallet, so it uses the existing `钱包余额：` line.
  It is **not** mixed into the percent: purchased credits are spend beyond the
  allowance, not part of it.
- `remainingPercent` is `balance_usd / allowance_usd * 100`, clamped. If
  `allowance_usd` is 0 or absent, no percent window is emitted at all — the card
  shows purchased credits only, never `剩余 0%`.
- Free / pay-as-you-go accounts with neither an allowance nor a positive balance
  report `status: 'unknown'` and no windows, which the card already renders as
  剩余额度未知.

## Status mapping

| Vendor signal | Snapshot status |
| --- | --- |
| `included.balance_usd > 0` or a window reports `remaining_percent > 0` | `ready` |
| allowance exhausted (`balance_usd == 0`) with a positive `period.until` | `exhausted` |
| `401` | `auth-required` |
| `429` | `rate-limited` |
| `403` | `risk-control` |
| `503` / `5xx` | `upstream` |
| unreadable body | `invalid-response` |

Note that "exhausted" is not final for Ollama: usage past the allowance simply
continues at per-token rates against purchased credits, so an exhausted card must
not claim requests will fail.

## What has to change beyond the adapter

1. **The 4-subscription cap.** `MAX_SUBSCRIPTIONS = 4` (client) and `slice(0, 4)`
   (server) both truncate. Four providers are configured today, so Ollama would be
   dropped silently. Both must rise together, and the test that asserts four must
   be updated.
2. **One adapter file** `lib/subscription/providers/ollama.js` with
   `isConfigured` / `displayKey` / `resolveAuth` / `fetchUsage` / `normalize`,
   keyed by `OLLAMA_API_KEY` like the Go and OpenRouter adapters. No sign-in card:
   Ollama publishes API keys only, there is no documented device flow.
3. **A normalizer** `normalizeOllamaCloud()` in `normalize.js` covering both the
   dollar shape and the legacy window shape.
4. **Client**: one `providerTitles` entry (`ollama: 'Ollama'`), one optional
   `planTitles` entry, and the dollar-pair line.
5. **Tests**: fixture-driven, mirroring `normalize` table tests.

## Deliberately out of scope for phase 1

- **Routing Ollama as an LLM provider.** Whether the host can route it at all is
  **unverified**: `pi.dev` has no `ollama` catalog entry (`404`), and I could not
  read the bundled `@earendil-works/pi-ai` module list out of `app.asar` to confirm
  it ships an `ollama` provider. Phase 1 is a quota card only, exactly like
  OpenCode Zen's balance card; adding a route is a separate question with a
  separate gate.
- **Model catalog.** `https://ollama.com/api/tags` answers `200` unauthenticated
  with 24 cloud models, but without context windows or prices. Feeding it into the
  unified catalog needs a roster parser that does not exist yet.
- **Usage history line.** `/api/usage` is available and could add
  "近 24 小时：N 次请求 · US$X", but it is a second request per refresh and a
  different kind of number from quota.

## Which cost unit each provider uses

Three shapes now coexist, and the card must not confuse them:

| Provider | Unit | Where it lands on the card |
| --- | --- | --- |
| Codex, OpenCode Go, OpenDesign | percent of a time window | window row |
| Command Code | percent of a dollar cap **and** a credit balance | window row + `display` + wallet |
| Ollama | dollars of a monthly pool, **no percent cap** on some plans | dollar pair + wallet |
| Mistral (if ever) | spend against an optional monthly limit | balance row |

The rule that follows: **a provider with no cap gets no percent**, and a
provider whose cap is money shows the money beside the percent.

## Verification gaps

- **No key on this machine.** `grep OLLAMA` over the credential store returns
  nothing, so nothing here has been exercised against a live account. The shapes
  above come from the official docs, and the `401` body was observed live.
- **No fixture yet.** Phase 2 needs a recorded, redacted `/api/balance` response
  for both the dollar and legacy shapes before any parser is trusted.
