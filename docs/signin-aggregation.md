# Signed-in-first card layout

Status: **implemented** as *ordering*, not grouping. The original plan (collapse
signed-out cards into one group) was abandoned after an experiment — see
*Why the group was dropped* below.

## The problem

The plugin detail page renders three sign-in cards unconditionally, in a fixed
order:

```js
function PluginSettings() {
  return h('div', null, h(GptLoginSection), h(OpenCodeLoginSection), h(OpenDesignLoginSection), h(RouteModelSection))
}
```

Every card fetches its own status on mount and shows one of `未登录` / `已登录`
/ `等待授权`. With three providers that is one screen of mostly-empty cards; with
Command Code, Ollama, Mistral and OpenRouter added it becomes a wall of "未登录"
that hides the one or two providers a user actually configured.

The user's proposal: **让已登录的卡片排在前面，未登录的收进一个聚合区域**，
only expanded on request.

## What stays the same

- One card per provider, same component, same copy, same two signed-in actions
  (**重新登录** / **退出登录**). The contract in `provider-contract.md` §1 still
  applies verbatim; this changes *ordering and visibility*, not card content.
- A signed-out card must still be reachable in one click for the first sign-in.
  Collapsing it away entirely would make onboarding impossible.
- Any card with a device flow in progress (`等待授权`) is **always visible**, even
  if signed out: hiding a card mid-flow would hide the code and the cancel button.
- A card that failed to load its status is treated as *unknown*, not as signed
  out, and stays visible: an unknown state must not silently disappear.

## Proposed layout

```
┌─ 已登录 ─────────────────────────────────────────────┐
│  OpenAI        已登录      [重新登录] [退出登录]       │
│  OpenCode      已登录      [重新登录] [退出登录]       │
│  OpenDesign    已登录      [重新登录] [退出登录]       │
└──────────────────────────────────────────────────────┘

┌─ 其他登录 ────────────────  2 个   [展开] ────────────┐
│  （收起时什么都不显示）                                │
│  Command Code  未登录      [使用 API Key]             │
│  Ollama        未登录      [使用 API Key]             │
└──────────────────────────────────────────────────────┘

┌─ 模型展示 ───────────────────────────────────────────┐
└──────────────────────────────────────────────────────┘
```

Rules:

1. **Signed-in cards first**, in a stable registry order (OpenAI → OpenCode →
   OpenDesign → Command Code → Ollama → Mistral), never reordered by whichever
   status arrived first. A layout that reshuffles during load is worse than a
   long list.
2. **Signed-out cards collapse into one group** with a count (`未登录 · 3 个`)
   and one `展开` / `收起` button. Collapsed is the default.
3. **Provider** cards stay cards inside the group; the group is a container, not a
   replacement. One provider = one card, as the contract says.
4. When **every** provider is signed out, the "已登录" heading is omitted and the
   group is expanded by default — that is the first-run experience, and it must
   not be a screen with nothing on it.
5. When **no** provider is signed out, the group is not rendered at all.

## Why the group was dropped

Grouping needs one component to know all three sections' states. Two attempts
failed, and the failures are worth recording:

1. **Parent-owned `useState`.** The host test harness emulates hooks with one
   flat, index-keyed array shared across every component in a render pass. A
   `useState` in a parent therefore renumbers every child's slots, and 36 existing
   assertions call `ui.effects[0]`, `ui.effects[2]` by index. Rewriting the
   harness to key hooks per component fixed that but broke 18 unrelated tests;
   the harness is fixture-grade, not a React emulator.
2. **Collapsing the card itself.** Hiding a signed-out card's body broke a
   tested contract: *signed out, the sign-in control is present and starts the
   native login*. That contract is what makes onboarding work.

So the signed-in-first result is achieved **without owning cross-card state and
without hiding anything**: each card computes its own `order` from state it
already holds, and the page is a flex column.

## What was built

```js
function signInOrder(waiting, loggedIn) {
  if (loggedIn) return 0
  return waiting ? 1 : 2
}
```

- Every card passes `{ ...styles.card, order: signInOrder(...) }`.
- `PluginSettings` renders the three cards inside one
  `display:flex; flexDirection:column` container.
- Document order never changes, so each section's hook and effect order stays
  exactly where the tests expect it.

Result: a configured provider sits at the top, a device flow in progress sits
next (it needs attention), and providers still waiting to be set up sit last.
Nothing is hidden, so the first sign-in remains one click away.

## What this does *not* do

It does not collapse or summarise. With many unconfigured providers the page
still shows one header per provider, just ordered. A true accordion needs the
harness to model per-component hook state; that is a testing-infrastructure
change, not a UI change, and it is out of scope here.

## How the state is gathered

Three cards today fetch three different endpoints (`/status`,
`/opencode/status`, `/opendesign/status`). Two options:

- **A (preferred): lift the three fetches into `PluginSettings`**, pass each
  card its status and a reload callback. One place decides ordering; each card
  keeps its own actions and errors. Adds a small prop surface to the cards.
- **B: a hidden probe component** that fetches all three and publishes a count.
  Cheaper to write, but leaves each card fetching its own status again — two
  requests per provider per mount.

A costs a refactor of three components; B costs duplicated network calls and a
second source of truth. **Recommend A.**

## Providers with no sign-in

Command Code, Ollama and Mistral have **no card at all**: they are API-key
providers whose key lives in the host credential store, and neither has a
documented device flow. They therefore appear only in **额度卡** (`账号与余额`),
never here. That is why the layout above only lists three signed-in cards.

If a key-based provider should also be listed here, that needs a deliberate
decision: a card whose only action is "paste a key into the model settings page"
is a pointer, not a sign-in. Left out of scope.

## Tests this will need

- Ordering: a fixture with OpenAI signed out and OpenCode signed in puts OpenCode
  first, and the group holds the signed-out one.
- Collapsed by default with the count, and expanding reveals the card.
- A card mid device-flow stays visible while signed out.
- An unknown (failed) status stays visible and shows its error.
- All signed out: group expanded, no "已登录" heading.
- All signed in: no group at all.
- Each card still offers exactly **重新登录** + **退出登录** when signed in
  (the existing assertion must keep passing inside the group).
