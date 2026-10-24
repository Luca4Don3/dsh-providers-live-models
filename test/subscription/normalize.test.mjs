/** Production quota normalization regression for Codex, Go and Zen. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeCodex, normalizeOpenCodeGo, normalizeOpenCodeZen } from '../../lib/subscription/normalize.js'
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
