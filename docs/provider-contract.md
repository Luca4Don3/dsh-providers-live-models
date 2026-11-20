# Provider integration contract

Every provider this plugin manages follows one shape. Adding a provider means
satisfying each point below; the tests in `test/subscription/client.test.mjs`
fail when one is skipped.

## 1. One sign-in card per provider

- Title is the provider's name plus what the card does, e.g. `OpenCode Console 登录`.
- The right edge shows the current state, one of `未登录` / `等待授权` / `已登录`.
- One sentence says what signing in gives you.
- Signed in, the actions are exactly two: **重新登录** (primary) and **退出登录**
  (destructive). Neither carries the provider name — the card already says which
  provider it is.
- Signed out, the actions are the sign-in entry (plus a cancel while a device flow
  is in progress). Two credentials are never requested at once: choosing one path
  withdraws the other until cancelled.
- Signing out removes only this provider's own credential record. It never touches
  another provider's record, and the confirmation text says so.

## 2. One row in the unified model catalog

- The provider contributes a group to `GET /dsh-providers-live-models/opendesign/routes`.
- Channels of the same provider share one group, stacked as labelled sub-lists
  (OpenCode Go above OpenCode Zen). A provider with one channel still gets its own
  group.
- Each group shows `enabled / total`, an expand/collapse control, and a
  select-all toggle. Both fold controls change presentation only: they never save,
  discard a draft, or issue a request.
- Every model is controlled by the same iOS-style switch. Edits stay in a local
  draft; one **保存选择** posts each changed channel exactly once.
- Group labels use proper case (`OpenCode Go`, `OpenCode Zen`, `OpenAI`,
  `OpenDesign`), never the raw route id.
- Nothing about model discovery or switching lives on the sign-in card.

## 3. What the sign-in card must not contain

Model counts, model refresh, protocol notes, quota hints — all of that belongs to
the catalog above. The card exists to sign in and out.

## 4. Storage

- Model switches: `.dsh-providers-live-models/opendesign.json`, one
  `providers.<id>.disabledModels` entry per channel, plus the OpenDesign set at the
  top level. Only ids are stored.
- Credentials: the host credential service. One record per provider; a provider
  never writes another's record.
- A failed write surfaces as `storage-unavailable` rather than a silent no-op.

## 5. Display names reach the session picker

The session picker groups by `providerInfo(id).name` as stored at registration.
The registry keeps that value, so a provider's friendly name must be written onto
the stored entry (and `llm/adapters-updated` emitted) — wrapping `providerInfo`
after registration has no effect.

## Adding a provider

1. Server: append its group to the routes payload (with `group` and, if needed,
   `note`).
2. Client: add one entry to the `groups` table — no bespoke component.
3. Card: reuse the sign-in card shape above, including both signed-in actions.
4. Storage: one `providers.<id>` key, with a matching logout route that deletes
   only its own record.
5. Tests: the card test, the grouped-catalog test, and the casing test all cover it.

A worked example of designing a provider before writing any code is
[`ollama-cloud.md`](ollama-cloud.md): the billing-unit shape, the plan-name policy,
what breaks at the 4-subscription cap, and what is deliberately out of scope.

## Plan names

A plan line always prints the **vendor's own plan name**, spelled as the vendor
spells it (`Go Plan` / `Go Plus` / `Go Teams`, `GPT Plus`, `GOAT`, `Pro`, `Max`,
`Team`). Never invent a tier, never translate it, never renumber it.

The name must come from a reliable source, in this order:

1. The vendor reports it in a response field (`plan_type`, `product`, `planId`).
2. The vendor publishes it beside a number the response does carry (an allowance
   or credit figure), matched **exactly**, compared in integer cents.
3. Otherwise the line is empty.

Step 2 exists because a marketing pool can be prorated or promotional; an exact
match on a published number will not silently mislabel. When a vendor changes its
published allowances, the table and its tests change in the same commit.
