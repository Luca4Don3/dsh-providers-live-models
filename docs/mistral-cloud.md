# Mistral subscription design

Status: **draft, not implemented.** Nothing in `lib/` reads Mistral yet.

## The blocker: there is no API-key endpoint

Every provider this plugin reads today authenticates with a key the host credential
store already holds. **Mistral has no such path.** From the official docs:

> The Admin API is available only on **Enterprise** plans, and access isn't
> self-serve. On other plans, you can't create an Admin API key, and a standard API
> key doesn't work with admin endpoints.

That is a hard boundary, not a configuration problem. What the Admin API would
give is:

- `GET https://api.mistral.ai/v1/admin/usage?month=&year=` — cost and consumption
  for the Organization, broken down by category (`chat`, `completion`, `ocr`,
  `audio`, `connectors`, `libraries`). **Historical spend, not remaining quota.**
- Subscriptions and billing pages exist in the Admin Panel, but they are
  documentation for the *web UI*, not a published JSON contract.

## What consumer-plan quota actually requires: a browser session

The only implementations found that read a **non-Enterprise** Mistral account do
so with the admin web session, not an API key. [CodexBar's
notes](https://github.com/steipete/CodexBar/blob/main/docs/mistral.md):

```
GET https://admin.mistral.ai/api/billing/v2/usage?month=<m>&year=<y>
GET https://admin.mistral.ai/subscription          (included API / Vibe allowances)
GET https://admin.mistral.ai/api/billing/credits   (credit balance)
GET https://console.mistral.ai/api-ui/trpc/billing.vibeUsage?...   (fallback)
```

Requirements they document:

- Cookie `ory_session_*` is mandatory; `csrftoken` is needed for the console
  fallback, sent as `X-CSRFTOKEN`.
- An expired session answers with a redirect to
  `auth.mistral.ai/self-service/login`, treated like 401/403.
- The session is bound to `admin.mistral.ai`; the console fallback forwards only
  its own two cookies, keeping the rest origin-bound.

This plugin has no cookie-import mechanism. Its whole credential model is the host
service's key records, and the OpenDesign/OpenCode sign-ins both end in a **token**
stored in that service, never a cookie jar.

## So this is a decision, not an implementation detail

| Option | What it needs | Fits the plugin today? |
| --- | --- | --- |
| **A. Admin API (Enterprise only)** | An Admin API key from the Admin Panel; user must be on Enterprise | Structurally yes: it is a key, like the others. But then it is *spend history*, not quota, and most accounts have no such key. |
| **B. Browser-session scraping** | A cookie jar plus a CSRF flow, plus re-login when the session expires | No: there is no cookie storage, and scraping an undocumented web route is exactly the fragility the OpenCode work avoided. |
| **C. Do not support Mistral** | — | Honest, and leaves no half-working card. |

**Recommendation: C until an Admin key exists, then A.** The plugin's rule all
along has been that a provider shows what its *official, documented* API reports,
and never invents a number from an undocumented page.

## Plan names: use Mistral's own, exactly

Mistral publishes three consumer plans, and the Admin API does not report which
one an Organization is on. The names are the vendor's, verbatim:

| Official plan | Price | Monthly API credits |
| --- | --- | --- |
| Free | \$0 | none |
| Pro | \$25.5/mo | \$15 |
| Team | \$24.99/user/mo | \$50 (shared) |
| Enterprise | custom | custom |

`Education` is a discount variant of Pro, not a separate tier name, so it does not
get its own label.

Because no endpoint reports the plan, naming it would require inferring from the
credit figure — the same rule as Ollama applies: match a **published** number
exactly, and leave the line empty when nothing matches. Under option A the
allowance shown is the Organization's spending limit, which is **not** the plan's
credit figure, so in practice the plan line stays empty and the card shows spend
and limit only.

## If A is chosen, the shape is already designed

The card would be a **balance card**, not a subscription card, because the Admin
usage endpoint reports money already spent over a period rather than a remaining
allowance:

```
Mistral                            可用
本月消费 US$12.40 / 上限 US$50.00
chat US$9.10 · completion US$3.20 · ocr US$0.10
重置：下月 1 日
更新于 11/20 10:00
```

Mapping to the existing model:

- `scope: 'balance'`, so it takes the full-width money row.
- One synthetic window per *category* is wrong: categories are cost buckets, not
  quotas. Instead report the Organization monthly limit as one window
  (`remainingPercent = (limit - spent) / limit * 100`) and keep the per-category
  breakdown as text rows.
- If the Organization has no monthly spending limit configured, emit **no
  percentage** and show spend only — an absent cap is not a 0% cap.
- The Organization limit resets monthly, so the same "no `windowMinutes`, id
  `monthly`" trick from `ollama-cloud.md` applies.

## Verification status

- Admin usage endpoint requires Enterprise and a non-self-serve key: **documented**.
- Unauthenticated `GET /v1/admin/usage` answers **401**: **observed live**.
- The admin cookie routes and their payload shapes: **read from a third-party
  implementation**, not observed here, and not an official contract.
- **No Mistral credential exists on this machine**, so nothing was exercised.
