# Command Code display gaps (fixed in rc.54)

Status: **implemented.** The adapter, normalizer and tests already existed; what
was missing was the *display* half.

## What was already right

- `lib/subscription/providers/commandcode.js` reads `/alpha/billing/credits` and
  `/alpha/billing/subscriptions` with an API key, and caches the slow subscription
  call for 10 minutes.
- `normalizeCommandCode()` maps the plan id to its product name (`GOAT`, `Ultra`,
  `Max`, `Pro`, `Go`), keeps dollars and windows apart, and emits
  `display: '$used / $cap'` on each window.

## What never reached the screen

Rendering the card with a real-shaped payload showed a card with **no plan line,
no dollars and no balance**:

```
Command Code                       可用
5小时                      剩余 60%
1周                        剩余 80%
```

Three independent causes:

1. **`planTitles` had no `commandcode` entry**, so `planTitle()` returned
   undefined and the plan line was never pushed. `plan` was also dropped by
   `displayEntry()`, which persisted it only for OpenDesign or a known plan title.
2. **`window.display` was never rendered** and never persisted: the loop printed
   the percent only.
3. **`credits` was not read as money.** `moneyBalance()` accepted `{amount}`
   only, while Command Code reports `{balance}`, so the wallet line never appeared.

## The fix

- `planTitles.commandcode` names the five plans, so the line renders and the
  value survives the display cache.
- The window loop prints `display` under the percent, and `displayEntry()`
  persists it.
- `moneyBalance()` accepts `{amount}` or `{balance}`, and `snapshot.credits`
  feeds the wallet line.
- `displayEntry()` persists `credits`.

Result:

```
Command Code                       可用
GOAT
钱包余额：US$41.20
5小时                      剩余 60%
$4.00 / $10.00
1周                        剩余 80%
$20.00 / $100.00
更新于 11/20 10:00
```

## Why this was invisible until now

No Command Code key exists on this machine (`COMMANDCODE_API_KEY` is absent), so
the provider has never appeared in `GET /subscriptions`. The gaps were found by
rendering the card with a hand-built payload matching the normalizer's own output
shape — not by exercising a live account.

## Verification

- 1 new test renders the card and asserts the plan line, the dollar pair, the
  wallet line, and that all three survive `displayEntry()`.
- Full suite: 347 passing.
