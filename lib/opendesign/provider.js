import { fileURLToPath } from 'node:url'
import { resolve, sep } from 'node:path'
import { importFromPackage } from '../host-resolve.js'
import { QuotaError, classifyHttp } from '../subscription/errors.js'
import { normalizeOpenDesignModels, openDesignApiFor, OPENDESIGN_PROVIDER as ID, OPENDESIGN_BASE_URL as BASE,
  OPENDESIGN_MODELS_URL as MODELS } from './models.js'

const HOST = '@deepseek-ai/dsh-llm-pi-ai'
const PI = '@earendil-works/pi-ai'
const PROTOCOLS = {
  'chat-completions': { module: PI + '/api/openai-completions.lazy', factory: 'openAICompletionsApi', path: '/chat/completions' },
  responses: { module: PI + '/api/openai-responses.lazy', factory: 'openAIResponsesApi', path: '/responses' },
}
const HOST_VERSION = '0.2.1-rc.2'
const PI_VERSION = '1.1.0'
const unavailable = () => new QuotaError('unsupported-host', 'OpenDesign requires the verified host pi-ai adapter and its own pi-ai 1.1.0 transport')
const sameDir = (a, b) => a?.dir && b?.dir && resolve(a.dir) === resolve(b.dir)
const inside = (path, dir) => resolve(path).startsWith(resolve(dir) + sep)

/** Resolve from the actual host importer, not the profile plugin's pi-ai peer. */
export async function loadOpenDesignHost(ctx, { importModule = specifier => import(specifier),
  resolveModule = specifier => import.meta.resolve(specifier), resolvePackage = importFromPackage,
  protocol = 'chat-completions' } = {}) {
  openDesignApiFor(protocol)
  const selected = PROTOCOLS[protocol]
  const packages = ctx.get?.('pluginPackages')
  if (typeof packages?.packageOf !== 'function') throw unavailable()
  const parent = resolveModule(HOST)
  const host = packages.packageOf(HOST, parent)
  if (host?.version !== HOST_VERSION || !inside(fileURLToPath(parent), host.dir)) throw unavailable()
  const installation = packages.resolution?.entries?.find(entry => entry.name === HOST && entry.scope === 'installation')
  if (packages.resolution && (!installation || resolve(installation.packageDir) !== resolve(host.dir))) throw unavailable()
  const pi = packages.packageOf(PI, parent)
  if (pi?.version !== PI_VERSION) throw unavailable()
  async function peer(specifier, packageName) {
    const owned = packages.packageOf(packageName, parent)
    if (!owned) throw unavailable()
    // Both sides already resolve to one copy, so a bare import is provably correct.
    if (sameDir(packages.packageOf(packageName, import.meta.url), owned)) return importModule(specifier)
    // Different copies: read the host package's own manifest and import that file
    // directly. No module-loader hook and no launcher import on the startup path.
    const raw = specifier.slice(packageName.length)
    try { return await resolvePackage(owned, raw === '' ? '.' : '.' + raw, importModule) }
    catch { throw unavailable() }
  }
  const [adapter, wire, llm] = await Promise.all([
    importModule(parent), peer(selected.module, PI), peer('@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-llm'),
  ])
  if (typeof adapter.PiAiAdapter !== 'function' || typeof wire[selected.factory] !== 'function'
    || typeof llm.LlmError !== 'function') throw unavailable()
  return { PiAiAdapter: adapter.PiAiAdapter, LlmError: llm.LlmError,
    protocolApi: wire[selected.factory](), protocol, hostVersion: host.version, piVersion: pi.version }
}

function combine(...signals) {
  const controller = new AbortController(), releases = []
  for (const signal of signals.filter(Boolean)) {
    const abort = () => controller.abort(signal.reason)
    if (signal.aborted) abort()
    else { signal.addEventListener('abort', abort, { once: true }); releases.push(() => signal.removeEventListener('abort', abort)) }
  }
  return { signal: controller.signal, release: () => releases.forEach(release => release()) }
}
function aborted() { return new QuotaError('cancelled', 'OpenDesign operation was cancelled') }
function race(promise, signal) {
  if (signal.aborted) return Promise.reject(aborted())
  return new Promise((resolve, reject) => {
    const abort = () => reject(aborted())
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
async function jsonBody(response, signal, maxBytes) {
  let text = ''
  const reader = response.body?.getReader?.()
  if (reader) {
    let bytes = 0
    const decoder = new TextDecoder()
    try {
      while (true) {
        const next = await race(reader.read(), signal)
        if (next.done) break
        bytes += next.value.byteLength
        if (bytes > maxBytes) throw new QuotaError('invalid-response', 'OpenDesign model roster exceeds the size limit')
        text += decoder.decode(next.value, { stream: true })
      }
      text += decoder.decode()
    } catch (error) { void reader.cancel().catch(() => {}); throw error }
    finally { reader.releaseLock() }
  } else text = await race(response.text(), signal)
  if (Buffer.byteLength(text) > maxBytes) throw new QuotaError('invalid-response', 'OpenDesign model roster exceeds the size limit')
  try { return JSON.parse(text) }
  catch { throw new QuotaError('invalid-response', 'OpenDesign model roster is not JSON') }
}

/**
 * A version-bound resolved-profile shim around the host's public PiAiAdapter.
 * No credential values, host Models prototypes, profiles or other routes are mutated.
 */
export async function createOpenDesignProvider(ctx, { auth, fetchImpl = globalThis.fetch, timeoutMs = 15000,
  freshMs = 300000, now = Date.now, loadHost = loadOpenDesignHost, modelOverrides = {}, outputTokenBudget = 8192, maxCatalogBytes = 2 * 1024 * 1024,
  streamIdleTimeoutMs = 300000, resolveAttachments, resolveImageAccess, protocol = 'chat-completions', stripTemperature = false,
  preferences } = {}) {
  openDesignApiFor(protocol)
  if (typeof auth?.resolveAuth !== 'function' || typeof fetchImpl !== 'function') throw new TypeError('OpenDesign requires auth and fetch')
  if (![timeoutMs, freshMs, streamIdleTimeoutMs, maxCatalogBytes, outputTokenBudget].every(value => Number.isSafeInteger(value) && value > 0)
    || timeoutMs > 2147483647 || streamIdleTimeoutMs > 2147483647) {
    throw new TypeError('OpenDesign bounds must be positive safe integers')
  }
  // Gate before registration. An unsupported installation cannot affect other adapters.
  const host = await loadHost(ctx, { protocol })
  // Reasoning levels may have been learned from a probe; they win over the table.
  const learnedReasoning = preferences?.snapshot?.().reasoning ?? {}
  if (host?.hostVersion !== HOST_VERSION || host.piVersion !== PI_VERSION || typeof host.PiAiAdapter !== 'function'
    || typeof host.LlmError !== 'function' || typeof host.protocolApi?.streamSimple !== 'function'
    || typeof host.protocolApi?.stream !== 'function' || host.protocol !== protocol) throw unavailable()
  const lifecycle = new AbortController()
  let accountAbort = new AbortController(), disposed = false, accountKey, epoch = 0, generation = 0
  let profiles = new Map(), loaded = false, savedAt = 0, pending, requestAbort, registration
  let diagnostics = [], lastError, modelCount = 0, catalog = [], descriptors = [], pruned = false
  const fail = (code, message) => new host.LlmError(message, code)
  const live = () => { if (disposed) throw aborted() }
  const publish = () => { if (registration && !disposed) registration.replace([ID]) }
  function clearAccount(next) {
    accountAbort.abort(); accountAbort = new AbortController()
    requestAbort?.abort(); accountKey = next; epoch += 1; generation += 1
    loaded = false; savedAt = 0; modelCount = 0; diagnostics = []; catalog = []; descriptors = []; profiles = buildProfiles([], epoch, next)
  }
  /** Re-derive the profile map after the enabled set changes, then republish. */
  function applyPreferences() {
    if (disposed || !loaded) return
    const offered = availableModels()
    profiles = buildProfiles(offered, epoch, accountKey)
    modelCount = offered.length
    publish()
  }
  async function currentAuth(signal) {
    live()
    let result
    try { result = await race(auth.resolveAuth({ signal }), signal) }
    catch (error) {
      if (error?.code === 'auth-required') { clearAccount(undefined); publish() }
      throw error
    }
    if (typeof result?.runtimeKey !== 'string' || !result.runtimeKey || /[\r\n]/.test(result.runtimeKey)
      || typeof result.accountKey !== 'string' || !result.accountKey) {
      clearAccount(undefined); publish()
      throw new QuotaError('auth-required', 'OpenDesign authentication is incomplete')
    }
    live()
    if (result.accountKey !== accountKey) { clearAccount(result.accountKey); publish() }
    return result
  }
  async function verify(boundEpoch, boundAccount, signal) {
    const result = await currentAuth(signal)
    if (boundEpoch !== epoch || boundAccount !== result.accountKey) throw fail('AUTH_CHANGED', 'OpenDesign account changed; prepare the request again')
    return result
  }
  /**
   * Drop `temperature` only when the deployment asks for it. Some models the
   * gateway fronts reject the field, while the shared transport forwards it
   * unconditionally; keeping the workaround here leaves other providers alone.
   */
  function withoutTemperature(body) {
    if (typeof body !== 'string') return body
    let parsed
    try { parsed = JSON.parse(body) } catch { return body }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.hasOwn(parsed, 'temperature')) return body
    const { temperature: _omitted, ...rest } = parsed
    return JSON.stringify(rest)
  }
  const wireFetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (url.href !== BASE + PROTOCOLS[protocol].path || url.username || url.password) {
      throw fail('ORIGIN_REFUSED', 'OpenDesign transport refused an unexpected endpoint')
    }
    const next = stripTemperature ? { ...init, body: withoutTemperature(init.body) } : init
    return fetchImpl(input, { ...next, redirect: 'error' })
  }
  /** Levels this model offers, learned overrides first, then the documented table. */
  function offeredLevels(model) {
    const learned = learnedReasoning[model.id]
    if (Array.isArray(learned) && learned.length > 0) return [...learned]
    return Array.isArray(model.thinkingLevels) ? [...model.thinkingLevels] : []
  }
  /** Rebuild the offered models from the full descriptors, honoring the disabled set. */
  function availableModels() {
    const disabled = new Set(preferences?.snapshot?.().disabledModels ?? [])
    return descriptors.filter(model => !disabled.has(model.id))
  }
  function buildProfiles(models, boundEpoch, boundAccount) {
    const transport = method => (model, context, options) => host.protocolApi[method](model, context, {
      ...options, fetch: wireFetch,
    })
    const piProvider = {
      id: ID, name: 'OpenDesign', baseUrl: BASE,
      auth: { apiKey: { name: 'OpenDesign', resolve: ({ credential }) => Promise.resolve({
        auth: credential?.key === undefined ? {} : { apiKey: credential.key }, source: 'OpenDesign',
      }) } },
      getModels: () => models, stream: transport('stream'), streamSimple: transport('streamSimple'),
    }
    return new Map([[ID, {
      provider: ID, displayName: 'OpenDesign', piProvider, modelErrors: new Map(),
      configuredMaxTokens: new Map(models.map(model => [model.id, model.maxTokens])),
      streamIdleTimeoutMs, maxRequestImageBytes: 20 * 1024 * 1024,
      requestImagePixelBudget: 2048 * 2048, requestImageMaxBytes: 1024 * 1024,
      boundEpoch, boundAccount,
    }]])
  }
  profiles = buildProfiles(Object.freeze([]), epoch, accountKey)
  const adapter = new host.PiAiAdapter({ profiles: () => profiles,
    resolveApiKey: async (_provider, profile) => {
      const held = combine(lifecycle.signal, accountAbort.signal)
      try { return (await verify(profile.boundEpoch, profile.boundAccount, held.signal)).runtimeKey }
      catch (error) { if (error?.code === 'auth-required') throw fail('MISSING_CREDENTIAL', 'OpenDesign authentication is required'); throw error }
      finally { held.release() }
    },
    auth: { authContext: { env: async () => undefined, fileExists: async () => false } },
    resolveAttachments: resolveAttachments ?? (() => ctx.get?.('attachments')),
    resolveImageAccess,
  })
  function status() {
    return { providerId: ID, protocol, stripTemperature, available: !disposed, configured: accountKey !== undefined,
      loading: !!pending, modelCount, savedAt: savedAt || null, stale: loaded && now() - savedAt >= freshMs,
      diagnostics: diagnostics.map(item => ({ ...item })), ...(lastError ? { error: { ...lastError } } : {}) }
  }
  async function refresh({ force = false, signal } = {}) {
    live()
    const authSignal = combine(lifecycle.signal, signal)
    let identity
    try { identity = await currentAuth(authSignal.signal) }
    finally { authSignal.release() }
    if (!force && loaded && now() - savedAt < freshMs) return status()
    if (!force && pending?.accountKey === identity.accountKey) return signal ? race(pending.promise, signal) : pending.promise
    requestAbort?.abort()
    const controller = new AbortController(); requestAbort = controller
    const held = combine(lifecycle.signal, accountAbort.signal, controller.signal, signal)
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs); timer.unref?.()
    const mine = ++generation, boundEpoch = epoch
    const task = (async () => {
      try {
        const response = await race(Promise.resolve().then(() => fetchImpl(MODELS, { method: 'GET', redirect: 'error', signal: held.signal,
          headers: { accept: 'application/json', authorization: 'Bearer ' + identity.runtimeKey } })), held.signal)
        if (!response.ok) throw new QuotaError(classifyHttp(response.status), 'OpenDesign model roster returned HTTP ' + response.status)
        const payload = await jsonBody(response, held.signal, maxCatalogBytes)
        const normalized = normalizeOpenDesignModels(payload, { overrides: modelOverrides, outputTokenBudget, protocol,
          learnedReasoning: preferences?.snapshot?.().reasoning ?? {} })
        await verify(boundEpoch, identity.accountKey, held.signal)
        live()
        if (held.signal.aborted || mine !== generation || epoch !== boundEpoch) throw aborted()
        diagnostics = normalized.diagnostics; savedAt = now(); loaded = true; lastError = undefined
        // Display copy only: ids, names and capacities; never a credential or headers.
        descriptors = normalized.models
        catalog = normalized.models.map(model => ({ id: model.id, name: model.name, contextWindow: model.contextWindow,
          maxTokens: model.maxTokens, input: [...(model.input ?? [])],
          reasoning: model.reasoning === true, reasoningLevels: Array.isArray(model.thinkingLevels) ? [...model.thinkingLevels] : [] }))
        // Once per roster load: forget ids this account no longer offers, so a
        // retired model cannot stay hidden if the id is reused later.
        if (!pruned) {
          pruned = true
          try { await preferences?.prune?.(catalog.map(model => model.id)) } catch { /* a failed prune must not break the roster */ }
        }
        profiles = buildProfiles(availableModels(), epoch, identity.accountKey)
        modelCount = profiles.get(ID).piProvider.getModels().length
        publish()
        return status()
      } catch (error) {
        const failure = timedOut ? new QuotaError('timeout', 'OpenDesign model roster request timed out')
          : held.signal.aborted ? aborted()
          : error instanceof QuotaError || error?.name === 'OpenDesignCatalogError' || error instanceof host.LlmError ? error
          : new QuotaError('network', 'OpenDesign model roster request failed')
        if (!disposed && mine === generation) {
          lastError = { code: failure.code, message: 'OpenDesign model roster could not be refreshed' }
          diagnostics = Array.isArray(failure.diagnostics) ? failure.diagnostics : diagnostics
          if (failure.code === 'auth-required') { clearAccount(undefined); publish() }
        }
        throw failure
      } finally {
        clearTimeout(timer); held.release()
        if (pending?.generation === mine) pending = undefined
      }
    })()
    pending = { accountKey: identity.accountKey, generation: mine, promise: task }
    return task
  }
  async function ensure(signal) {
    try { await refresh({ signal }) }
    catch (error) {
      if (!loaded || error?.code === 'auth-required' || signal?.aborted || disposed) throw error
      // Same-account last-known-good catalog remains usable; status reports the failed refresh.
    }
  }
  const wrapper = {
    providerInfo: provider => adapter.providerInfo(provider),
    providerRetryPolicy: provider => adapter.providerRetryPolicy(provider),
    imageRequestPricing: (...args) => adapter.imageRequestPricing?.(...args),
    imageRequestTarget: (...args) => adapter.imageRequestTarget(...args),
    async listModels(provider) {
      try { await ensure() }
      catch (error) { if (error?.code === 'auth-required') return []; throw error }
      return adapter.listModels(provider)
    },
    async resolveModel(provider, model, signal) { await ensure(signal); return adapter.resolveModel(provider, model, signal) },
    async prepareCall(provider, model, signal) {
      await ensure(signal)
      const boundEpoch = epoch, boundAccount = accountKey, boundSignal = accountAbort.signal
      const outputBudget = profiles.get(ID).configuredMaxTokens.get(model)
      const prepared = await adapter.prepareCall(provider, model, signal)
      return { model: prepared.model, stream: async function* (options) {
        const held = combine(lifecycle.signal, boundSignal, options.signal)
        try {
          await verify(boundEpoch, boundAccount, held.signal)
          if (options.provider !== provider || options.model !== model) {
            throw fail('INVALID_REQUEST', 'OpenDesign prepared call must preserve its provider and model')
          }
          if (options.maxTokens !== undefined && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0)) {
            throw fail('INVALID_REQUEST', 'OpenDesign maxTokens must be a positive safe integer')
          }
          yield* prepared.stream({ ...options, maxTokens: Math.min(options.maxTokens ?? outputBudget, outputBudget), signal: held.signal })
        }
        finally { held.release() }
      } }
    },
    async *stream(options) { const prepared = await wrapper.prepareCall(options.provider, options.model, options.signal); yield* prepared.stream(options) },
  }
  function invalidate() { live(); clearAccount(undefined); lastError = undefined; publish() }
  function dispose() {
    if (disposed) return
    disposed = true; generation += 1; lifecycle.abort(); accountAbort.abort(); requestAbort?.abort()
    registration?.(); pending = undefined
  }
  registration = ctx.llm.registerAdapter([ID], wrapper)
  ctx.effect(() => dispose, 'opendesign-provider.dispose')
  return { refresh, invalidate, status, applyPreferences,
    models: () => catalog.map(model => ({ ...model, input: [...model.input], reasoningLevels: [...model.reasoningLevels] })), dispose }
}
