import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCodexAdapter } from '../../lib/subscription/providers/codex.js'
import { createOpenCodeGoAdapter } from '../../lib/subscription/providers/opencode-go.js'
import { createOpenCodeZenAdapter } from '../../lib/subscription/providers/opencode-zen.js'
import { createOllamaAdapter } from '../../lib/subscription/providers/ollama.js'

const grant = (expires = Date.now() + 3600000) => ({ kind: 'grant', payload: { type: 'oauth', access: 'tok', refresh: 'r', expires, accountId: 'acct-1' } })
const creds = record => ({ readRecord: async () => record, resolve: async () => undefined })

test('codex resolveAuth refuses without a grant', async () => {
  const a = createCodexAdapter({ credentials: creds(undefined) })
  await assert.rejects(a.resolveAuth(), e => e.code === 'auth-required')
})

test('codex expired credential invokes injected refresh (delegated to Pi-AI)', async () => {
  let refreshed = 0
  const a = createCodexAdapter({
    credentials: creds(grant(Date.now() - 1000)),
    refresh: async () => { refreshed += 1; return { access: 'new', expires: Date.now() + 3600000, accountId: 'acct-1' } },
  })
  const auth = await a.resolveAuth()
  assert.equal(refreshed, 1)
  assert.equal(auth.authorization, 'Bearer new')
})

test('codex expired without refresh is auth-required, never a stale token', async () => {
  const a = createCodexAdapter({ credentials: creds(grant(Date.now() - 1000)) })
  await assert.rejects(a.resolveAuth(), e => e.code === 'auth-required')
})

test('codex fetch sends credentials only to the official chatgpt origin', async () => {
  const seen = []
  const fetchImpl = async url => { seen.push(String(url)); return new Response(JSON.stringify({ rate_limit: { allowed: true } }), { status: 200 }) }
  const a = createCodexAdapter({ credentials: creds(grant()), fetchImpl, timeoutMs: 1000 })
  const auth = await a.resolveAuth()
  await a.fetchUsage(auth, {})
  assert.deepEqual(seen, [
    'https://chatgpt.com/backend-api/wham/usage',
    'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits',
  ])
})

test('go resolveAuth requires the configured key reference', async () => {
  const missing = createOpenCodeGoAdapter({ credentials: { resolve: async () => undefined } })
  await assert.rejects(missing.resolveAuth(), e => e.code === 'auth-required')
  const present = createOpenCodeGoAdapter({ credentials: { resolve: async () => ({ value: 'k' }) } })
  assert.equal((await present.resolveAuth()).authorization, 'Bearer k')
})

test('Codex configuration discovery reads credential metadata without refreshing or fetching usage', async () => {
  let configured = false
  const adapter = createCodexAdapter({
    credentials: {
      async describeRecord(name) { assert.equal(name, 'llm-pi-ai/openai-codex'); return { configured } },
      readRecord() { assert.fail('listing subscriptions must not read the OAuth grant') },
    },
    refresh() { assert.fail('listing subscriptions must not refresh OAuth') },
    fetchImpl() { assert.fail('listing subscriptions must not fetch usage') },
  })
  assert.equal(await adapter.isConfigured(), false)
  configured = true
  assert.equal(await adapter.isConfigured(), true)
  assert.equal(await createCodexAdapter({}).isConfigured(), false)
})

test('Ollama reads only the official balance endpoint with the configured key', async () => {
  const seen = []
  const adapter = createOllamaAdapter({ credentials: { resolve: async name => { assert.equal(name, 'OLLAMA_KEY'); return { value: '<token>' } } },
    refName: '!OLLAMA_KEY', fetchImpl: async (url, options) => {
      seen.push(url)
      assert.equal(options.method, 'GET')
      assert.equal(options.redirect, 'error')
      assert.equal(options.headers.authorization, 'Bearer <token>')
      return Response.json({ included: { balance_usd: 72.5, allowance_usd: 100 }, purchased: { balance_usd: 25 } })
    } })
  assert.equal(await adapter.isConfigured(), true)
  const snap = adapter.normalize(await adapter.fetchUsage(await adapter.resolveAuth()), { capturedAt: 1 })
  assert.deepEqual(seen, ['https://ollama.com/api/balance'], 'one documented endpoint, nothing else')
  assert.equal(snap.windows[0].remainingPercent, 72.5)
})

test('Ollama missing credentials and refusals stay explicit failures', async () => {
  const missing = createOllamaAdapter({ credentials: { resolve: async () => undefined } })
  assert.equal(await missing.isConfigured(), false)
  await assert.rejects(missing.resolveAuth(), error => error.code === 'auth-required')
  // 429 is rate limiting, 503 is upstream: distinct classes, both surfaced.
  for (const [status, code] of [[401, 'auth-required'], [403, 'risk-control'], [429, 'rate-limited'], [503, 'upstream']]) {
    const adapter = createOllamaAdapter({ fetchImpl: async () => Response.json({ error: 'invalid credentials' }, { status }) })
    await assert.rejects(adapter.fetchUsage({ authorization: 'Bearer <token>' }), error => error.code === code)
  }
})

test('Ollama display scope is stable and never contains the key', async () => {
  let value = '<token-a>'
  const credentials = { resolve: async () => ({ value }) }
  const first = await createOllamaAdapter({ credentials }).displayKey()
  assert.equal(first.includes(value), false)
  assert.equal(await createOllamaAdapter({ credentials }).displayKey(), first)
  value = '<token-b>'
  assert.notEqual(await createOllamaAdapter({ credentials }).displayKey(), first)
})
test('Codex reads the real reset tickets, not just their count', async () => {
  const grant = { kind: 'grant', payload: { type: 'oauth', access: 'tok', refresh: 'r', expires: Date.now() + 3600000, accountId: 'acct-1' } }
  const tickets = [{ id: 'RateLimitResetCredit_a', reset_type: 'codex_rate_limits', is_supported_by_plan: true,
    status: 'available', title: 'Full reset (Weekly + 5 hr)', expires_at: '2026-12-01T22:48:03.205803Z' }]
  const adapter = createCodexAdapter({ credentials: creds(grant), fetchImpl: async url => Response.json(
    url.endsWith('/rate-limit-reset-credits') ? { available_count: 1, credits: tickets } : { rate_limit: { allowed: true } }) })
  const result = await adapter.fetchUsage(await adapter.resolveAuth(), {})
  assert.equal(result.resetCredits.available, 1)
  assert.equal(result.resetCredits.options[0].creditId, 'RateLimitResetCredit_a')
})

test('a reset-credit failure never costs the usage snapshot', async () => {
  const grant = { kind: 'grant', payload: { type: 'oauth', access: 'tok', refresh: 'r', expires: Date.now() + 3600000, accountId: 'acct-1' } }
  for (const status of [403, 429, 500]) {
    const adapter = createCodexAdapter({ credentials: creds(grant), fetchImpl: async url =>
      url.endsWith('/rate-limit-reset-credits') ? Response.json({ private: '<token>' }, { status }) : Response.json({ rate_limit: { allowed: true } }) })
    const result = await adapter.fetchUsage(await adapter.resolveAuth(), {})
    assert.ok(result.usage.rate_limit, 'usage still arrives')
    assert.equal(result.resetCredits.available, 0)
    assert.ok(typeof result.resetCredits.unavailable === 'string', 'the failure is reported, not swallowed')
  }
})

test('consuming a reset spends exactly the selected ticket with the caller request id', async () => {
  const grant = { kind: 'grant', payload: { type: 'oauth', access: 'tok', refresh: 'r', expires: Date.now() + 3600000, accountId: 'acct-1' } }
  const seen = []
  const adapter = createCodexAdapter({ credentials: creds(grant), fetchImpl: async (url, options) => {
    seen.push({ url, options })
    return Response.json({ code: 'reset', credit: null, windows_reset: 2 })
  } })
  const outcome = await adapter.consumeReset('RateLimitResetCredit_a', 'req-1', {})
  assert.deepEqual(outcome, { code: 'reset', windowsReset: 2 })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].url, 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume')
  assert.equal(seen[0].options.method, 'POST')
  const body = JSON.parse(seen[0].options.body)
  assert.equal(body.credit_id, 'RateLimitResetCredit_a', 'the selected ticket, never a server-chosen one')
  assert.equal(body.redeem_request_id, 'req-1', 'the caller id, so a retry is deduped')
  assert.equal(seen[0].options.headers['chatgpt-account-id'], 'acct-1')
})

test('a consume refusal is a typed failure, never a silent success', async () => {
  const grant = { kind: 'grant', payload: { type: 'oauth', access: 'tok', refresh: 'r', expires: Date.now() + 3600000, accountId: 'acct-1' } }
  for (const [status, code] of [[401, 'auth-required'], [403, 'risk-control'], [500, 'upstream']]) {
    const adapter = createCodexAdapter({ credentials: creds(grant),
      fetchImpl: async () => Response.json({ private: '<token>' }, { status }) })
    await assert.rejects(adapter.consumeReset('credit', 'req', {}), error => error.code === code && !error.message.includes('<token>'))
  }
  const unknown = createCodexAdapter({ credentials: creds(grant), fetchImpl: async () => Response.json({ code: 'weird' }) })
  await assert.rejects(unknown.consumeReset('credit', 'req', {}), error => error.code === 'invalid-response')
  const adapter = createCodexAdapter({ credentials: creds(grant) })
  await assert.rejects(adapter.consumeReset('', 'req', {}), error => error.code === 'invalid-input')
  await assert.rejects(adapter.consumeReset('credit', '', {}), error => error.code === 'invalid-input')
})
test('Go names its plan from the Console product only when a Console session exists', async () => {
  const seen = []
  const consoleAuth = {
    isConfigured: async () => true,
    async resolveAuth() { return { authorization: 'Bearer <oauth-token>', orgId: 'org_fixture' } },
  }
  const adapter = createOpenCodeGoAdapter({ credentials: { resolve: async () => ({ value: '<go-key>' }) }, consoleAuth,
    fetchImpl: async (url, options) => {
      seen.push(url)
      if (url === 'https://opencode.ai/console/api/go/status') {
        assert.equal(options.headers.authorization, 'Bearer <oauth-token>', 'the key is refused on Console routes')
        assert.equal(options.headers['x-org-id'], 'org_fixture')
        return Response.json({ product: 'go-plus' })
      }
      assert.equal(options.headers.authorization, 'Bearer <go-key>')
      return Response.json({ usage: { rolling: { status: 'ok', percent: 5, resetsAt: '2026-11-19T05:15:04.000Z' } } })
    } })
  const snapshot = adapter.normalize(await adapter.fetchUsage(await adapter.resolveAuth()), { capturedAt: 1 })
  assert.deepEqual(seen, ['https://opencode.ai/zen/go/v1/usage', 'https://opencode.ai/console/api/go/status'])
  assert.equal(snapshot.plan, 'go-plus')
})

test('without a Console session the Go limits still load and the plan stays unnamed', async () => {
  const seen = []
  const adapter = createOpenCodeGoAdapter({ credentials: { resolve: async () => ({ value: '<go-key>' }) },
    fetchImpl: async url => { seen.push(url); return Response.json({ usage: { weekly: { status: 'ok', percent: 9, resetsAt: '2026-11-23T00:00:00.000Z' } } }) } })
  const snapshot = adapter.normalize(await adapter.fetchUsage(await adapter.resolveAuth()), { capturedAt: 1 })
  assert.deepEqual(seen, ['https://opencode.ai/zen/go/v1/usage'], 'no plan probe without a session')
  assert.equal(snapshot.plan, undefined)
  assert.equal(snapshot.windows.length, 1, 'the limits are unaffected')
})

test('a failing plan probe never costs the Go limits', async () => {
  const consoleAuth = { isConfigured: async () => true,
    async resolveAuth() { return { authorization: 'Bearer <oauth-token>', orgId: 'org_fixture' } } }
  for (const failure of [
    async () => Response.json({ private: '<token>' }, { status: 403 }),
    async () => { throw Object.assign(new Error('expired'), { code: 'auth-required' }) },
    async () => Response.json({}, { status: 200 }),
  ]) {
    const adapter = createOpenCodeGoAdapter({ credentials: { resolve: async () => ({ value: '<go-key>' }) }, consoleAuth,
      fetchImpl: async url => url.endsWith('/v1/usage')
        ? Response.json({ usage: { monthly: { status: 'ok', percent: 40, resetsAt: '2026-12-10T06:22:49.000Z' } } })
        : failure() })
    const snapshot = adapter.normalize(await adapter.fetchUsage(await adapter.resolveAuth()), { capturedAt: 1 })
    assert.equal(snapshot.windows.length, 1, 'the limits survive a plan failure')
    assert.equal(snapshot.plan, undefined, 'no invented plan name')
  }
})
test('Go configuration discovery requires a non-empty key in the configured reference', async () => {
  let value
  const adapter = createOpenCodeGoAdapter({
    refName: '!CUSTOM_GO_KEY',
    credentials: { async resolve(name) { assert.equal(name, 'CUSTOM_GO_KEY'); return { value } } },
    fetchImpl() { assert.fail('listing subscriptions must not fetch usage') },
  })
  for (const missing of [undefined, '', '  ', 0]) {
    value = missing
    assert.equal(await adapter.isConfigured(), false)
  }
  value = '<token>'
  assert.equal(await adapter.isConfigured(), true)
  assert.equal(await createOpenCodeGoAdapter({}).isConfigured(), false)
})

test('Codex display scope survives token refresh and new adapters but changes with the account', async () => {
  let current = grant()
  const credentials = { readRecord: async () => current }
  const options = { credentials, refresh() { assert.fail('display discovery cannot refresh OAuth') }, fetchImpl() { assert.fail('display discovery cannot fetch usage') } }
  const first = await createCodexAdapter(options).displayKey()
  current = { ...current, payload: { ...current.payload, access: '<new-token>', refresh: '<new-refresh>' } }
  assert.equal(await createCodexAdapter(options).displayKey(), first)
  current.payload.accountId = 'acct-2'
  assert.notEqual(await createCodexAdapter(options).displayKey(), first)
  current = undefined
  assert.equal(await createCodexAdapter(options).displayKey(), undefined)
})

test('Go display scope is stable across adapters without exposing the key or verifying an account identity', async () => {
  let value = '<token-a>'
  const credentials = { resolve: async () => ({ value }) }
  const first = await createOpenCodeGoAdapter({ credentials }).displayKey()
  assert.equal(first.includes(value), false)
  assert.equal(await createOpenCodeGoAdapter({ credentials }).displayKey(), first)
  assert.equal((await createOpenCodeGoAdapter({ credentials }).resolveAuth()).accountKey, undefined)
  value = '<token-b>'
  assert.notEqual(await createOpenCodeGoAdapter({ credentials }).displayKey(), first)
  value = ' '
  assert.equal(await createOpenCodeGoAdapter({ credentials }).displayKey(), undefined)
})

test('Zen balance reads only the official Console billing endpoint with the configured key', async () => {
  const seen = [], abort = new AbortController()
  const credentials = { resolve: async name => { assert.equal(name, 'ZEN_KEY'); return { value: '<token>' } } }
  const adapter = createOpenCodeZenAdapter({ credentials, refName: '!ZEN_KEY', fetchImpl: async (url, options) => {
    seen.push(url)
    assert.equal(options.method, 'GET')
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers.authorization, 'Bearer <token>')
    assert.equal(options.signal.aborted, false)
    return Response.json({ availableMicroCents: '1234000000' })
  } })
  assert.equal(await adapter.isConfigured(), true)
  const key = await adapter.displayKey()
  assert.equal(await createOpenCodeZenAdapter({ credentials, refName: 'ZEN_KEY' }).displayKey(), key)
  assert.equal(key.includes('<token>'), false)
  const body = await adapter.fetchUsage(await adapter.resolveAuth(), { signal: abort.signal })
  assert.equal(adapter.normalize(body, { capturedAt: 1 }).balance.amount, 12.34)
  assert.deepEqual(seen, ['https://opencode.ai/console/api/billing/status'])
})

test('Zen missing credentials and billing permissions remain explicit failures', async () => {
  const missing = createOpenCodeZenAdapter({ credentials: { resolve: async () => undefined } })
  assert.equal(await missing.isConfigured(), false)
  await assert.rejects(missing.resolveAuth(), error => error.code === 'auth-required')
  for (const [status, code] of [[401, 'auth-required'], [403, 'forbidden'], [503, 'upstream']]) {
    const adapter = createOpenCodeZenAdapter({ fetchImpl: async () => Response.json({ private: '<token>' }, { status }) })
    await assert.rejects(adapter.fetchUsage({ authorization: 'Bearer <token>' }), error => error.code === code && !error.message.includes('<token>'))
  }
})

test('Zen uses the official billing API for both legacy and Console keys', async () => {
  for (const value of ['sk-' + 'a'.repeat(64), 'oc_sk_' + 'a'.repeat(12) + '_' + 'b'.repeat(32)]) {
    const adapter = createOpenCodeZenAdapter({ credentials: { resolve: async () => ({ value }) }, fetchImpl: async (url, options) => {
      assert.equal(url, 'https://opencode.ai/console/api/billing/status')
      assert.equal(options.headers.authorization, 'Bearer ' + value)
      return Response.json({ availableMicroCents: '496000000' })
    } })
    assert.equal(await adapter.isConfigured(), true)
    const snapshot = adapter.normalize(await adapter.fetchUsage(await adapter.resolveAuth()), { capturedAt: 1 })
    assert.equal(snapshot.balance.amount, 4.96)
  }
})

test('Zen incomplete billing responses explicitly fail so cached money can survive', () => {
  const adapter = createOpenCodeZenAdapter({})
  for (const body of [{}, { availableMicroCents: null }, { availableMicroCents: 'invalid' }]) {
    assert.throws(() => adapter.normalize(body, { capturedAt: 1 }), error => error.code === 'invalid-response')
  }
  assert.equal(adapter.normalize({ availableMicroCents: '0' }, { capturedAt: 1 }).balance.amount, 0)
})

test('Zen prefers workspace-scoped Console OAuth without changing or reading the model API key', async () => {
  const abort = new AbortController()
  const adapter = createOpenCodeZenAdapter({ credentials: { resolve() { assert.fail('OAuth balance reads must not touch the model key') } },
    consoleAuth: {
      isConfigured: async () => true, displayKey: async () => 'workspace-digest',
      async resolveAuth({ signal }) { assert.equal(signal, abort.signal); return { authorization: 'Bearer <oauth-token>', orgId: 'org_fixture', accountKey: 'account-digest' } },
    }, fetchImpl: async (url, options) => {
      assert.equal(url, 'https://opencode.ai/console/api/billing/status')
      assert.equal(options.headers.authorization, 'Bearer <oauth-token>')
      assert.equal(options.headers['x-org-id'], 'org_fixture')
      assert.equal(options.redirect, 'error')
      return Response.json({ availableMicroCents: '496000000' })
    } })
  assert.equal(await adapter.isConfigured(), true)
  assert.equal(await adapter.displayKey(), 'workspace-digest')
  const auth = await adapter.resolveAuth({ signal: abort.signal })
  assert.equal(adapter.normalize(await adapter.fetchUsage(auth, { signal: abort.signal }), { capturedAt: 1 }).balance.amount, 4.96)
})

test('Zen invalid Console authorization stays explicit and cannot fall back to another key or workspace', async () => {
  const adapter = createOpenCodeZenAdapter({ consoleAuth: { async resolveAuth() { throw Object.assign(new Error('expired'), { code: 'auth-required' }) } },
    credentials: { resolve() { assert.fail('must not switch to a different identity') } } })
  await assert.rejects(adapter.resolveAuth(), error => error.code === 'auth-required')
})
