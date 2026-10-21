import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOpenDesignQuotaAdapter, normalizeOpenDesign } from '../lib/opendesign/quota.js'
import { createQuotaEngine } from '../lib/subscription/engine.js'
import { QuotaError } from '../lib/subscription/errors.js'
import { CONTROL_ORIGIN } from '../lib/opendesign/auth.js'

const CONTROL = 'vela_ctrl_quota_fixture'
const RUNTIME = 'sk-amr-runtime_fixture'
const resolved = { mode: 'account', controlKey: CONTROL, runtimeKey: RUNTIME, accountKey: 'acct_fixture' }
const windows = [
  { durationSeconds: 604800, usedCredits: '16251', limitCredits: '150000', remainingCredits: '133749', resetsAt: '2030-01-08T00:00:00.000Z' },
  { durationSeconds: 18000, usedCredits: '16251', limitCredits: '50000', remainingCredits: '33749', resetsAt: '2030-01-01T05:00:00.000Z' },
]
const preflight = { balanceUsd: '1.5000', funding: 'wallet', codingPlan: { eligible: true, tier: 'go', windows } }
const summary = { membershipTier: 'go', subscriptionStatus: 'active', subscriptionCancelAtPeriodEnd: false,
  subscriptionCurrentPeriodEnd: '2030-02-01T00:00:00.000Z', balanceUsd: '2.0000' }
const auth = { isConfigured: async () => true, displayKey: async () => 'view_fixture', resolveAuth: async () => resolved }
function fetchFake(seen, overrides = {}) {
  return async (url, init) => {
    seen.push([url, init])
    if (url.endsWith('/workspaces/current')) return Response.json(overrides.workspace ?? { activeWorkspaceId: 'workspace/fixture', personalMembershipTier: 'go' })
    if (url.endsWith('/billing/preflight')) return Response.json(overrides.preflight ?? preflight)
    if (url.endsWith('/billing/summary')) return Response.json(overrides.summary ?? summary)
    assert.fail('unrecognized request')
  }
}
const isCode = code => error => error instanceof QuotaError && error.code === code

// These are synthetic fixture responses; no vendor or local credentials are contacted.
test('quota adapter exposes the existing subscription engine interface', async () => {
  const adapter = createOpenDesignQuotaAdapter({ auth, fetchImpl: fetchFake([]) })
  assert.equal(adapter.providerId, 'opendesign'); assert.equal(adapter.origin, CONTROL_ORIGIN)
  assert.equal(await adapter.isConfigured(), true); assert.equal(await adapter.displayKey(), 'view_fixture')
  assert.equal(await adapter.resolveAuth(), resolved)
})

test('workspace discovery, preflight and optional summary use only the fixed control key origin', async () => {
  const seen = [], adapter = createOpenDesignQuotaAdapter({ auth, fetchImpl: fetchFake(seen) })
  const raw = await adapter.fetchUsage(resolved)
  assert.deepEqual(seen.map(([url]) => url), [
    CONTROL_ORIGIN + '/api/v1/workspaces/current',
    CONTROL_ORIGIN + '/api/v1/workspaces/workspace%2Ffixture/billing/preflight',
    CONTROL_ORIGIN + '/api/v1/billing/summary',
  ])
  for (const [url, init] of seen) {
    assert.equal(new URL(url).origin, CONTROL_ORIGIN); assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error')
    assert.equal(init.headers.authorization, 'Bearer ' + CONTROL)
    assert.ok(!JSON.stringify(init).includes(RUNTIME)); assert.equal(init.body, undefined)
  }
  const result = adapter.normalize(raw, { capturedAt: 123, accountKey: resolved.accountKey })
  assert.equal(result.providerId, 'opendesign'); assert.equal(result.scope, 'subscription'); assert.equal(result.status, 'ready')
  assert.equal(result.capturedAt, 123); assert.equal(result.accountKey, 'acct_fixture'); assert.equal(result.plan, 'Design Plan Go')
  assert.deepEqual(result.balance, { amount: 1.5, currency: 'USD' }); assert.equal(result.renew, 'auto')
  assert.equal(result.until, '2030-02-01T00:00:00.000Z')
  assert.deepEqual(result.windows.map(({ label, usedPercent, remainingPercent, windowMinutes, resetsAt }) => ({ label, usedPercent, remainingPercent, windowMinutes, resetsAt })), [
    { label: '5 hours', usedPercent: 32.5, remainingPercent: 67.5, windowMinutes: 300, resetsAt: '2030-01-01T05:00:00.000Z' },
    { label: '7 days', usedPercent: 10.8, remainingPercent: 89.2, windowMinutes: 10080, resetsAt: '2030-01-08T00:00:00.000Z' },
  ])
  assert.ok(!JSON.stringify(result).includes(CONTROL)); assert.ok(!JSON.stringify(result).includes(RUNTIME))
})

test('API-key mode is explicitly unsupported for quota without sending network requests', async () => {
  const adapter = createOpenDesignQuotaAdapter({ fetchImpl() { assert.fail('runtime key must not be sent for quota') } })
  const raw = await adapter.fetchUsage({ mode: 'api-key', runtimeKey: RUNTIME, accountKey: 'acct_api_fixture' })
  const result = adapter.normalize(raw, { capturedAt: 1 })
  assert.equal(result.status, 'unsupported'); assert.deepEqual(result.windows, []); assert.equal(result.balance, undefined)
  assert.match(result.detail, /API Key/)
})

test('wrong or missing control key never falls back to runtime key', async () => {
  const adapter = createOpenDesignQuotaAdapter({ fetchImpl() { assert.fail('mixed trust planes') } })
  for (const candidate of [{ mode: 'account', runtimeKey: RUNTIME }, { mode: 'account', controlKey: RUNTIME }, undefined]) {
    await assert.rejects(adapter.fetchUsage(candidate), isCode('auth-required'))
  }
})

test('workspace id fallback is supported but absent/dot/control-character workspace fails closed', async () => {
  const seen = [], adapter = createOpenDesignQuotaAdapter({ fetchImpl: fetchFake(seen, { workspace: { workspaceId: 'ws_fixture' } }) })
  await adapter.fetchUsage(resolved); assert.equal(seen[1][0], CONTROL_ORIGIN + '/api/v1/workspaces/ws_fixture/billing/preflight')
  for (const workspace of [{}, { activeWorkspaceId: '..' }, { activeWorkspaceId: 'bad\nworkspace' }]) {
    const candidate = createOpenDesignQuotaAdapter({ fetchImpl: fetchFake([], { workspace }) })
    await assert.rejects(candidate.fetchUsage(resolved), isCode('invalid-response'))
  }
})

test('workspace/preflight auth failures remain auth errors and raw bodies are not exposed', async () => {
  for (const failAt of ['/workspaces/current', '/billing/preflight']) for (const [status, code] of [[401, 'auth-required'], [403, 'risk-control'], [429, 'rate-limited'], [500, 'upstream']]) {
    const ordinary = fetchFake([])
    const adapter = createOpenDesignQuotaAdapter({ fetchImpl: async (url, init) => url.endsWith(failAt)
      ? Response.json({ error: CONTROL, runtimeKey: RUNTIME }, { status }) : ordinary(url, init) })
    await assert.rejects(adapter.fetchUsage(resolved), error => isCode(code)(error) && !error.message.includes(CONTROL) && !error.message.includes(RUNTIME))
  }
})

test('summary 401/403/500/invalid JSON preserve measured windows and explicitly warn about unknown wallet', async () => {
  for (const status of [401, 403, 429, 500, 200]) {
    const ordinary = fetchFake([], { preflight: { codingPlan: { eligible: true, windows } } })
    const adapter = createOpenDesignQuotaAdapter({ fetchImpl: async (url, init) => url.endsWith('/billing/summary')
      ? new Response(status === 200 ? '<private non-json>' : CONTROL, { status }) : ordinary(url, init) })
    const snapshot = adapter.normalize(await adapter.fetchUsage(resolved), { capturedAt: 2 })
    assert.equal(snapshot.windows.length, 2); assert.equal(snapshot.status, 'ready')
    assert.equal(snapshot.balance, undefined); assert.equal(snapshot.plan, 'Design Plan Go') // known workspace tier, not fabricated summary
    assert.ok(snapshot.warnings.length > 0); assert.match(snapshot.warning, /钱包余额未知/)
    assert.ok(!JSON.stringify(snapshot).includes(CONTROL))
  }
})

test('summary network failure preserves valid preflight balance with a non-silent warning', async () => {
  const ordinary = fetchFake([])
  const adapter = createOpenDesignQuotaAdapter({ fetchImpl: async (url, init) => {
    if (url.endsWith('/billing/summary')) throw new Error(CONTROL)
    return ordinary(url, init)
  } })
  const result = adapter.normalize(await adapter.fetchUsage(resolved))
  assert.equal(result.status, 'ready'); assert.deepEqual(result.balance, { amount: 1.5, currency: 'USD' })
  assert.match(result.warning, /补充接口暂不可用/); assert.ok(!result.warning.includes(CONTROL))
})

test('summary cancellation propagates rather than returning a partial success', async () => {
  const controller = new AbortController(), ordinary = fetchFake([])
  const adapter = createOpenDesignQuotaAdapter({ fetchImpl: async (url, init) => {
    if (url.endsWith('/billing/summary')) { controller.abort(); return new Promise(() => {}) }
    return ordinary(url, init)
  } })
  await assert.rejects(adapter.fetchUsage(resolved, { signal: controller.signal }), isCode('timeout'))
})

test('summary totalAvailableCreditsUsd is supported without credits-to-dollar guessing', () => {
  const result = normalizeOpenDesign({ preflight: { codingPlan: { windows } }, summary: { totalAvailableCreditsUsd: '3.1250' } })
  assert.deepEqual(result.balance, { amount: 3.125, currency: 'USD' })
  assert.equal(result.creditsPerUsd, undefined); assert.equal(result.windows[0].usedPercent, 32.5)
})

test('missing balance/plan/window fields remain unknown and warnings never invent zero', () => {
  for (const value of [undefined, {}, { preflight: { balanceUsd: null } }, { summary: { balanceUsd: '', membershipTier: '' } }]) {
    const result = normalizeOpenDesign(value)
    assert.equal(result.status, 'unknown'); assert.equal(result.balance, undefined); assert.equal(result.plan, undefined)
    assert.deepEqual(result.windows, []); assert.match(result.warning, /钱包余额未知/); assert.match(result.warning, /套餐名称未知/)
  }
})

test('malformed window amounts/limits/durations are dropped rather than rendered full or zero', () => {
  for (const w of [{}, { ...windows[0], usedCredits: null }, { ...windows[0], usedCredits: '' }, { ...windows[0], usedCredits: true },
    { ...windows[0], usedCredits: '-1' }, { ...windows[0], usedCredits: 'NaN' }, { ...windows[0], limitCredits: '0' },
    { ...windows[0], limitCredits: 'Infinity' }, { ...windows[0], durationSeconds: 0 }, { ...windows[0], durationSeconds: Infinity }]) {
    assert.deepEqual(normalizeOpenDesign({ preflight: { codingPlan: { windows: [w] } } }).windows, [])
  }
})

test('numeric values and decimal strings produce clamped windows while reset time is not fabricated', () => {
  const result = normalizeOpenDesign({ preflight: { codingPlan: { windows: [
    { durationSeconds: 3600, usedCredits: 150, limitCredits: 100, resetsAt: 'invalid-date' },
    { durationSeconds: 900, usedCredits: '2.50', limitCredits: '10.00', resetsAt: 1893456000 },
  ] } } })
  assert.equal(result.status, 'exhausted'); assert.equal(result.windows[1].usedPercent, 100); assert.equal(result.windows[1].remainingPercent, 0)
  assert.equal(result.windows[1].resetsAt, undefined); assert.equal(result.windows[0].label, '15 minutes')
  assert.equal(result.windows[0].usedPercent, 25); assert.equal(result.windows[0].resetsAt, '2030-01-01T00:00:00.000Z')
})

test('ineligible allowance is not represented as free quota; known wallet remains separate', () => {
  const result = normalizeOpenDesign({ preflight: { balanceUsd: '4.50', codingPlan: { eligible: false, tier: 'go', windows } } })
  assert.equal(result.status, 'unknown'); assert.deepEqual(result.windows, []); assert.match(result.detail, /钱包余额/)
  assert.deepEqual(result.balance, { amount: 4.5, currency: 'USD' })
})

test('top-level coding-plan windows normalize without changing the configured token endpoint', () => {
  for (const payload of [{ eligible: true, tier: 'go', windows }, { usage: { eligible: true, tier: 'go', windows } }]) {
    const result = normalizeOpenDesign(payload)
    assert.equal(result.windows.length, 2); assert.equal(result.plan, 'Design Plan Go')
  }
})

test('period cancellation is explicit and malformed tier/key echoes never become a plan label', () => {
  const result = normalizeOpenDesign({ preflight, summary: { ...summary, subscriptionCancelAtPeriodEnd: true } })
  assert.equal(result.renew, 'off')
  assert.equal(normalizeOpenDesign({ summary: { membershipTier: CONTROL } }).plan, undefined)
  assert.equal(normalizeOpenDesign({ summary: { membershipTier: '<html>' } }).plan, undefined)
})

test('quota engine caches by hashed credential scope and API-key snapshots stay unsupported', async () => {
  let current = resolved
  const seen = [], adapter = createOpenDesignQuotaAdapter({ auth: { ...auth, resolveAuth: async () => current }, fetchImpl: fetchFake(seen) })
  const engine = createQuotaEngine({ adapters: { opendesign: adapter } })
  assert.equal((await engine.query('opendesign')).status, 'ready'); assert.equal(seen.length, 3)
  await engine.query('opendesign'); assert.equal(seen.length, 3)
  current = { mode: 'api-key', runtimeKey: RUNTIME, accountKey: 'acct_api_fixture' }
  assert.equal((await engine.query('opendesign')).status, 'unsupported'); assert.equal(seen.length, 3)
})
