import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { createOpenDesignProvider, loadOpenDesignHost } from '../lib/opendesign/provider.js'
import { OPENDESIGN_BASE_URL as BASE, OPENDESIGN_MODELS_URL as MODELS } from '../lib/opendesign/models.js'

class LlmError extends Error { constructor(message, code) { super(message); this.code = code } }
const row = id => ({ id, metadata: { context_limit: 128000, context_budget: 32000 } })
const response = (ids = ['m']) => new Response(JSON.stringify({ data: ids.map(row) }))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const collect = async iterable => { const values = []; for await (const value of iterable) values.push(value); return values }

// Deliberately implements only the verified host seam: immutable profile snapshots.
class PiAiAdapter {
  constructor(config) { this.config = config }
  providerInfo(id) { return { id, name: 'OpenDesign' } }
  providerRetryPolicy() {}
  imageRequestTarget(_provider, _model, image) { return image }
  async listModels(provider) {
    const profile = this.config.profiles().get(provider)
    await this.config.resolveApiKey(provider, profile)
    return profile.piProvider.getModels().map(model => ({ provider, id: model.id, name: model.name }))
  }
  async resolveModel(provider, id) {
    const profile = this.config.profiles().get(provider), model = profile.piProvider.getModels().find(model => model.id === id)
    if (!model) throw new LlmError('unknown', 'UNKNOWN_MODEL')
    return { provider, id, name: model.name, context: { contextWindow: model.contextWindow },
      defaultMaxTokens: profile.configuredMaxTokens.get(id) }
  }
  async prepareCall(provider, id) {
    const profile = this.config.profiles().get(provider), model = profile.piProvider.getModels().find(model => model.id === id)
    return { model: await this.resolveModel(provider, id), stream: async function* (options) {
      const apiKey = await this.config.resolveApiKey(provider, profile)
      yield* profile.piProvider.streamSimple(model, { messages: options.messages ?? [] }, { ...options, apiKey })
    }.bind(this) }
  }
}
const host = (protocolApi, protocol = 'chat-completions') => ({ PiAiAdapter, LlmError, protocolApi, protocol, hostVersion: '0.2.1-rc.2', piVersion: '1.1.0' })
async function fixture(options = {}) {
  let identity = { mode: 'api-key', runtimeKey: 'fake-runtime-key', accountKey: 'hash-account-a' }, tick = 1000
  // Synthetic registrations only: this does not activate the real WorkBuddy plugin.
  const routes = new Map(['opencode-go', 'opencode', 'openai-codex', 'workbuddy'].map(id => [id, { original: id }]))
  const originals = [...routes], effects = [], calls = [], wire = []
  const ctx = { get: () => undefined, effect: create => { const dispose = create(); effects.push(dispose); return dispose },
    llm: { registerAdapter(ids, adapter) {
      for (const id of ids) if (routes.has(id)) throw new LlmError('duplicate', 'DUPLICATE_ADAPTER')
      for (const id of ids) routes.set(id, adapter)
      const dispose = () => { for (const id of ids) if (routes.get(id) === adapter) routes.delete(id) }
      dispose.replace = next => { assert.deepEqual(next, ['opendesign']) }
      return dispose
    } } }
  const auth = { async resolveAuth() { if (!identity) throw Object.assign(new Error('missing'), { code: 'auth-required' }); return identity } }
  const protocol = options.api ?? { async *streamSimple(model, context, opts) {
    wire.push({ model, context, opts })
    yield { type: 'text', text: model.id }; yield { type: 'tool-call', id: 'call' }; yield { type: 'usage', input: 10, output: 2 }
  }, stream() { throw new Error('simple path expected') } }
  const api = await createOpenDesignProvider(ctx, { auth, now: () => tick, loadHost: async () => host(protocol, options.protocol),
    fetchImpl: async (url, init) => { calls.push({ url, init }); return response() }, ...options })
  return { api, ctx, calls, wire, routes, originals, effects, adapter: routes.get('opendesign'),
    identity: value => { identity = value }, time: value => { tick = value } }
}

test('factory is lazy and owns only its new route; host failure registers nothing', async () => {
  const f = await fixture()
  assert.equal(f.calls.length, 0)
  for (const [id, value] of f.originals) assert.equal(f.routes.get(id), value)
  f.api.dispose(); f.api.dispose()
  assert.equal(f.routes.has('opendesign'), false)
  assert.equal(f.routes.size, 4)
  await assert.rejects(createOpenDesignProvider({ llm: { registerAdapter() { assert.fail('must gate first') } } }, {
    auth: { resolveAuth() {} }, loadHost: async () => ({ ...host({}), piVersion: '1.3.0' }),
  }), { code: 'unsupported-host' })
})
test('refresh failures and unload preserve all original routes including a synthetic WorkBuddy adapter', async () => {
  let fail = false
  const f = await fixture({ fetchImpl: async () => fail ? new Response('{}', { status: 401 }) : response() })
  await f.adapter.listModels('opendesign')
  fail = true
  await assert.rejects(f.api.refresh({ force: true }), { code: 'auth-required' })
  for (const [id, value] of f.originals) assert.equal(f.routes.get(id), value, id)
  f.api.dispose()
  for (const [id, value] of f.originals) assert.equal(f.routes.get(id), value, id)
  assert.equal(f.routes.size, f.originals.length)
})

test('stripTemperature is opt-in and removes only the temperature field on the wire', async () => {
  const requests = []
  const api = { async *streamSimple(model, context, options) {
    await options.fetch(model.baseUrl + '/chat/completions', { method: 'POST',
      headers: { authorization: 'Bearer ' + options.apiKey },
      body: JSON.stringify({ model: model.id, temperature: 0, max_tokens: options.maxTokens, messages: context.messages }) })
    yield { type: 'text', text: 'ok' }
  }, stream() { assert.fail('simple transport expected') } }
  const record = async (url, options) => {
    if (url !== MODELS) requests.push(JSON.parse(options.body ?? '{}'))
    return url === MODELS ? response() : new Response('ok')
  }
  const off = await fixture({ api, fetchImpl: record })
  await collect(off.adapter.stream({ provider: 'opendesign', model: 'm', messages: [{ role: 'user', content: [] }] }))
  assert.equal(requests.at(-1).temperature, 0, 'default keeps the field untouched')
  assert.equal(off.api.status().stripTemperature, false)
  off.api.dispose()

  const on = await fixture({ api, stripTemperature: true, fetchImpl: record })
  await collect(on.adapter.stream({ provider: 'opendesign', model: 'm', messages: [{ role: 'user', content: [] }] }))
  const sent = requests.at(-1)
  assert.equal(Object.hasOwn(sent, 'temperature'), false, 'opt-in removes only temperature')
  assert.equal(sent.max_tokens, 8192, 'other fields survive')
  assert.equal(sent.model, 'm')
  assert.equal(on.api.status().stripTemperature, true)
  on.api.dispose()
})



test('the roster load prunes stale preference ids once and survives a failing prune', async () => {
  let pruneCalls = 0, pruneArg = null
  const preferences = {
    snapshot: () => ({ disabledModels: ['ghost'], reasoning: {} }),
    async prune(ids) { pruneCalls += 1; pruneArg = ids; return false },
    subscribe() { return () => {} },
  }
  const f = await fixture({ preferences, fetchImpl: async () => response(['kept']) })
  await f.api.refresh()
  await f.api.refresh({ force: true })
  assert.equal(pruneCalls, 1, 'pruned once per mount, not per refresh')
  assert.deepEqual(pruneArg, ['kept'])

  const failing = { snapshot: () => ({ disabledModels: [], reasoning: {} }), async prune() { throw new Error('disk full') }, subscribe() { return () => {} } }
  const g = await fixture({ preferences: failing, fetchImpl: async () => response(['m']) })
  const status = await g.api.refresh()
  assert.equal(status.modelCount, 1, 'a failed prune leaves the roster intact')
  g.api.dispose()
})

test('current account catalog loads before list and dispatch; only runtime credential reaches fixed roster', async () => {
  const f = await fixture()
  assert.deepEqual((await f.adapter.listModels('opendesign')).map(row => row.id), ['m'])
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url, MODELS)
  assert.equal(f.calls[0].init.headers.authorization, 'Bearer fake-runtime-key')
  assert.equal(f.calls[0].init.redirect, 'error')
  const prepared = await f.adapter.prepareCall('opendesign', 'm')
  const chunks = await collect(prepared.stream({ provider: 'opendesign', model: 'm', maxTokens: 99999, temperature: 0.4 }))
  assert.deepEqual(chunks.map(chunk => chunk.type), ['text', 'tool-call', 'usage'])
  assert.equal(f.wire[0].opts.apiKey, 'fake-runtime-key'); assert.equal(f.wire[0].opts.maxTokens, 8192)
  assert.equal(f.wire[0].opts.temperature, 0.4, 'no undocumented temperature stripping')
  assert.equal(f.wire[0].opts.headers, undefined, 'no OpenCode session patch')
  await assert.rejects(f.wire[0].opts.fetch('https://bad.invalid/v1/responses'), { code: 'ORIGIN_REFUSED' })
  assert.equal(JSON.stringify(f.api.status()).includes('fake-runtime-key'), false)
  f.api.dispose()
})
// These are injected wire mocks, not a claim that the vendor Responses endpoint was probed.
for (const selection of [undefined, 'responses']) {
  test('wire mock uses ' + (selection ?? 'default chat-completions') + ' and its matching model API', async () => {
    const chosen = selection ?? 'chat-completions'
    const apiName = chosen === 'responses' ? 'openai-responses' : 'openai-completions'
    const path = chosen === 'responses' ? '/responses' : '/chat/completions'
    const requests = [], loadOptions = []
    const api = { async *streamSimple(model, context, options) {
      assert.equal(model.api, apiName)
      const body = { model: model.id, stream: true,
        ...(chosen === 'responses' ? { input: context.messages, max_output_tokens: options.maxTokens }
          : { messages: context.messages, max_tokens: options.maxTokens }) }
      await options.fetch(model.baseUrl + path, { method: 'POST', signal: options.signal,
        headers: { authorization: 'Bearer ' + options.apiKey }, body: JSON.stringify(body) })
      yield { type: 'text', text: 'ok' }
    }, stream() { assert.fail('simple transport expected') } }
    const f = await fixture({ protocol: selection, api,
      loadHost: async (_ctx, options) => { loadOptions.push(options); return host(api, options.protocol) },
      fetchImpl: async (url, options) => {
        requests.push({ url, options }); return url === MODELS ? response() : new Response('mock wire result')
      } })
    const chunks = await collect(f.adapter.stream({ provider: 'opendesign', model: 'm', messages: [{ role: 'user', content: [] }] }))
    assert.equal(chunks[0].text, 'ok'); assert.equal(f.api.status().protocol, chosen)
    assert.deepEqual(loadOptions, [{ protocol: chosen }])
    assert.equal(requests[1].url, BASE + path); assert.equal(requests[1].options.redirect, 'error')
    const body = JSON.parse(requests[1].options.body)
    assert.equal(body[chosen === 'responses' ? 'max_output_tokens' : 'max_tokens'], 8192)
    assert.ok(Array.isArray(body[chosen === 'responses' ? 'input' : 'messages']))
    assert.equal(body[chosen === 'responses' ? 'messages' : 'input'], undefined)
    assert.equal(requests[1].options.headers.authorization, 'Bearer fake-runtime-key')
    f.api.dispose()
  })
}
test('successful updates replace snapshots without changing a prepared generation', async () => {
  let ids = ['old']
  const f = await fixture({ fetchImpl: async () => response(ids) })
  const prepared = await f.adapter.prepareCall('opendesign', 'old')
  ids = ['new']; await f.api.refresh({ force: true })
  assert.deepEqual((await f.adapter.listModels('opendesign')).map(row => row.id), ['new'])
  assert.equal((await collect(prepared.stream({ provider: 'opendesign', model: 'old' })))[0].text, 'old')
  f.api.dispose()
})
test('a changed account cannot execute an old prepared request or reuse its catalog', async () => {
  const f = await fixture()
  const prepared = await f.adapter.prepareCall('opendesign', 'm')
  f.identity({ mode: 'account', runtimeKey: 'different-fake-key', controlKey: 'never-wire-control', accountKey: 'hash-account-b' })
  await assert.rejects(collect(prepared.stream({ provider: 'opendesign', model: 'm' })), { code: 'AUTH_CHANGED' })
  assert.equal(f.wire.length, 0); assert.equal(f.api.status().modelCount, 0)
  await f.adapter.listModels('opendesign')
  assert.equal(f.calls[1].init.headers.authorization, 'Bearer different-fake-key')
  assert.equal(JSON.stringify(f.calls).includes('never-wire-control'), false)
  f.api.dispose()
})
test('missing authentication lists no models, invalidation blocks existing prepared calls', async () => {
  const f = await fixture()
  f.identity(undefined)
  assert.deepEqual(await f.adapter.listModels('opendesign'), [])
  assert.equal(f.calls.length, 0)
  f.identity({ mode: 'api-key', runtimeKey: 'fake-key', accountKey: 'hash' })
  const prepared = await f.adapter.prepareCall('opendesign', 'm')
  f.api.invalidate()
  await assert.rejects(collect(prepared.stream({})), { code: 'cancelled' })
  f.api.dispose()
})
test('ordinary refresh is single flight and TTL failures retain same-account last-known-good status', async () => {
  const gate = deferred(); let count = 0, reject = false
  const f = await fixture({ fetchImpl: async () => { count++; if (reject) throw new Error('sensitive upstream body'); return gate.promise } })
  const a = f.api.refresh(), b = f.api.refresh(); await new Promise(done => setImmediate(done))
  assert.equal(count, 1); gate.resolve(response()); await Promise.all([a, b])
  reject = true; f.time(999999)
  assert.equal((await f.adapter.listModels('opendesign')).length, 1)
  assert.equal(f.api.status().stale, true); assert.equal(f.api.status().error.code, 'network')
  assert.equal(JSON.stringify(f.api.status()).includes('sensitive'), false)
  f.api.dispose()
})
test('dispose aborts ignored network and late data never publishes', async () => {
  const gate = deferred(), started = deferred(); let signal
  const f = await fixture({ fetchImpl: async (_url, options) => { signal = options.signal; started.resolve(); return gate.promise } })
  const task = f.api.refresh(); await started.promise; f.effects.forEach(dispose => dispose())
  await assert.rejects(task, { code: 'cancelled' }); assert.equal(signal.aborted, true)
  gate.resolve(response(['late'])); await new Promise(done => setImmediate(done))
  assert.equal(f.api.status().modelCount, 0); assert.equal(f.routes.size, 4)
})
test('401 clears old catalog; malformed envelopes and size overflow are explicit', async () => {
  let result = response()
  const f = await fixture({ fetchImpl: async () => result })
  await f.api.refresh(); result = new Response('private body', { status: 401 })
  await assert.rejects(f.api.refresh({ force: true }), { code: 'auth-required' })
  assert.equal(f.api.status().modelCount, 0)
  result = new Response('not json')
  await assert.rejects(f.api.refresh(), { code: 'invalid-response' })
  f.api.dispose()
  const limited = await fixture({ maxCatalogBytes: 10 })
  await assert.rejects(limited.api.refresh(), { code: 'invalid-response' }); limited.api.dispose()
})
test('duplicate registration cannot displace an existing provider', async () => {
  const f = await fixture()
  await assert.rejects(createOpenDesignProvider(f.ctx, { auth: { resolveAuth() {} }, loadHost: async () => host({ stream() {}, streamSimple() {} }) }), { code: 'DUPLICATE_ADAPTER' })
  assert.equal(f.routes.get('opendesign'), f.adapter); f.api.dispose()
})

function loaderFixture({ shared = false, piVersion = '1.1.0', protocol = 'chat-completions', manifest = true, hostVersion = '0.2.1-rc.2' } = {}) {
  const parent = 'file:///host/adapter/lib/index.js', imports = [], resolutions = []
  const exportsMap = { './api/*': { import: './dist/api/*.js' } }
  const packages = { resolution: { entries: [{ name: '@deepseek-ai/dsh-llm-pi-ai', scope: 'installation', packageDir: '/host/adapter' }] },
    packageOf(name, importer) {
      if (name === '@deepseek-ai/dsh-llm-pi-ai') return { dir: '/host/adapter', version: hostVersion }
      if (name === '@earendil-works/pi-ai') return { dir: importer === parent || shared ? '/host/pi' : '/profile/pi', version: piVersion,
        ...(manifest ? { manifest: { exports: exportsMap } } : {}) }
      if (name === '@deepseek-ai/dsh-llm') return { dir: '/host/llm', version: hostVersion, manifest: { exports: { '.': { import: './lib/index.js' } } } }
    } }
  // The manifest path is exercised by its own unit suite; here it stands in for
  // the file a loader would pick, so the bridge's choice of copy is observable.
  const resolvePackage = async (pkg, subpath, importModule) => {
    resolutions.push({ dir: pkg.dir, subpath })
    return importModule(pkg.dir === '/host/pi' ? 'file:///host/pi/dist/api/' + subpath.split('/').at(-1) + '.js' : 'file:///host/llm/lib/index.js')
  }
  const seams = { protocol, resolveModule: () => parent, resolvePackage,
    importModule: async specifier => {
      imports.push(specifier)
      if (specifier === parent) return { PiAiAdapter }
      if (specifier.includes('responses') || specifier.includes('completions')) return {
        openAIResponsesApi: () => ({ stream() {}, streamSimple() {} }), openAICompletionsApi: () => ({ stream() {}, streamSimple() {} }) }
      if (specifier.includes('llm')) return { LlmError }
      throw new Error('unexpected import')
    } }
  return { ctx: { get: () => packages }, seams, imports, resolutions }
}
test('host transport comes from the host package even when profile pi-ai is another copy', async () => {
  const f = loaderFixture()
  const result = await loadOpenDesignHost(f.ctx, f.seams)
  assert.equal(result.piVersion, '1.1.0')
  assert.ok(f.imports.some(value => value.includes('/host/pi/dist/api/openai-completions.lazy.js')))
  assert.equal(f.imports.some(value => value.startsWith('@earendil')), false)
  // dsh-llm already resolves to the host copy, so only pi-ai needs the manifest path.
  assert.ok(f.imports.includes('@deepseek-ai/dsh-llm'))
  assert.equal(f.resolutions.length, 1)
  assert.equal(f.resolutions[0].dir, '/host/pi')
})
test('explicit Responses resolves only its host lazy transport', async () => {
  const f = loaderFixture({ protocol: 'responses' })
  const result = await loadOpenDesignHost(f.ctx, f.seams)
  assert.equal(result.protocol, 'responses')
  assert.ok(f.imports.some(value => value.includes('/host/pi/dist/api/openai-responses.lazy.js')))
  assert.equal(f.imports.some(value => value.includes('completions')), false)
})
test('request timeout is named and raw transport failures are redacted', async () => {
  const pending = await fixture({ timeoutMs: 5, fetchImpl: async () => new Promise(() => {}) })
  const keepAlive = setTimeout(() => {}, 100)
  try { await assert.rejects(pending.api.refresh(), { code: 'timeout' }) }
  finally { clearTimeout(keepAlive); pending.api.dispose() }
  const broken = await fixture({ fetchImpl() { throw new Error('SECRET fake transport body') } })
  await assert.rejects(broken.api.refresh(), error => error.code === 'network' && !error.message.includes('SECRET'))
  assert.equal(JSON.stringify(broken.api.status()).includes('SECRET'), false); broken.api.dispose()
})
test('account change during discovery cannot publish a previous-account roster', async () => {
  const gate = deferred(), started = deferred()
  const f = await fixture({ fetchImpl: async () => { started.resolve(); return gate.promise } })
  const refresh = f.api.refresh(); await started.promise
  f.identity({ mode: 'api-key', runtimeKey: 'fake-new-key', accountKey: 'new-hash' })
  gate.resolve(response(['old-account-only']))
  await assert.rejects(refresh, error => error.code === 'cancelled' || error.code === 'AUTH_CHANGED')
  assert.equal(f.api.status().modelCount, 0); f.api.dispose()
})
test('an identical copy is imported directly, without the manifest path', async () => {
  const shared = loaderFixture({ shared: true })
  await loadOpenDesignHost(shared.ctx, shared.seams)
  assert.ok(shared.imports.includes('@earendil-works/pi-ai/api/openai-completions.lazy'))
  assert.equal(shared.resolutions.length, 0)
})

test('a host package without a usable manifest is refused, not guessed at', async () => {
  const f = loaderFixture({ manifest: false, resolvePackage: undefined })
  const withoutSeam = { ...f.seams }
  delete withoutSeam.resolvePackage
  await assert.rejects(loadOpenDesignHost(f.ctx, withoutSeam), { code: 'unsupported-host' })
})

test('a pi-ai version the bridge was not written for is rejected before any import', async () => {
  const newer = loaderFixture({ piVersion: '1.3.0' })
  await assert.rejects(loadOpenDesignHost(newer.ctx, newer.seams), { code: 'unsupported-host' })
  assert.equal(newer.imports.length, 0)
})

test('a host patch release stays on the compatibility line instead of dead-ending', async () => {
  // Regression: the gate compared version strings for equality, so upgrading DSH
  // from rc.2 to rc.3 dropped the whole OpenDesign route without an explanation.
  const upgraded = loaderFixture({ hostVersion: '0.2.1-rc.3' })
  const host = await loadOpenDesignHost(upgraded.ctx, upgraded.seams)
  assert.equal(host.hostVersion, '0.2.1-rc.3', 'a patch release still resolves')

  const moved = loaderFixture({ hostVersion: '0.3.0' })
  await assert.rejects(() => loadOpenDesignHost(moved.ctx, moved.seams), /verified host pi-ai adapter/,
    'a major.minor change still fails closed')
})
