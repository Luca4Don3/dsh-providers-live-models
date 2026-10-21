/** Local, same-origin OpenDesign controls. No response contains credential values. */
const PREFIX = '/dsh-providers-live-models/opendesign'
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

function send(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

export function validateOpenDesignRequest(req) {
  try {
    const host = req.headers?.host
    if (typeof host !== 'string' || host !== host.trim()) return false
    const base = new URL('http://' + host)
    if (!LOOPBACK.has(base.hostname) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) return false
    const target = new URL(req.url ?? '/', base)
    if (target.origin !== base.origin) return false
    const origin = req.headers.origin
    if (origin !== undefined && (typeof origin !== 'string' || origin !== base.origin)) return false
    const site = req.headers['sec-fetch-site']
    if (site !== undefined && site !== 'same-origin' && site !== 'none') return false
    if ((req.method ?? 'GET').toUpperCase() === 'POST'
      && !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) return false
    return true
  } catch { return false }
}

async function readBody(req) {
  const parts = []
  let size = 0
  for await (const chunk of req) {
    const part = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    size += part.length
    if (size > 16384) throw new Error('invalid-input')
    parts.push(part)
  }
  const text = Buffer.concat(parts).toString('utf8').trim()
  const value = text ? JSON.parse(text) : {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-input')
  return value
}

function safeLogin(login) {
  if (!login || typeof login.status !== 'string') return null
  const result = { status: login.status }
  if (typeof login.userCode === 'string') result.userCode = login.userCode.slice(0, 80)
  if (Number.isFinite(login.expiresAt)) result.expiresAt = login.expiresAt
  if (typeof login.detail === 'string') result.detail = login.detail.slice(0, 240)
  try {
    const url = new URL(login.openUrl)
    if (url.origin === 'https://open-design.ai' && url.pathname === '/cloud/cli/activate' && !url.username && !url.password) result.openUrl = url.href
  } catch { /* No authorization URL until the device request succeeds. */ }
  return result
}

async function safeStatus(auth, getProvider) {
  const status = await auth.status()
  const provider = getProvider?.()
  const rawModels = provider?.status?.()
  const models = rawModels ? {
    providerId: 'opendesign',
    protocol: rawModels.protocol === 'responses' ? 'responses' : 'chat-completions',
    stripTemperature: rawModels.stripTemperature === true,
    available: rawModels.available !== false, configured: rawModels.configured === true, loading: rawModels.loading === true,
    modelCount: Number.isSafeInteger(rawModels.modelCount) && rawModels.modelCount >= 0 ? rawModels.modelCount : 0,
    savedAt: Number.isFinite(rawModels.savedAt) ? rawModels.savedAt : null, stale: rawModels.stale === true,
    rejectedModelCount: Array.isArray(rawModels.diagnostics) ? rawModels.diagnostics.filter(item => item?.reason).length : 0,
    state: rawModels.loading ? 'loading' : rawModels.error ? 'error' : rawModels.available === false ? 'unavailable' : rawModels.configured ? 'ready' : 'idle',
    ...(rawModels.error ? { error: 'catalog-unavailable', message: 'OpenDesign 模型目录读取失败，请重试；原有提供方保持不变。' } : {}),
  } : { state: 'unavailable', message: 'OpenDesign 模型适配器尚未就绪' }
  return {
    loggedIn: status?.loggedIn === true,
    mode: status?.mode === 'api-key' || status?.mode === 'account' ? status.mode : null,
    usageAvailable: status?.loggedIn === true && status?.mode === 'account',
    login: safeLogin(status?.login ?? auth.loginWatch?.()),
    models,
  }
}

/** Returns false only when this is not an OpenDesign route. */
export async function handleOpenDesignHttp(ctx, req, res, { auth, getProvider, preferences, getRoutes } = {}) {
  const rawPath = (req.url ?? '').split('?')[0].replace(/\/+$/, '')
  if (rawPath !== PREFIX && !rawPath.startsWith(PREFIX + '/')) return false
  if (!validateOpenDesignRequest(req)) { send(res, 403, { error: 'origin-refused' }); return true }
  if (!auth) { send(res, 503, { error: 'unavailable' }); return true }
  const method = (req.method ?? 'GET').toUpperCase()
  try {
    if (method === 'GET' && rawPath === PREFIX + '/status') {
      send(res, 200, await safeStatus(auth, getProvider)); return true
    }
    if (method === 'GET' && rawPath === PREFIX + '/routes') {
      // One catalog for every provider this plugin manages. Overlaid routes come
      // from the main plugin; OpenDesign contributes its own group, so the page
      // renders one switch list instead of a per-provider variant.
      const overlaid = typeof getRoutes === 'function' ? getRoutes() : []
      const routes = Array.isArray(overlaid) ? overlaid.slice(0, 8).map(route => ({
        id: String(route.id), label: String(route.label), group: 'opencode',
        models: (Array.isArray(route.models) ? route.models : []).slice(0, 400).map(model => ({
          id: String(model.id), name: String(model.name),
          ...(Number.isFinite(model.contextWindow) ? { contextWindow: model.contextWindow } : {}),
          enabled: model.enabled !== false,
        })),
      })) : []
      const provider = getProvider?.()
      const openDesignModels = typeof provider?.models === 'function' ? provider.models() : []
      if (openDesignModels.length > 0) {
        const disabled = new Set(preferences?.snapshot?.().disabledModels ?? [])
        // `diagnostics` carries one entry per accepted model too, so counting its
        // length reported every model as rejected. Only entries with a `reason`
        // were actually dropped from the roster.
        const rejected = (typeof provider?.status === 'function' ? provider.status() : undefined)?.diagnostics
          ?.filter(item => typeof item?.reason === 'string' && item.reason.length > 0).length ?? 0
        routes.push({ id: 'opendesign', label: 'OpenDesign', group: 'opendesign',
          ...(rejected > 0 ? { note: rejected + ' 条目录条目缺少必要参数，未加入列表' } : {}),
          models: openDesignModels.slice(0, 400).map(model => ({ id: String(model.id), name: String(model.name),
            ...(Number.isFinite(model.contextWindow) ? { contextWindow: model.contextWindow } : {}),
            enabled: !disabled.has(String(model.id)) })) })
      }
      send(res, 200, { routes })
      return true
    }
    if (method === 'GET' && rawPath === PREFIX + '/models') {
      const provider = getProvider?.()
      if (!provider) { send(res, 200, { models: [], status: { state: 'unavailable', message: 'OpenDesign 模型适配器尚未就绪' } }); return true }
      const status = await safeStatus(auth, getProvider)
      const models = typeof provider.models === 'function' ? provider.models() : []
      const disabled = new Set(preferences?.snapshot?.().disabledModels ?? [])
      send(res, 200, { status: status.models, models: models.slice(0, 200).map(model => ({
        id: String(model.id), name: String(model.name), contextWindow: model.contextWindow,
        // The local request budget, named so it cannot read as a vendor output cap.
        outputTokenBudget: model.maxTokens, enabled: !disabled.has(String(model.id)),
        reasoningLevels: Array.isArray(model.reasoningLevels) ? model.reasoningLevels : [],
        input: Array.isArray(model.input) ? model.input.filter(value => value === 'text' || value === 'image') : [],
      })) })
      return true
    }
    if (method !== 'POST') { send(res, 404, { error: 'not-found' }); return true }
    const body = await readBody(req)
    if (rawPath === PREFIX + '/login') {
      const login = await auth.startLogin({ openBrowser: false })
      send(res, login?.status === 'error' ? 502 : 200, await safeStatus(auth, getProvider)); return true
    }
    if (rawPath === PREFIX + '/cancel') {
      auth.cancelLogin()
      send(res, 200, await safeStatus(auth, getProvider)); return true
    }
    if (rawPath === PREFIX + '/key') {
      if (typeof body.apiKey !== 'string' || !body.apiKey.trim() || body.apiKey.length > 4096) {
        send(res, 400, { error: 'invalid-input' }); return true
      }
      await auth.saveApiKey(body.apiKey)
      send(res, 200, await safeStatus(auth, getProvider)); return true
    }
    if (rawPath === PREFIX + '/logout') {
      if (typeof auth.logout !== 'function') { send(res, 503, { error: 'unsupported' }); return true }
      await auth.logout()
      send(res, 200, await safeStatus(auth, getProvider)); return true
    }
    if (rawPath === PREFIX + '/routes/enabled') {
      if (!preferences) { send(res, 503, { error: 'unavailable' }); return true }
      const provider = typeof body.provider === 'string' ? body.provider : ''
      const ids = body.enabledModels
      // OpenDesign is part of the same catalog now; its ids come from the adapter
      // rather than the overlaid-route list.
      const known = provider === 'opendesign'
        ? new Set((getProvider?.()?.models?.() ?? []).map(model => String(model.id)))
        : new Set((typeof getRoutes === 'function' ? getRoutes() : [])
          .find(route => route.id === provider)?.models?.map(model => model.id) ?? [])
      if (provider === '' || known.size === 0) { send(res, 400, { error: 'unknown-provider' }); return true }
      if (!Array.isArray(ids) || ids.length > 400 || ids.some(id => typeof id !== 'string' || id.length === 0 || id.length > 256)
        || ids.some(id => !known.has(id))) { send(res, 400, { error: 'unknown-model' }); return true }
      try {
        if (provider === 'opendesign') await preferences.setDisabledModels([...known].filter(id => !ids.includes(id)))
        else await preferences.setDisabledFor(provider, [...known].filter(id => !ids.includes(id)))
      } catch { send(res, 500, { error: 'storage-unavailable' }); return true }
      getProvider?.()?.applyPreferences?.()
      send(res, 200, { ok: true })
      return true
    }
    if (rawPath === PREFIX + '/models/enabled') {
      if (!preferences) { send(res, 503, { error: 'unavailable' }); return true }
      const ids = body.enabledModels
      if (!Array.isArray(ids) || ids.length > 500 || ids.some(id => typeof id !== 'string' || id.length === 0 || id.length > 256)) {
        send(res, 400, { error: 'invalid-input' }); return true
      }
      const known = new Set((getProvider?.()?.models?.() ?? []).map(model => String(model.id)))
      // Refuse to persist ids the current roster does not carry: they would silently
      // accumulate and start filtering once a model reappears.
      if (ids.some(id => !known.has(id))) { send(res, 400, { error: 'unknown-model' }); return true }
      const disabled = [...known].filter(id => !ids.includes(id))
      try { await preferences.setDisabledModels(disabled) }
      catch { send(res, 500, { error: 'storage-unavailable' }); return true }
      getProvider?.()?.applyPreferences?.()
      send(res, 200, await safeStatus(auth, getProvider)); return true
    }
    if (rawPath === PREFIX + '/models/refresh') {
      const provider = getProvider?.()
      if (!provider) { send(res, 503, { error: 'provider-unavailable' }); return true }
      await provider.refresh({ force: true })
      send(res, 200, await safeStatus(auth, getProvider)); return true
    }
    send(res, 404, { error: 'not-found' })
  } catch (error) {
    // Never serialize a remote response body, submitted key, request headers or stack.
    const code = typeof error?.code === 'string' ? error.code : 'invalid-input'
    const known = new Set(['auth-required', 'unsupported', 'timeout', 'network', 'invalid-response', 'origin-refused', 'rate-limited', 'upstream'])
    send(res, code === 'auth-required' ? 401 : known.has(code) ? 502 : 400, { error: known.has(code) ? code : 'invalid-input' })
  }
  return true
}
