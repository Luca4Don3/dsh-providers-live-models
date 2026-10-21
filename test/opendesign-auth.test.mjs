import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOpenDesignAuth, requestOpenDesignJson, OPENDESIGN_RECORD, CONTROL_ORIGIN, MODEL_ORIGIN } from '../lib/opendesign/auth.js'
import { QuotaError } from '../lib/subscription/errors.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
const settle = async () => { await tick(); await tick() }
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const RUNTIME = 'sk-amr-runtime_fixture'
const CONTROL = 'vela_ctrl_control_fixture'
const challenge = { deviceId: 'device/fixture', deviceSecret: 'device-secret-fixture', userCode: 'TEST42',
  activationUrl: 'https://open-design.ai/cloud/cli/activate?code=TEST42', pollIntervalSeconds: 2,
  expiresAt: '2030-01-01T00:10:00.000Z' }
const tokens = { status: 'approved', runtimeKey: RUNTIME, controlKey: CONTROL, user: { id: 'user-fixture', email: 'user@example.invalid' } }
const now = () => Date.parse('2030-01-01T00:00:00.000Z')
const grant = () => ({ kind: 'grant', payload: { type: 'oauth', access: RUNTIME, control: CONTROL } })
function store(initial, canDelete = true) {
  let record = initial, tail = Promise.resolve()
  const seen = []
  const service = {
    seen, current: () => record, set: v => { record = v },
    async readRecord(key) { assert.equal(key, OPENDESIGN_RECORD); seen.push(['read', key]); return record },
    async describeRecord(key) { assert.equal(key, OPENDESIGN_RECORD); return { configured: !!record } },
    modifyRecord(key, mutate) {
      assert.equal(key, OPENDESIGN_RECORD)
      seen.push(['modify', key])
      const next = tail.then(async () => { const result = await mutate(record); if (result !== undefined) record = result; return record })
      tail = next.catch(() => {})
      return next
    },
  }
  if (canDelete) service.deleteRecord = key => {
    assert.equal(key, OPENDESIGN_RECORD); seen.push(['delete', key])
    return tail = tail.then(() => { record = undefined })
  }
  return service
}
const opts = credentials => ({ credentials, now, wait: async () => {} })
const isCode = code => error => error instanceof QuotaError && error.code === code

// All fetches and credential operations below are fakes. No OS/env/vendor login is used.
test('OpenDesign origins and plugin-owned credential scope are fixed', () => {
  assert.equal(CONTROL_ORIGIN, 'https://amr-api.open-design.ai')
  assert.equal(MODEL_ORIGIN, 'https://amr-link.open-design.ai')
  assert.equal(OPENDESIGN_RECORD, 'dsh-opencode-live-models/opendesign')
})

test('device start and poll use community JSON paths, interval and both separated keys', async () => {
  const credentials = store(), delays = [], opened = [], seen = []
  let polls = 0, notifications = 0
  const auth = createOpenDesignAuth({ ...opts(credentials), wait: async ms => { delays.push(ms) }, onChange: () => { notifications++ },
    fetchImpl: async (url, init) => {
      seen.push(url)
      assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error')
      assert.equal(init.headers.authorization, undefined)
      assert.equal(init.headers['content-type'], 'application/json')
      const body = JSON.parse(init.body)
      if (url.endsWith('/device-authorizations')) {
        assert.deepEqual(body, { cliVersion: '0.1.4', host: 'dsh-opencode-live-models', profile: 'prod' })
        return Response.json(challenge, { status: 201 })
      }
      assert.equal(url, CONTROL_ORIGIN + '/api/v1/cli/device-authorizations/device%2Ffixture/token')
      assert.deepEqual(body, { deviceSecret: challenge.deviceSecret })
      return Response.json(++polls === 1 ? { status: 'pending', runtimeKey: null, controlKey: null, user: null } : tokens)
    } })
  const start = await auth.startLogin({ openBrowser: true, opener: url => { opened.push(url) } })
  assert.equal(start.status, 'waiting'); await settle()
  assert.deepEqual(delays, [2000, 2000]); assert.equal(seen.length, 3)
  assert.deepEqual(opened, [challenge.activationUrl]); assert.equal(notifications, 1)
  assert.deepEqual(credentials.current(), { kind: 'grant', payload: { type: 'oauth', access: RUNTIME, control: CONTROL, uid: 'user-fixture', email: 'user@example.invalid' } })
  assert.deepEqual(await auth.status(), { loggedIn: true, mode: 'account', login: { status: 'ok' } })
  assert.deepEqual(await auth.resolveAuth(), { mode: 'account', runtimeKey: RUNTIME, controlKey: CONTROL, accountKey: (await auth.resolveAuth()).accountKey })
  assert.match((await auth.resolveAuth()).accountKey, /^acct_[a-f0-9]{64}$/)
  assert.match(await auth.displayKey(), /^view_[a-f0-9]{64}$/)
  const publicState = JSON.stringify([start, await auth.status(), await auth.displayKey()])
  for (const secret of [RUNTIME, CONTROL, challenge.deviceSecret, challenge.deviceId, 'user-fixture', 'user@example.invalid']) assert.ok(!publicState.includes(secret))
})

test('manual API key replaces only this grant, returns safe status and never fetches', async () => {
  const credentials = store(grant())
  const auth = createOpenDesignAuth({ credentials, fetchImpl() { assert.fail('no network for manual key') } })
  await auth.saveApiKey('  sk-amr-manual_fixture  ')
  assert.deepEqual(credentials.current(), { kind: 'grant', payload: { type: 'api-key', access: 'sk-amr-manual_fixture' } })
  const resolved = await auth.resolveAuth()
  assert.equal(resolved.mode, 'api-key'); assert.equal(resolved.controlKey, undefined)
  assert.equal(await auth.isConfigured(), true)
  assert.ok(!JSON.stringify(await auth.status()).includes('manual_fixture'))
})

test('manual API key rejects control keys, whitespace/header injection, empty and non-key inputs', async () => {
  for (const value of [CONTROL, '', undefined, 'not-a-key', 'sk-amr-', 'sk-amr-good\r\nAuthorization: bad', 'sk-amr-x\u0000']) {
    const credentials = store()
    const auth = createOpenDesignAuth({ credentials })
    await assert.rejects(auth.saveApiKey(value), isCode('invalid-key'))
    assert.equal(credentials.current(), undefined)
  }
})

test('missing or malformed grant requires auth, without reading unrelated records', async () => {
  for (const record of [undefined, { kind: 'secret', payload: RUNTIME }, { kind: 'grant', payload: { type: 'oauth', access: RUNTIME } },
    { kind: 'grant', payload: { type: 'api-key', access: CONTROL } }, { kind: 'grant', payload: { type: 'oauth', access: CONTROL, control: RUNTIME } }]) {
    const auth = createOpenDesignAuth({ credentials: store(record) })
    await assert.rejects(auth.resolveAuth(), isCode('auth-required'))
    assert.equal(await auth.isConfigured(), false)
  }
})

test('scope hashes change on account/key/mode switch and never contain raw identities', async () => {
  const credentials = store(grant()), auth = createOpenDesignAuth({ credentials })
  const before = await auth.resolveAuth(), beforeDisplay = await auth.displayKey()
  await auth.saveApiKey(RUNTIME)
  assert.notEqual((await auth.resolveAuth()).accountKey, before.accountKey)
  assert.notEqual(await auth.displayKey(), beforeDisplay)
  await auth.saveApiKey('sk-amr-another_fixture')
  assert.notEqual((await auth.resolveAuth()).accountKey, before.accountKey)
})

test('device URL must be exact https activation origin/path and not carry the secret', async () => {
  for (const activationUrl of ['http://open-design.ai/cloud/cli/activate', 'https://untrusted.invalid/cloud/cli/activate',
    'https://open-design.ai@untrusted.invalid/cloud/cli/activate', 'https://user:pass@open-design.ai/cloud/cli/activate',
    'https://open-design.ai/cloud/login', '/cloud/cli/activate', 'https://open-design.ai/cloud/cli/activate/other',
    'https://open-design.ai/cloud/cli/activate#fragment', 'https://open-design.ai/cloud/cli/activate?token=device-secret-fixture']) {
    const auth = createOpenDesignAuth({ ...opts(store()), fetchImpl: async () => Response.json({ ...challenge, activationUrl }) })
    const result = await auth.startLogin({ openBrowser: true, opener() { assert.fail('untrusted link opened') } })
    assert.equal(result.status, 'error'); assert.ok(!JSON.stringify(result).includes(challenge.deviceSecret))
  }
})

test('missing device fields and expired challenge fail before polling', async () => {
  for (const override of [{ deviceId: null }, { deviceSecret: null }, { deviceSecret: challenge.userCode },
    { expiresAt: '2029-01-01T00:00:00.000Z' }]) {
    let calls = 0
    const auth = createOpenDesignAuth({ ...opts(store()), fetchImpl: async () => { calls++; return Response.json({ ...challenge, ...override }) } })
    assert.equal((await auth.startLogin()).status, 'error'); assert.equal(calls, 1)
  }
})

test('missing interval and expiry use bounded community defaults, cancel promptly', async () => {
  let delay
  const hold = deferred()
  const auth = createOpenDesignAuth({ ...opts(store()), wait: ms => { delay = ms; return hold.promise },
    fetchImpl: async () => Response.json({ ...challenge, pollIntervalSeconds: undefined, expiresAt: undefined }) })
  const started = await auth.startLogin()
  assert.equal(started.expiresAt, now() + 600000); assert.equal(delay, 2000)
  auth.cancelLogin(); await settle(); assert.equal(auth.loginWatch().status, 'cancelled'); hold.resolve()
})

test('concurrent starts coalesce and cancellation prevents late response storage', async () => {
  const credentials = store(), pending = deferred()
  let calls = 0
  const auth = createOpenDesignAuth({ ...opts(credentials), fetchImpl: async url => { calls++; return url.endsWith('/token') ? pending.promise : Response.json(challenge) } })
  await Promise.all([auth.startLogin(), auth.startLogin()]); await settle()
  assert.equal(calls, 2); auth.cancelLogin(); pending.resolve(Response.json(tokens)); await settle()
  assert.equal(credentials.current(), undefined); assert.equal(auth.loginWatch().status, 'cancelled')
})

test('manual key cancels pending login and wins over a late account approval', async () => {
  const credentials = store(), pending = deferred()
  const auth = createOpenDesignAuth({ ...opts(credentials), fetchImpl: async url => url.endsWith('/token') ? pending.promise : Response.json(challenge) })
  await auth.startLogin(); await settle(); await auth.saveApiKey('sk-amr-replacement_fixture')
  pending.resolve(Response.json(tokens)); await settle()
  assert.equal(credentials.current().payload.type, 'api-key'); assert.equal(credentials.current().payload.access, 'sk-amr-replacement_fixture')
})

test('generation check inside host mutation blocks queued late approval after cancel', async () => {
  const credentials = store(), gate = deferred(), entered = deferred()
  const originalModify = credentials.modifyRecord
  credentials.modifyRecord = async (key, mutate) => { entered.resolve(); await gate.promise; return originalModify(key, mutate) }
  const auth = createOpenDesignAuth({ ...opts(credentials), fetchImpl: async url => Response.json(url.endsWith('/token') ? tokens : challenge) })
  await auth.startLogin(); await entered.promise; auth.cancelLogin(); gate.resolve(); await settle()
  assert.equal(credentials.current(), undefined)
})

test('external record changes during approval are not overwritten', async () => {
  const credentials = store(), pending = deferred()
  const auth = createOpenDesignAuth({ ...opts(credentials), fetchImpl: async url => url.endsWith('/token') ? pending.promise : Response.json(challenge) })
  await auth.startLogin(); await settle()
  credentials.set({ kind: 'grant', payload: { type: 'api-key', access: 'sk-amr-external_fixture' } })
  pending.resolve(Response.json(tokens)); await settle()
  assert.equal(credentials.current().payload.access, 'sk-amr-external_fixture'); assert.equal(auth.loginWatch().status, 'error')
})

test('terminal states and HTTP errors never persist keys, even when an error response carries keys', async () => {
  for (const [status, body] of [[200, { ...tokens, status: 'denied' }], [200, { status: 'expired' }], [200, { status: 'unknown' }],
    [401, tokens], [403, tokens], [404, tokens], [429, tokens], [500, tokens]]) {
    const credentials = store()
    const auth = createOpenDesignAuth({ ...opts(credentials), fetchImpl: async url => url.endsWith('/token') ? Response.json(body, { status }) : Response.json(challenge) })
    await auth.startLogin(); await settle()
    assert.equal(credentials.current(), undefined); assert.equal(auth.loginWatch().status, 'error')
    for (const value of [RUNTIME, CONTROL]) assert.ok(!JSON.stringify(auth.loginWatch()).includes(value))
  }
})

test('approval requires both correctly typed keys; nested user keys are accepted', async () => {
  for (const override of [{ runtimeKey: undefined }, { controlKey: undefined }, { runtimeKey: CONTROL }, { controlKey: RUNTIME }]) {
    const credentials = store()
    const auth = createOpenDesignAuth({ ...opts(credentials), fetchImpl: async url => Response.json(url.endsWith('/token') ? { ...tokens, ...override } : challenge) })
    await auth.startLogin(); await settle(); assert.equal(credentials.current(), undefined)
  }
  const credentials = store()
  const auth = createOpenDesignAuth({ ...opts(credentials), fetchImpl: async url => Response.json(url.endsWith('/token')
    ? { status: 'approved', user: { runtimeKey: RUNTIME, controlKey: CONTROL, appUserId: 'nested-fixture' } } : challenge) })
  await auth.startLogin(); await settle(); assert.equal(credentials.current().payload.uid, 'nested-fixture')
})

test('poll expiry does not send another token request after the deadline', async () => {
  let time = now(), polls = 0
  const auth = createOpenDesignAuth({ credentials: store(), now: () => time, wait: async ms => { time += ms },
    fetchImpl: async url => { if (url.endsWith('/token')) polls++; return Response.json({ ...challenge, expiresAt: new Date(now() + 1000).toISOString() }) } })
  await auth.startLogin(); await settle()
  assert.equal(polls, 0); assert.equal(auth.loginWatch().status, 'error')
})

test('onChange sync/rejected errors cannot undo a saved credential', async () => {
  for (const onChange of [() => { throw new Error('private failure') }, async () => { throw new Error('private failure') }]) {
    const credentials = store(), auth = createOpenDesignAuth({ credentials, onChange })
    await auth.saveApiKey(RUNTIME); await settle(); assert.equal(credentials.current().payload.access, RUNTIME)
  }
})

test('logout cancels login, deletes only its scope and prevents late resurrection', async () => {
  const credentials = store(grant()), pending = deferred()
  const auth = createOpenDesignAuth({ ...opts(credentials), fetchImpl: async url => url.endsWith('/token') ? pending.promise : Response.json(challenge) })
  await auth.startLogin(); await settle(); await auth.logout(); pending.resolve(Response.json(tokens)); await settle()
  assert.equal(credentials.current(), undefined); assert.equal((await auth.status()).loggedIn, false)
  assert.deepEqual(credentials.seen.filter(v => v[0] === 'delete'), [['delete', OPENDESIGN_RECORD]])
})

test('logout without public deletion fails unsupported and does not fake deletion via undefined mutation', async () => {
  const credentials = store(grant(), false), auth = createOpenDesignAuth({ credentials })
  await assert.rejects(auth.logout(), isCode('unsupported')); assert.equal(credentials.current().payload.control, CONTROL)
  assert.equal(credentials.seen.filter(v => v[0] === 'modify').length, 0)
})

test('control transport rejects cross origin/userinfo/runtime key without invoking fetch', async () => {
  for (const [path, key] of [['https://untrusted.invalid/api/v1/x', CONTROL], ['https://user@amr-api.open-design.ai/api/v1/x', CONTROL],
    ['/api/v1/x', RUNTIME], ['/outside', CONTROL]]) {
    await assert.rejects(requestOpenDesignJson(path, { key, fetchImpl() { assert.fail('credential leak') } }), isCode('origin-refused'))
  }
})

test('control transport rejects redirected responses and response URL origin mismatch', async () => {
  for (const response of [{ status: 200, redirected: true }, { status: 200, url: 'https://untrusted.invalid/api/v1/x' }]) {
    await assert.rejects(requestOpenDesignJson('/api/v1/x', { fetchImpl: async () => response }), isCode('origin-refused'))
  }
})

test('response bodies have declared and streaming size limits and invalid JSON is generic', async () => {
  for (const response of [new Response('x', { headers: { 'content-length': '131073' } }), new Response('x'.repeat(131073)), new Response('<html>private</html>'), Response.json([])]) {
    await assert.rejects(requestOpenDesignJson('/api/v1/x', { fetchImpl: async () => response }), isCode('invalid-response'))
  }
})

test('request timeout, external cancellation and pre-abort work even when fake fetch ignores signals', async () => {
  await assert.rejects(requestOpenDesignJson('/api/v1/x', { timeoutMs: 5, fetchImpl: () => new Promise(() => {}) }), isCode('timeout'))
  const controller = new AbortController()
  const pending = requestOpenDesignJson('/api/v1/x', { signal: controller.signal, fetchImpl: () => new Promise(() => {}) })
  controller.abort(); await assert.rejects(pending, isCode('timeout'))
  await assert.rejects(requestOpenDesignJson('/api/v1/x', { signal: controller.signal, fetchImpl() { assert.fail('pre-aborted') } }), isCode('timeout'))
})

test('response stream is cancelled when the bounded request times out', async () => {
  let cancelled = false
  const body = new ReadableStream({ start() {}, cancel() { cancelled = true } })
  await assert.rejects(requestOpenDesignJson('/api/v1/x', { timeoutMs: 5,
    fetchImpl: async () => new Response(body) }), isCode('timeout'))
  await settle(); assert.equal(cancelled, true)
})

test('transport and host errors never echo body, tokens or raw exception messages', async () => {
  await assert.rejects(requestOpenDesignJson('/api/v1/x', { fetchImpl: async () => { throw new Error(RUNTIME) } }), error => !error.message.includes(RUNTIME))
  const credentials = store(); credentials.modifyRecord = async () => { throw new QuotaError('upstream', CONTROL) }
  await assert.rejects(createOpenDesignAuth({ credentials }).saveApiKey(RUNTIME), error => !error.message.includes(CONTROL))
  const result = await requestOpenDesignJson('/api/v1/x', { fetchImpl: async () => Response.json({ runtimeKey: RUNTIME }, { status: 401 }) })
  assert.deepEqual(result, { status: 401, body: undefined })
})
