/** Production quota normalization regression for Codex, Go and Zen. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeCodex, normalizeOpenCodeGo, normalizeOpenCodeZen, normalizeResetCredits, normalizeOllamaCloud } from '../../lib/subscription/normalize.js'
import { accountKeyOf } from '../../lib/subscription/identity.js'

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const fixture = n => JSON.parse(readFileSync(join(FIX, n), 'utf8'))

test('codex exhausted: allowed=false preserved', () => {
  const s = normalizeCodex(fixture('codex-usage-exhausted.json'), { httpStatus: 200, capturedAt: 1 })
  assert.equal(s.usageAllowed, false)
  assert.equal(s.status, 'exhausted')
  assert.equal(s.windows.find(w => w.id === 'primary').usedPercent, 100)
  assert.equal(s.windows.find(w => w.id === 'secondary').remainingPercent, 84)
})
test('codex empty account_id => identity-unverified, no key', () => {
  const s = normalizeCodex(fixture('codex-usage-exhausted.json'), { httpStatus: 200, accountId: '', capturedAt: 1 })
  assert.equal(s.identity, 'identity-unverified')
  assert.equal(s.accountKey, undefined)
  assert.equal(accountKeyOf('').accountKey, undefined)
})
test('codex credits separate from windows', () => {
  const s = normalizeCodex(fixture('codex-usage-exhausted.json'), { resetCredits: { available: 1 }, httpStatus: 200, capturedAt: 1 })
  assert.equal(s.resetCredits.available, 1)
  assert.equal(s.credits.hasCredits, false)
  assert.equal(s.windows.some(w => w.id.includes('credit')), false)
})
test('codex allowed=true => ready', () => {
  const s = normalizeCodex(fixture('codex-usage-available.json'), { httpStatus: 200, capturedAt: 1 })
  assert.equal(s.status, 'ready')
  assert.equal(s.usageAllowed, true)
})
test('codex verified account yields stable key', () => {
  const s = normalizeCodex(fixture('codex-usage-available.json'), { httpStatus: 200, accountId: 'fixture-account-2', capturedAt: 1 })
  assert.equal(s.identity, 'verified')
  assert.equal(s.accountKey, accountKeyOf('fixture-account-2').accountKey)
})
test('codex missing windows => unknown, never 0/full', () => {
  const s = normalizeCodex(fixture('codex-usage-no-windows.json'), { httpStatus: 200, capturedAt: 1 })
  assert.equal(s.status, 'unknown')
  assert.equal(s.windows.length, 0)
})
test('bare 429 => rate-limited with no percent claim', () => {
  const s = normalizeCodex({}, { httpStatus: 429, capturedAt: 1 })
  assert.equal(s.status, 'rate-limited')
  assert.equal(s.windows.length, 0)
})
test('429 with usage-limit body => exhausted', () => {
  assert.equal(normalizeCodex({}, { httpStatus: 429, httpError: 'The usage limit has been reached', capturedAt: 1 }).status, 'exhausted')
})
test('allowed=true with 100% display => ready', () => {
  const s = normalizeCodex({ rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 100, limit_window_seconds: 18000 } } }, { httpStatus: 200, capturedAt: 1 })
  assert.equal(s.status, 'ready')
  assert.equal(s.windows[0].usedPercent, 100)
})
test('explicit denial with no windows => exhausted, percents unknown', () => {
  const s = normalizeCodex({ rate_limit: { allowed: false, limit_reached: true } }, { httpStatus: 200, capturedAt: 1 })
  assert.equal(s.status, 'exhausted')
  assert.equal(s.windows.length, 0)
})
test('no allowed field, primary 100% => exhausted fallback', () => {
  const s = normalizeCodex({ rate_limit: { primary_window: { used_percent: 100, limit_window_seconds: 18000 } } }, { httpStatus: 200, capturedAt: 1 })
  assert.equal(s.status, 'exhausted')
})
test('401 => auth-required', () => {
  assert.equal(normalizeCodex({}, { httpStatus: 401, capturedAt: 1 }).status, 'auth-required')
})
test('go rolling/weekly/monthly normalized', () => {
  const s = normalizeOpenCodeGo(fixture('opencode-go-usage.json'), { capturedAt: 1 })
  assert.deepEqual(s.windows.map(w => [w.id, w.usedPercent]), [['rolling', 1], ['weekly', 29], ['monthly', 37]])
  assert.deepEqual(s.windows.map(w => w.windowMinutes), [300, 10080, 43200])
  assert.equal(s.status, 'ready')
})
test('go rate-limited window keeps percent', () => {
  const s = normalizeOpenCodeGo({ usage: { rolling: { percent: 100, status: 'rate-limited', resetsAt: 'x' } } }, { capturedAt: 1 })
  assert.equal(s.windows[0].usedPercent, 100)
  assert.equal(s.status, 'rate-limited')
})
test('two accounts produce distinct keys; empty id yields none', () => {
  const a = accountKeyOf('acct-alpha-1'), b = accountKeyOf('acct-beta-2')
  assert.equal(a.identity, 'verified')
  assert.notEqual(a.accountKey, b.accountKey)
  const empty = accountKeyOf('')
  assert.equal(empty.identity, 'identity-unverified')
  assert.equal(empty.accountKey, undefined)
})

test('Zen Console microcents are converted to USD using the official available balance', () => {
  const s = normalizeOpenCodeZen({ balanceMicroCents: '2000000000', availableMicroCents: '1234000000', mode: 'pay-as-you-go' }, { capturedAt: 1 })
  assert.deepEqual(s.balance, { amount: 12.34, currency: 'USD' })
  assert.equal(s.status, 'ready')
  assert.deepEqual(s.windows, [])
  assert.equal(s.capturedAt, 1)
  assert.deepEqual(normalizeOpenCodeZen({ availableMicroCents: 0 }).balance, { amount: 0, currency: 'USD' })
  assert.equal(normalizeOpenCodeZen({ availableMicroCents: '0' }).status, 'exhausted')
})

test('Zen unavailable or malformed money stays unknown rather than zero', () => {
  for (const value of [undefined, null, '', '12.5', 'USD 10', NaN, Infinity, '999999999999999999999']) {
    const s = normalizeOpenCodeZen({ availableMicroCents: value })
    assert.equal(s.balance, undefined)
    assert.equal(s.status, 'unknown')
  }
  assert.equal(normalizeOpenCodeZen({ availableMicroCents: '-50000000' }).balance.amount, -0.5)
})

test('Zen invoiced available credit is identified separately from prepaid cash', () => {
  assert.deepEqual(normalizeOpenCodeZen({ availableMicroCents: '2500000000', mode: 'invoiceable' }).balance, { amount: 25, currency: 'USD', kind: 'credit' })
})

test('OpenRouter reports a key cap as credits, never as a percentage window', async () => {
  const { normalizeOpenRouterKey } = await import('../../lib/subscription/normalize.js')
  const snap = normalizeOpenRouterKey({ data: { usage: 25.75, limit: 100.5, limit_remaining: 74.75, is_free_tier: false } }, { capturedAt: 1 })
  assert.equal(snap.providerId, 'openrouter')
  assert.equal(snap.status, 'ready')
  assert.deepEqual(snap.windows, [], 'a spend cap is money, not an allowance window')
  assert.equal(snap.credits.used, 25.75)
  assert.equal(snap.credits.balance, 74.75)
  assert.equal(snap.credits.limit, 100.5)
  assert.equal(snap.credits.currency, 'USD')
})

test('an OpenRouter key with nothing left reads exhausted rather than ready', async () => {
  const { normalizeOpenRouterKey } = await import('../../lib/subscription/normalize.js')
  const snap = normalizeOpenRouterKey({ data: { usage: 10, limit: 10, limit_remaining: 0 } }, { capturedAt: 1 })
  assert.equal(snap.status, 'exhausted')
  assert.equal(snap.credits.hasCredits, false)
})

test('an Ollama monthly pool becomes one month window with its dollar pair', () => {
  const snap = normalizeOllamaCloud({
    included: { balance_usd: 72.5, allowance_usd: 100, period: { from: '2026-09-15T09:30:00Z', until: '2026-10-15T09:30:00Z' } },
    purchased: { balance_usd: 25 },
  }, { capturedAt: 1 })
  assert.equal(snap.providerId, 'ollama')
  assert.equal(snap.status, 'ready')
  assert.equal(snap.windows.length, 1)
  const w = snap.windows[0]
  assert.equal(w.id, 'monthly')
  assert.equal(w.remainingPercent, 72.5)
  assert.equal(w.display, '$72.50 / $100.00')
  assert.equal(w.resetsAt, '2026-10-15T09:30:00Z')
  // No windowMinutes: a 28-31 day cycle must not be titled by its length.
  assert.equal(w.windowMinutes, undefined)
  assert.deepEqual(snap.credits, { hasCredits: true, balance: 25, currency: 'USD' })
})

test('an Ollama plan is named on its published allowance, and only then', () => {
  for (const [allowance, plan] of [[60, 'Pro'], [300, 'Max'], [1000, 'Team']]) {
    const snap = normalizeOllamaCloud({ included: { balance_usd: allowance / 2, allowance_usd: allowance } }, { capturedAt: 1 })
    assert.equal(snap.plan, plan, String(allowance) + ' names ' + plan)
  }
  // A prorated or promotional pool matches no published number and stays unnamed.
  for (const allowance of [15, 100, 200, 0]) {
    assert.equal(normalizeOllamaCloud({ included: { balance_usd: 1, allowance_usd: allowance } }, { capturedAt: 1 }).plan, undefined)
  }
})

test('legacy Ollama session and weekly windows still read, and win over the pool', () => {
  const snap = normalizeOllamaCloud({ included: {
    session: { remaining_percent: 75, resets_at: '2026-10-01T07:00:00Z' },
    weekly: { remaining_percent: 40, resets_at: '2026-10-05T00:00:00Z' },
  }, purchased: { balance_usd: 25 } }, { capturedAt: 1 })
  assert.deepEqual(snap.windows.map(w => w.id), ['session', 'weekly'])
  assert.equal(snap.windows[0].remainingPercent, 75)
  assert.equal(snap.windows[1].remainingPercent, 40)
  assert.equal(snap.plan, undefined, 'no allowance reported, so no plan name')
})

test('no allowance means no percent window, never 剩余 0%', () => {
  for (const payload of [{ purchased: { balance_usd: 25 } }, { included: { balance_usd: 25 } },
    { included: { allowance_usd: 0, balance_usd: 25 } }, {}]) {
    const snap = normalizeOllamaCloud(payload, { capturedAt: 1 })
    assert.equal(snap.windows.length, 0, JSON.stringify(payload))
    assert.equal(snap.status, 'unknown')
  }
  // Purchased credits alone still report as a wallet.
  assert.deepEqual(normalizeOllamaCloud({ purchased: { balance_usd: 25 } }, { capturedAt: 1 }).credits,
    { hasCredits: true, balance: 25, currency: 'USD' })
})

test('an exhausted Ollama pool is exhausted, not unknown', () => {
  const snap = normalizeOllamaCloud({ included: { balance_usd: 0, allowance_usd: 60 } }, { capturedAt: 1 })
  assert.equal(snap.windows[0].remainingPercent, 0)
  assert.equal(snap.status, 'exhausted')
  assert.equal(snap.plan, 'Pro')
})
test('only explicit, supported, unexpired Codex reset tickets become options', async () => {
  const now = 1795071269006
  const base = { id: 'RateLimitResetCredit_a', reset_type: 'codex_rate_limits', is_supported_by_plan: true,
    status: 'available', title: 'Full reset (Weekly + 5 hr)', description: 'granted', expires_at: '2026-12-01T22:48:03.205803Z' }
  const snap = normalizeResetCredits({ available_count: 1, credits: [base] }, { now })
  assert.equal(snap.available, 1)
  assert.equal(snap.options[0].creditId, base.id)
  assert.equal(snap.options[0].title, base.title)
  assert.equal(snap.options[0].expiresAt, Math.floor(Date.parse(base.expires_at) / 1000))
  // Every refusal is a real rule, not a guess: unredeemable tickets never reach a button.
  const refused = [
    { ...base, status: 'redeemed' },
    { ...base, status: 'expired' },
    { ...base, is_supported_by_plan: false },
    { ...base, reset_type: 'other' },
    { ...base, id: '' },
    { ...base, expires_at: '2026-01-01T00:00:00Z' },
    { ...base, expires_at: 'not-a-date' },
  ]
  for (const credit of refused) {
    assert.deepEqual(normalizeResetCredits({ credits: [credit] }, { now }).options, [], JSON.stringify(credit).slice(0, 60))
  }
})

test('an unreadable reset payload yields no tickets and never invents one', () => {
  for (const payload of [{}, { credits: null }, { credits: 'x' }, { available_count: 3 }, null, undefined]) {
    const snap = normalizeResetCredits(payload, { now: 1795071269006 })
    assert.equal(snap.available, 0)
    assert.deepEqual(snap.options, [])
  }
  // A count the tickets do not back is reported, not silently equal.
  assert.equal(normalizeResetCredits({ available_count: 5, credits: [] }, { now: 1 }).reported, 5)
})

test('tickets sort by expiry so a doomed one never sits ahead of a usable one', () => {
  const near = { id: 'a', reset_type: 'codex_rate_limits', is_supported_by_plan: true, status: 'available', title: 'A', expires_at: '2026-12-01T00:00:00Z' }
  const far = { ...near, id: 'b', title: 'B', expires_at: '2026-12-20T00:00:00Z' }
  const none = { ...near, id: 'c', title: 'C' }
  delete none.expires_at
  const snap = normalizeResetCredits({ credits: [none, far, near] }, { now: 1 })
  assert.deepEqual(snap.options.map(o => o.creditId), ['a', 'b', 'c'])
})
test('Command Code keeps dollars and plan windows apart', async () => {
  const { normalizeCommandCode } = await import('../../lib/subscription/normalize.js')
  const snap = normalizeCommandCode({
    credits: { credits: { planId: 'individual-goat-monthly', monthlyCredits: 41.2, purchasedCredits: 5, freeCredits: 0 },
      windowLimits: { limited: true, fiveHour: { used: 3.1, cap: 10, resetAt: 1790000000000 },
        weekly: { used: 12, cap: 40, resetAt: 1790400000000 } } },
    plan: { planId: 'individual-goat-monthly', status: 'active' },
  }, { capturedAt: 1 })
  assert.equal(snap.providerId, 'commandcode')
  assert.equal(snap.plan, 'GOAT', 'the plan id maps to its product name')
  assert.equal(snap.credits.balance, 46.2, 'monthly, purchased and free add up')
  assert.deepEqual(snap.windows.map(w => w.id), ['five-hour', 'weekly'])
  assert.equal(snap.windows[0].usedPercent, 31)
  assert.equal(snap.windows[0].display, '$3.10 / $10.00')
})

test('a Command Code plan with no windows yet is unknown, not empty', async () => {
  const { normalizeCommandCode } = await import('../../lib/subscription/normalize.js')
  const snap = normalizeCommandCode({ credits: { credits: {} }, plan: null }, { capturedAt: 1 })
  assert.equal(snap.status, 'unknown')
  assert.deepEqual(snap.windows, [])
})
