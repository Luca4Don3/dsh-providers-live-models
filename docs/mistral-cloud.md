# Mistral subscription design

Status: **draft, not implemented.** No key-based quota endpoint exists to read.

## Yes — Mistral sells plans that cover GLM and DeepSeek

That part was right, and it changes the picture: the reason to support Mistral is
not only Mistral's own models. Its plans resell **third-party open-weight models**
as first-class entries:

| Model in Mistral's catalog | Origin | Notes |
| --- | --- | --- |
| `zai-glm-5-3`, `zai-glm-5-2`, `zai-glm-5-3-flash` | Z.ai | 1M-token context |
| `deepseek-v4-1-flash-1017` | DeepSeek | text + image, 1M context |
| `mistral-large-4`, `mistral-medium-3.5`, `codestral-*`, `devstral-*`, `ministral-*`, `voxtral-*`, `pixtral-*` | Mistral | native |

Confirmed from `https://pi.dev/api/models/providers/mistral?types=chat`: **34 model
entries**, all on `api: "mistral-conversations"`, `provider: "mistral"`,
`baseUrl: https://api.mistral.ai`. The docs page describes GLM 5.3 and DeepSeek
V4.1 Flash 1017 as "third-party open weight models" it hosts.

So a Mistral plan is a **third way to reach GLM and DeepSeek**, alongside OpenCode
Go and OpenDesign — which makes a quota card genuinely useful, not a nice-to-have.

## What the plan gives you, in Mistral's own words

From the Subscription docs:

> Your Mistral plan controls access across Vibe, Studio, and the API. Available
> plans include Free mode, Pro, Education, Team, and Enterprise.
>
> Each Mistral plan includes monthly usage that is shared across Studio, the API,
> and Vibe Code. Usage consumes this monthly allowance first. When your included
> monthly usage is exhausted, access depends on your plan settings. If
> pay-as-you-go is enabled, additional usage draws from your prepaid credits.

Published figures ([pricing](https://mistral.ai/pricing/)):

| Official plan | Price | Monthly API credits |
| --- | --- | --- |
| Free | \$0 | none |
| Pro | \$25.5/mo | \$15 |
| Education | \$14.99/mo (students) | \$15, capped at 12 months |
| Team | \$24.99/user/mo | \$50 (shared) |
| Enterprise | custom | custom |

Note the shape: **allowance + shared across products + optional prepaid overflow.**
That is the same shape as Ollama's pool (and OpenCode's Go + Zen wallet), so the
card model already exists: one quota window plus a wallet line.

## The blocker is authentication, not the shape

The plan data is in the Admin Panel, and the only documented programmatic path is
the Admin API — **Enterprise only, not self-serve**:

> The Admin API is available only on **Enterprise** plans, and access isn't
> self-serve. On other plans, you can't create an Admin API key, and a standard API
> key doesn't work with admin endpoints.

Observed live:

| Request | Result |
| --- | --- |
| `GET /v1/admin/usage` no key | `401` |
| `GET /v1/admin/spend-limit` invalid key | `401 {"detail":"Invalid API Key"}` |
| `GET /v1/admin/rate-limit` no key | `401` |
| `GET /v1/models` invalid key | `401 {"detail":"Invalid API Key"}` |
| `/v1/usage`, `/v1/billing/usage`, `/v1/subscription`, `/v1/me`, `/v1/credits` | `404` — none of these exist |

So on a Pro plan there is **no endpoint a plugin key can call** to learn
"\$15 included, \$X spent". That is why every consumer-grade implementation uses the
admin web session ([CodexBar's notes](https://github.com/steipete/CodexBar/blob/main/docs/mistral.md)):

```
GET https://admin.mistral.ai/api/billing/v2/usage?month=&year=
GET https://admin.mistral.ai/subscription
GET https://admin.mistral.ai/api/billing/credits
GET https://console.mistral.ai/api-ui/trpc/billing.vibeUsage?...
```

with `ory_session_*` (and `csrftoken` for the console fallback) cookies, and a
redirect to `auth.mistral.ai/self-service/login` once expired.

## So the choice is narrower than it looked

| Option | Needs | Verdict |
| --- | --- | --- |
| **A. Admin API key** | Enterprise; key from Admin Panel | Works structurally, and reports **spend** (`/v1/admin/usage`) and **limits** (`/v1/admin/spend-limit`) — two numbers that map cleanly onto a quota card. Most accounts cannot get a key. |
| **B. Admin web session** | Cookie jar, CSRF, re-login on expiry | No: the plugin has no cookie storage, and these are undocumented UI routes. |
| **C. Route only, no quota** | `MISTRAL_API_KEY` + the pi.dev catalog | **Viable now**: add `mistral` as a *routing* scope so GLM/DeepSeek via Mistral appear in the model picker, and show no quota card. |
| **D. Nothing** | — | leaves the resale path unreachable. |

**Recommendation: C now, A when a key exists.** C is the part that can be built
entirely from documented, key-authenticated data: the catalog, and the route.
Quota waits for a credential that can actually read it.

## What C would take (routing only)

`lib/index.js` gains one scope; the client gains one group title:

```js
{
  id: 'mistral',
  label: 'Mistral',
  catalogUrl: 'https://pi.dev/api/models/providers/mistral?types=chat',
  rosterUrl: null,                       // no documented public roster
  apiBaseUrls: new Map([
    ['mistral-conversations', 'https://api.mistral.ai'],
  ]),
  rosterNoun: 'Mistral',
}
```

Two facts make this safe:

- `mistral-conversations` is a **real pi-ai transport** — the bundled
  `dist/api/mistral-conversations.lazy.js` exists, and the host's compat table
  already carries `"mistral-conversations": { supportsMidConvoSystemMessages: "withhold" }`.
- The host already recognizes the provider: its defaults list
  `"mistral": { env: ["MISTRAL_API_KEY"], defaultBaseURL: "https://api.mistral.ai" }`.

So routing needs no new transport, only a scope entry and a key.

## What A would add

`GET /v1/admin/usage?month=&year=` returns consumption by category (`chat`,
`completion`, `ocr`, `audio`, `connectors`, `libraries_api`, `fine_tuning`,
`vibe_usage`) with `start_date`, `end_date` and `currency`;
`GET /v1/admin/spend-limit` returns the Organization cap. Card:

```
Mistral                            可用
本月消费 US$3.40 / 上限 US$50.00
chat US$2.10 · vibe_usage US$1.30
重置：下月 1 日
```

Rules that still apply: no cap configured → **no percentage**; the plan line stays
empty because nothing reports the plan, and the allowance figure is not the
published \$15/\$50 (those are included credits, not the spend cap).

## Verification status

| Claim | Evidence |
| --- | --- |
| Plans share one monthly allowance across API/Vibe/Studio | Official docs, quoted above |
| Pro \$25.5 incl \$15; Team \$24.99/user incl \$50 | Official pricing page |
| GLM 5.3 / DeepSeek V4.1 Flash sold as Mistral-hosted models | Official models page |
| 34 models on `mistral-conversations` at `api.mistral.ai` | `pi.dev` catalog, fetched live |
| Admin API is Enterprise-only | Official docs |
| `/v1/admin/*` refuses without a valid key | Observed live (`401`) |
| No non-admin usage endpoint | Observed live (`404` on five candidate paths) |
| Actual plan allowance for an account | **Not verified — no Mistral credential here** |
