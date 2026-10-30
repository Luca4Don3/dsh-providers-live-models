/**
 * Optional real-package smoke test; install a host into an isolated directory first.
 * No vendor requests or credentials are used. The global fetch is a tripwire.
 * Run: node --experimental-import-meta-resolve scripts/verify-opendesign-host.mjs <fixture-dir>
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createOpenDesignProvider, loadOpenDesignHost } from '../lib/opendesign/provider.js'
import { loadHostCatalogs } from '../lib/host-catalogs.js'
import { OPENDESIGN_MODELS_URL, OPENDESIGN_BASE_URL } from '../lib/opendesign/models.js'

const HOST = '@deepseek-ai/dsh-llm-pi-ai'
const fixture = resolve(process.argv[2] ?? '')
assert.ok(process.argv[2], 'supply the isolated fixture directory')
const hostEntry = pathToFileURL(createRequire(resolve(fixture, 'package.json')).resolve(HOST)).href
const packages = new Map()
for (const name of [HOST, '@earendil-works/pi-ai', '@deepseek-ai/dsh-llm']) {
  const entry = name === HOST ? hostEntry : import.meta.resolve(name, hostEntry)
  const dir = resolve(dirname(fileURLToPath(entry)), '..')
  const { default: manifest } = await import(pathToFileURL(resolve(dir, 'package.json')).href, { with: { type: 'json' } })
  assert.equal(manifest.name, name)
  packages.set(name, { dir, version: manifest.version, manifest })
}
const hostVersion = packages.get(HOST).version
const piVersion = packages.get('@earendil-works/pi-ai').version
const report = { hostVersion, piVersion }
const routes = new Map()
const metadata = {
  packageOf(name, importer) {
    // The plugin owns no peer installation. Resolution must use the host manifest.
    return importer === new URL('../lib/opendesign/provider.js', import.meta.url).href ? undefined : packages.get(name)
  },
  resolution: { entries: [{ name: HOST, scope: 'installation', packageDir: packages.get(HOST).dir }] },
}
const ctx = {
  get: name => name === 'pluginPackages' ? metadata : undefined,
  effect() {},
  llm: { registerAdapter(ids, adapter) {
    for (const id of ids) { assert.equal(routes.has(id), false); routes.set(id, adapter) }
    const release = () => { for (const id of ids) if (routes.get(id) === adapter) routes.delete(id) }
    release.replace = ids => assert.deepEqual(ids, ['opendesign'])
    return release
  } },
}
const resolveModule = () => hostEntry
const originalFetch = globalThis.fetch
globalThis.fetch = async () => { throw new Error('network access is forbidden by the compatibility test') }
try {
  // Check host catalog exports, even when the OpenDesign version gate rejects it.
  const catalogs = await loadHostCatalogs(ctx, { resolveModule })
  assert.deepEqual([...catalogs.keys()], ['opencode-go', 'opencode', 'openai-codex'])
  report.catalogs = 'exports loaded'
  let host
  try { host = await loadOpenDesignHost(ctx, { resolveModule }) }
  catch (error) {
    assert.equal(error.code, 'unsupported-host')
    assert.equal(routes.size, 0)
    console.log(JSON.stringify({ ...report, status: 'unsupported-host', reason: error.message }))
    process.exitCode = 2
  }
  if (host) {
    const collect = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks }
    const sse = events => new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    for (const protocol of ['chat-completions', 'responses']) {
      const selectedHost = await loadOpenDesignHost(ctx, { resolveModule, protocol })
      const wires = []
      const ids = ['deepseek-v4.1-flash', 'glm-5.3-flash']
      let identity, toolMode = false, disabled = []
      const makeOptions = model => ({ provider: 'opendesign', model, sessionId: 'synthetic-cache-session',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
        tools: [{ name: 'synthetic_tool', description: 'synthetic fixture only', parameters: { type: 'object', properties: { ok: { type: 'boolean' } } } }],
      })
      const fetchImpl = async (input, init = {}) => {
        const url = String(input)
        assert.ok(identity, 'signed-out requests must not reach the wire')
        if (url === OPENDESIGN_MODELS_URL) return Response.json({ data: ids.map(id => ({ id, metadata: { context_limit: 128000 } })) })
        assert.equal(url, OPENDESIGN_BASE_URL + (protocol === 'responses' ? '/responses' : '/chat/completions'))
        assert.equal(init.redirect, 'error')
        assert.equal(new Headers(init.headers).get('authorization'), 'Bearer ' + identity.runtimeKey)
        assert.equal(new Headers(init.headers).has('x-opencode-session'), false)
        const body = JSON.parse(init.body)
        wires.push(body)
        if (protocol === 'chat-completions') {
          const base = { id: 'synthetic-completion', object: 'chat.completion.chunk', model: body.model }
          return sse([
            { ...base, choices: [{ index: 0, delta: toolMode
              ? { role: 'assistant', tool_calls: [{ index: 0, id: 'synthetic-call', type: 'function', function: { name: 'synthetic_tool', arguments: '{"ok":true}' } }] }
              : { role: 'assistant', content: 'ok' }, finish_reason: null }] },
            { ...base, choices: [{ index: 0, delta: {}, finish_reason: toolMode ? 'tool_calls' : 'stop' }] },
            { ...base, choices: [], usage: { prompt_tokens: 100, completion_tokens: 2, total_tokens: 102, prompt_tokens_details: { cached_tokens: 80 } } },
          ])
        }
        const item = toolMode
          ? { type: 'function_call', id: 'synthetic-item', call_id: 'synthetic-call', name: 'synthetic_tool', arguments: '{"ok":true}', status: 'completed' }
          : { type: 'message', id: 'synthetic-item', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok', annotations: [] }] }
        return sse([
          { type: 'response.created', response: { id: 'synthetic-response', model: body.model, status: 'in_progress', output: [] } },
          { type: 'response.output_item.added', output_index: 0, item: toolMode ? { ...item, arguments: '', status: 'in_progress' } : { ...item, content: [], status: 'in_progress' } },
          ...(toolMode ? [{ type: 'response.function_call_arguments.delta', output_index: 0, item_id: item.id, delta: item.arguments }]
            : [{ type: 'response.output_text.delta', output_index: 0, item_id: item.id, content_index: 0, delta: 'ok' }]),
          { type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response: { id: 'synthetic-response', model: body.model, status: 'completed', output: [item], usage: { input_tokens: 100, output_tokens: 2, total_tokens: 102, input_tokens_details: { cached_tokens: 80 } } } },
        ])
      }
      const api = await createOpenDesignProvider(ctx, {
        protocol,
        auth: { resolveAuth: async () => { if (!identity) throw Object.assign(new Error('signed out fixture'), { code: 'auth-required' }); return identity } },
        preferences: { snapshot: () => ({ disabledModels: disabled }) },
        loadHost: async () => selectedHost, fetchImpl,
      })
      try {
        const adapter = routes.get('opendesign')
        assert.deepEqual(await adapter.listModels('opendesign'), [])
        assert.equal(wires.length, 0)
        identity = { runtimeKey: 'synthetic-runtime-key', accountKey: 'synthetic-account-a' }
        assert.deepEqual((await adapter.listModels('opendesign')).map(m => m.id), ids)
        for (const id of ids) {
          const info = await adapter.resolveModel('opendesign', id)
          assert.equal(info.context.contextWindow, 128000)
          const prepared = await adapter.prepareCall('opendesign', id)
          const chunks = await collect(prepared.stream(makeOptions(id)))
          assert.ok(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'ok'), 'real SSE text must decode')
          assert.equal(chunks.find(chunk => chunk.type === 'usage').usage.cacheReadTokens, 80)
          const body = wires.at(-1)
          assert.equal(body.model, id)
          assert.equal(body.prompt_cache_retention, id.startsWith('deepseek') ? '24h' : undefined)
          // Responses already sends a key in short mode; Chat Completions does not.
          assert.equal(body.prompt_cache_key, id.startsWith('deepseek') || protocol === 'responses' ? 'synthetic-cache-session' : undefined)
        }
        toolMode = true
        const toolChunks = await collect(adapter.stream(makeOptions(ids[0])))
        const call = toolChunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')?.block
        assert.equal(call?.name, 'synthetic_tool')
        assert.deepEqual(JSON.parse(call.arguments), { ok: true })
        toolMode = false
        const held = await adapter.prepareCall('opendesign', ids[0])
        const beforeSwitch = wires.length
        identity = { runtimeKey: 'synthetic-other-key', accountKey: 'synthetic-account-b' }
        await assert.rejects(collect(held.stream(makeOptions(ids[0]))), error => ['AUTH_CHANGED', 'cancelled'].includes(error.code))
        assert.equal(wires.length, beforeSwitch, 'an old account must never send a request')
        await adapter.listModels('opendesign')
        const abort = new AbortController(); abort.abort()
        await assert.rejects(collect(adapter.stream({ ...makeOptions(ids[0]), signal: abort.signal })), error => ['cancelled', 'ABORTED'].includes(error.code))
        assert.equal(wires.length, beforeSwitch)
        disabled = [ids[1]]
        api.applyPreferences()
        assert.deepEqual((await adapter.listModels('opendesign')).map(m => m.id), [ids[0]])
        assert.deepEqual(disabled, [ids[1]], 'visibility preferences must remain unchanged')
        identity = undefined
        assert.deepEqual(await adapter.listModels('opendesign'), [])
      } finally { api.dispose() }
      assert.equal(routes.size, 0)
      console.log(JSON.stringify({ ...report, protocol, status: 'passed', checks: ['host-catalog-exports', 'signed-out', 'list', 'resolve', 'prepare', 'SSE-text', 'SSE-tool-call', 'cache-usage', 'DeepSeek-24h-wire-fields', 'other-model-unchanged', 'account-isolation', 'abort', 'visibility', 'dispose'] }))
    }
    // Also exercise the main catalog overlay against real PiAiAdapter / Models,
    // not a collection double. No settings or credential services are mounted.
    const { apply } = await import('../lib/index.js')
    const ids = ['opencode-go', 'opencode', 'openai-codex']
    const rawProviders = new Map()
    let profiles = new Map()
    const dispatched = []
    for (const id of ids) {
      const descriptor = { id: 'deepseek-synthetic', name: 'Synthetic model', provider: id,
        api: id === 'openai-codex' ? 'openai-codex-responses' : 'openai-completions',
        baseUrl: id === 'opencode-go' ? 'https://opencode.ai/zen/go/v1' : id === 'opencode' ? 'https://opencode.ai/zen/v1' : 'https://chatgpt.com/backend-api',
        contextWindow: 128000, maxTokens: 8192, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }
      const capture = async function* (_model, _context, options) { dispatched.push({ id, options }); yield { type: 'synthetic' } }
      const piProvider = { id, name: id, auth: { apiKey: { name: 'Synthetic fixture',
        resolve: async ({ credential }) => ({ auth: { apiKey: credential?.key }, source: 'synthetic-fixture' }),
      } }, getModels: () => [descriptor], stream: capture, streamSimple: capture }
      rawProviders.set(id, piProvider)
      profiles.set(id, { provider: id, displayName: id, piProvider, modelErrors: new Map(), configuredMaxTokens: new Map([[descriptor.id, 8192]]) })
    }
    const native = new host.PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => 'synthetic-key',
      auth: { authContext: { env: async () => undefined, fileExists: async () => false } },
    })
    const initial = native.current()
    const prototype = Object.getPrototypeOf(initial.models)
    const originalMethods = [prototype.stream, prototype.streamSimple, native.current]
    const originalInfo = native.providerInfo('opencode-go')
    const releases = []
    const previousProfileDir = process.env.DSH_PROFILE_DIR
    process.env.DSH_PROFILE_DIR = fixture
    const overlayCtx = {
      llm: { adapters: new Map(ids.map(id => [id, { adapter: native, provider: { id, name: id } }])) },
      get: ctx.get, on() {}, emit() {}, provide() {},
      logger: { info() {}, debug() {}, warn() {} },
      effect(fn) { const release = fn(); if (typeof release === 'function') releases.push(release) },
    }
    try {
      apply(overlayCtx)
      assert.notEqual(native.current, originalMethods[2])
      const snapshot = native.current()
      for (const id of ids) {
        assert.notEqual(snapshot.models.getProvider(id), rawProviders.get(id))
        assert.equal(snapshot.models.getModels(id)[0].id, 'deepseek-synthetic')
        await collectOverlay(snapshot.models.streamSimple(snapshot.models.getModels(id)[0], { messages: [] }, { apiKey: 'synthetic-key', sessionId: 'synthetic-overlay-session' }))
        const options = dispatched.at(-1).options
        assert.equal(options.cacheRetention, id === 'openai-codex' ? undefined : 'long')
        assert.equal(options.headers?.['x-opencode-session'], id === 'openai-codex' ? undefined : 'synthetic-overlay-session')
      }
      profiles = new Map(profiles)
      const next = native.current()
      assert.notEqual(next.models, snapshot.models, 'profile changes create a new real collection')
      for (const id of ids) assert.notEqual(next.models.getProvider(id), rawProviders.get(id))
    } finally {
      for (const release of releases.reverse()) release()
      if (previousProfileDir === undefined) delete process.env.DSH_PROFILE_DIR
      else process.env.DSH_PROFILE_DIR = previousProfileDir
      // Flush the mount's already queued restore/abort microtasks under the network tripwire.
      await new Promise(resolve => setImmediate(resolve))
    }
    assert.equal(native.current, originalMethods[2])
    // The existing label wrapper stores a bound original; compare behavior, not identity.
    assert.deepEqual(native.providerInfo('opencode-go'), originalInfo)
    assert.equal(Object.getOwnPropertySymbols(native.providerInfo).length, 0)
    assert.equal(prototype.stream, originalMethods[0])
    assert.equal(prototype.streamSimple, originalMethods[1])
    for (const id of ids) assert.equal(initial.models.getProvider(id), rawProviders.get(id))
    console.log(JSON.stringify({ ...report, status: 'passed', checks: ['main-overlay-real-Models', 'OpenCode-session-and-cache', 'Codex-unchanged', 'snapshot-rebuild', 'unload-restores-hooks'] }))
  }
} finally { globalThis.fetch = originalFetch }

async function collectOverlay(stream) {
  for await (const chunk of stream) {
    assert.notEqual(chunk.type, 'error', 'synthetic provider dispatch failed: ' + JSON.stringify(chunk))
  }
}
