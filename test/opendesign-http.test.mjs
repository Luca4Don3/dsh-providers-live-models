import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleOpenDesignHttp, validateOpenDesignRequest } from '../lib/opendesign/http.js'
import { handleLoginHttp } from '../lib/subscription/login-http.js'
import { createOpenDesignAuth, OPENDESIGN_RECORD } from '../lib/opendesign/auth.js'

const PREFIX = '/dsh-opencode-live-models/opendesign'
function req(method, path, body, headers = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body ?? {})
  return { method, url: PREFIX + path, headers: { host: '127.0.0.1:54626', origin: 'http://127.0.0.1:54626', 'content-type': 'application/json', ...headers },
    async *[Symbol.asyncIterator]() { yield Buffer.from(raw) } }
}
function res() {
  return { status: undefined, body: undefined, headers: {}, writeHead(status, headers) { this.status = status; this.headers = headers }, end(value) { this.body = JSON.parse(value) } }
}
function authFixture() {
  const calls = []
  let mode = null, watch = null
  const auth = { calls,
    async status() { return { loggedIn: !!mode, mode, login: watch, access: 'sk-amr-private-status', control: 'vela_ctrl_private-status' } },
    loginWatch: () => watch,
    async startLogin(options) { assert.equal(options.openBrowser, false); calls.push('login'); watch = { status: 'waiting', userCode: 'TEST-CODE', openUrl: 'https://open-design.ai/cloud/cli/activate?code=example', deviceSecret: 'private-device-secret' }; return watch },
    cancelLogin() { calls.push('cancel'); watch = { status: 'cancelled' } },
    async saveApiKey(key) { calls.push(['key', key]); mode = 'api-key'; watch = null },
    async logout() { calls.push('logout'); mode = null },
  }
  return auth
}
async function call(auth, method, path, body, headers, provider, extra = {}) {
  const result = res()
  await handleOpenDesignHttp({}, req(method, path, body, headers), result,
    { auth, getProvider: () => provider, ...extra })
  return result
}

test('OpenDesign controls require local host, same origin and JSON mutations', async () => {
  const auth = authFixture()
  for (const headers of [
    { host: 'attacker.invalid' }, { host: 'localhost#fragment' }, { host: 'user@localhost' },
    { origin: 'https://attacker.invalid' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' },
    { 'content-type': 'text/plain' }, { 'content-type': 'application/x-www-form-urlencoded' },
  ]) {
    const result = await call(auth, 'POST', '/login', {}, headers)
    assert.equal(result.status, 403)
  }
  assert.deepEqual(auth.calls, [])
  assert.equal(validateOpenDesignRequest(req('POST', '/login', {}, { host: '[::1]:54626', origin: 'http://[::1]:54626' })), true)
})

test('status whitelists both auth and provider fields and is never cacheable', async () => {
  const provider = { status: () => ({ available: true, configured: true, loading: false, modelCount: 3,
    protocol: 'responses', access: 'sk-amr-provider-private', headers: { authorization: 'Bearer private' }, error: { message: 'sk-amr-error-private' } }) }
  const result = await call(authFixture(), 'GET', '/status', undefined, undefined, provider)
  assert.equal(result.status, 200)
  assert.equal(result.headers['cache-control'], 'no-store')
  assert.equal(result.body.models.modelCount, 3)
  assert.equal(result.body.models.state, 'error')
  assert.equal(result.body.models.protocol, 'responses')
  assert.ok(!JSON.stringify(result.body).includes('private'))
})

test('account authorization and cancellation expose a code but never the device secret', async () => {
  const auth = authFixture()
  const started = await call(auth, 'POST', '/login')
  assert.equal(started.status, 200)
  assert.equal(started.body.login.userCode, 'TEST-CODE')
  assert.equal(started.body.login.openUrl, 'https://open-design.ai/cloud/cli/activate?code=example')
  assert.ok(!JSON.stringify(started.body).includes('private-device-secret'))
  assert.equal((await call(auth, 'POST', '/cancel')).body.login.status, 'cancelled')
  assert.deepEqual(auth.calls, ['login', 'cancel'])
})

test('manual API key uses only the OpenDesign controller and is never echoed', async () => {
  const auth = authFixture()
  const result = await call(auth, 'POST', '/key', { apiKey: 'sk-amr-http-fixture' })
  assert.equal(result.status, 200)
  assert.equal(result.body.mode, 'api-key')
  assert.equal(result.body.usageAvailable, false)
  assert.ok(!JSON.stringify(result.body).includes('sk-amr-'))
  assert.deepEqual(auth.calls, [['key', 'sk-amr-http-fixture']])
})

test('key save with real auth controller preserves Codex and OpenCode grant records', async () => {
  const records = new Map([
    ['llm-pi-ai/openai-codex', { kind: 'grant', payload: { type: 'oauth', access: 'codex-private' } }],
    ['dsh-opencode-live-models/opencode-console', { kind: 'grant', payload: { access: 'console-private' } }],
  ])
  const before = structuredClone([...records])
  const credentials = {
    async readRecord(key) { return records.get(key) },
    async describeRecord(key) { return { configured: records.has(key) } },
    async modifyRecord(key, update) { const next = await update(records.get(key)); if (next !== undefined) records.set(key, next); return records.get(key) },
    async deleteRecord(key) { records.delete(key) },
  }
  const auth = createOpenDesignAuth({ credentials, fetchImpl() { assert.fail('saving a key must not issue an authentication request') } })
  const result = await call(auth, 'POST', '/key', { apiKey: 'sk-amr-isolated-fixture' })
  assert.equal(result.status, 200)
  assert.ok(records.has(OPENDESIGN_RECORD))
  for (const [key, value] of before) assert.deepEqual(records.get(key), value)
  assert.equal((await call(auth, 'POST', '/logout')).body.loggedIn, false)
  assert.equal(records.has(OPENDESIGN_RECORD), false)
  for (const [key, value] of before) assert.deepEqual(records.get(key), value)
})

test('invalid or oversized key bodies fail before touching the controller', async () => {
  const auth = authFixture()
  for (const body of ['{', '[]', 'null', {}, { apiKey: '' }, { apiKey: 'x'.repeat(17000) }]) {
    const result = await call(auth, 'POST', '/key', body)
    assert.equal(result.status, 400)
  }
  assert.deepEqual(auth.calls, [])
})

test('controller and remote exceptions are mapped without echoing private messages', async () => {
  const auth = authFixture()
  auth.saveApiKey = async () => { throw Object.assign(new Error('sk-amr-never-echo'), { code: 'invalid-response' }) }
  const result = await call(auth, 'POST', '/key', { apiKey: 'sk-amr-input' })
  assert.equal(result.status, 502)
  assert.deepEqual(result.body, { error: 'invalid-response' })
})

test('directory refresh is isolated and unavailable adapters fail explicitly', async () => {
  const auth = authFixture()
  assert.equal((await call(auth, 'POST', '/models/refresh')).status, 503)
  let refreshes = 0
  const provider = { async refresh(options) { assert.equal(options.force, true); refreshes++ }, status: () => ({ available: true, configured: true, modelCount: 2 }) }
  const result = await call(auth, 'POST', '/models/refresh', {}, undefined, provider)
  assert.equal(result.status, 200)
  assert.equal(refreshes, 1)
  assert.equal(result.body.models.modelCount, 2)
})

test('new routes go through the existing prefix without consulting Codex authentication', async () => {
  const result = res()
  await handleLoginHttp({ get() { assert.fail('OpenDesign must not invoke another authentication service') } }, req('POST', '/key', { apiKey: 'sk-amr-facade-fixture' }), result, { openDesignAuth: authFixture() })
  assert.equal(result.status, 200)
  assert.equal(result.body.mode, 'api-key')
})

test('the model list route exposes only ids, names, capacities and input modalities', async () => {
  const provider = { status: () => ({ available: true, configured: true, modelCount: 2 }),
    models: () => [
      { id: 'od-one', name: 'OD One', contextWindow: 128000, maxTokens: 8192, input: ['text', 'image'], secret: 'sk-amr-nope' },
      { id: 'od-two', name: 'OD Two', contextWindow: 200000, maxTokens: 4096, input: ['text', 'file'] },
    ] }
  const result = await call(authFixture(), 'GET', '/models', undefined, undefined, provider)
  assert.equal(result.status, 200)
  assert.deepEqual(result.body.models, [
    { id: 'od-one', name: 'OD One', contextWindow: 128000, outputTokenBudget: 8192, enabled: true, reasoningLevels: [], input: ['text', 'image'] },
    { id: 'od-two', name: 'OD Two', contextWindow: 200000, outputTokenBudget: 4096, enabled: true, reasoningLevels: [], input: ['text'] },
  ])
  assert.ok(!JSON.stringify(result.body).includes('sk-amr'))
})

test('a model list without an adapter is empty rather than an error', async () => {
  const result = await call(authFixture(), 'GET', '/models')
  assert.equal(result.status, 200)
  assert.deepEqual(result.body.models, [])
  assert.equal(result.body.status.state, 'unavailable')
})

test('the enabled set persists only known ids and re-applies the route', async () => {
  const applied = [], saved = []
  const provider = { status: () => ({ available: true, configured: true, modelCount: 1 }), models: () => [{ id: 'od-one', name: 'One', contextWindow: 1, maxTokens: 1, input: ['text'] }],
    applyPreferences() { applied.push(1) } }
  const preferences = { snapshot: () => ({ disabledModels: ['od-one'] }), async setDisabledModels(ids) { saved.push(ids) } }
  const result = res()
  await handleOpenDesignHttp({}, req('POST', '/models/enabled', { enabledModels: ['od-one'] }), result, { auth: authFixture(), getProvider: () => provider, preferences })
  assert.equal(result.status, 200)
  assert.deepEqual(saved, [[]])
  assert.equal(applied.length, 1)
})

test('an unknown or malformed enabled set is refused without touching storage', async () => {
  const saved = []
  const provider = { status: () => ({ available: true }), models: () => [{ id: 'od-one' }] }
  const preferences = { snapshot: () => ({ disabledModels: [] }), async setDisabledModels(ids) { saved.push(ids) } }
  for (const body of [{ enabledModels: ['ghost'] }, { enabledModels: 'nope' }, { enabledModels: [1] }, { enabledModels: new Array(501).fill('od-one') }]) {
    const result = res()
    await handleOpenDesignHttp({}, req('POST', '/models/enabled', body), result, { auth: authFixture(), getProvider: () => provider, preferences })
    assert.equal(result.status, 400)
  }
  assert.deepEqual(saved, [])
})


test('the unified catalog lists OpenDesign beside the overlaid routes', async () => {
  const provider = { status: () => ({ available: true, configured: true, modelCount: 1 }), models: () => [
    { id: 'od-one', name: 'OD One', contextWindow: 1000, maxTokens: 8192, input: ['text'], reasoningLevels: [] }] }
  const result = await call(authFixture(), 'GET', '/routes', undefined, undefined, provider, {
    getRoutes: () => [{ id: 'opencode-go', label: 'OpenCode Go', models: [{ id: 'go-a', name: 'Go A', enabled: true }] }],
    preferences: { snapshot: () => ({ disabledModels: [], reasoning: {}, providers: {} }) },
  })
  assert.equal(result.status, 200)
  assert.deepEqual(result.body.routes.map(route => route.id), ['opencode-go', 'opendesign'])
  assert.equal(result.body.routes[1].group, 'opendesign')
})


test('a disabled id from the store is reported as disabled by the catalog', async () => {
  const provider = { status: () => ({ available: true }), models: () => [] }
  const preferences = { snapshot: () => ({ disabledModels: [], reasoning: {}, providers: { 'opencode-go': { disabledModels: ['go-b'] } } }) }
  const result = await call(authFixture(), 'GET', '/routes', undefined, undefined, provider, {
    getRoutes: () => [{ id: 'opencode-go', label: 'OpenCode Go', models: [
      { id: 'go-a', name: 'Go A', enabled: true }, { id: 'go-b', name: 'Go B', enabled: false }] }],
    preferences,
  })
  assert.deepEqual(result.body.routes[0].models.map(model => [model.id, model.enabled]), [['go-a', true], ['go-b', false]])
})

test('unknown routes and missing services remain explicit and foreign prefixes fall through', async () => {
  assert.equal((await call(undefined, 'GET', '/status')).status, 503)
  assert.equal((await call(authFixture(), 'POST', '/not-found')).status, 404)
  const request = req('GET', '/status'); request.url = '/dsh-opencode-live-models/status'
  assert.equal(await handleOpenDesignHttp({}, request, res()), false)
})
