import { createHash } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { QuotaError, classifyHttp } from '../subscription/errors.js'
import { systemOpen } from '../subscription/login.js'

// Historic record id: renaming it would invalidate existing OpenDesign sign-ins.
export const OPENDESIGN_RECORD = 'dsh-opencode-live-models/opendesign'
export const CONTROL_ORIGIN = 'https://amr-api.open-design.ai'
export const MODEL_ORIGIN = 'https://amr-link.open-design.ai'
const ACTIVATE_ORIGIN = 'https://open-design.ai'
const DEVICE_PATH = '/api/v1/cli/device-authorizations'
const MAX_BODY_BYTES = 128 * 1024
const MAX_LOGIN_MS = 15 * 60 * 1000
const clean = v => typeof v === 'string' ? v.trim() : ''
const keyOf = (v, prefix) => typeof v === 'string' && v.length <= 8192 && v.startsWith(prefix)
  && v.length > prefix.length && /^[!-~]+$/.test(v)
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex')
const cancelled = () => new QuotaError('timeout', 'OpenDesign 请求已取消或超时')

function check(signal) { if (signal?.aborted) throw cancelled() }
function abortable(task, signal) {
  check(signal)
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(cancelled()) }
    const cleanup = () => signal?.removeEventListener('abort', abort)
    signal?.addEventListener('abort', abort, { once: true })
    Promise.resolve(task).then(v => { cleanup(); resolve(v) }, e => { cleanup(); reject(e) })
    if (signal?.aborted) abort()
  })
}

/** Bounded, redirect-free control-plane transport. Never accepts another origin or exposes remote errors. */
export async function requestOpenDesignJson(path, { key, body, method = 'GET', signal,
  timeoutMs = 15000, fetchImpl = globalThis.fetch } = {}) {
  check(signal)
  let url
  try { url = new URL(path, CONTROL_ORIGIN) } catch { throw new QuotaError('origin-refused', 'OpenDesign 请求地址不受信任') }
  if (url.origin !== CONTROL_ORIGIN || url.username || url.password || !url.pathname.startsWith('/api/v1/')
    || !['GET', 'POST'].includes(method) || (key !== undefined && !keyOf(key, 'vela_ctrl_'))) {
    throw new QuotaError('origin-refused', 'OpenDesign 控制面凭据或请求地址不受信任')
  }
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  const timer = setTimeout(abort, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15000)
  try {
    return await abortable((async () => {
      const headers = { accept: 'application/json' }
      if (key) headers.authorization = 'Bearer ' + key
      if (body !== undefined) headers['content-type'] = 'application/json'
      let response
      try {
        response = await fetchImpl(url.href, { method, headers, redirect: 'error', signal: controller.signal,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      } catch { throw new QuotaError('network', 'OpenDesign 请求未完成，请稍后重试') }
      check(controller.signal)
      if (response.redirected || (response.url && (() => {
        try { const target = new URL(response.url); return target.origin !== CONTROL_ORIGIN || !!target.username || !!target.password }
        catch { return true }
      })())) throw new QuotaError('origin-refused', 'OpenDesign 拒绝重定向响应')
      if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
        throw new QuotaError('invalid-response', 'OpenDesign 返回了无效响应')
      }
      // Do not parse error bodies: they can echo authorization headers and device secrets.
      if (response.status < 200 || response.status >= 300) {
        void response.body?.cancel?.().catch(() => {})
        return { status: response.status, body: undefined }
      }
      const declared = response.headers?.get?.('content-length')
      if (declared && Number(declared) > MAX_BODY_BYTES) {
        void response.body?.cancel?.().catch(() => {})
        throw new QuotaError('invalid-response', 'OpenDesign 响应超过大小限制')
      }
      const reader = response.body?.getReader?.()
      if (!reader) throw new QuotaError('invalid-response', 'OpenDesign 返回了无效响应')
      let bytes = 0
      const chunks = []
      const stopReading = () => { void reader.cancel().catch(() => {}) }
      controller.signal.addEventListener('abort', stopReading, { once: true })
      try {
        for (;;) {
          check(controller.signal)
          const part = await reader.read()
          if (part.done) break
          bytes += part.value.byteLength
          if (bytes > MAX_BODY_BYTES) {
            void reader.cancel().catch(() => {})
            throw new QuotaError('invalid-response', 'OpenDesign 响应超过大小限制')
          }
          chunks.push(Buffer.from(part.value))
        }
      } finally { controller.signal.removeEventListener('abort', stopReading); reader.releaseLock() }
      check(controller.signal)
      let parsed
      try { parsed = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')) }
      catch { throw new QuotaError('invalid-response', 'OpenDesign 返回了无效 JSON') }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new QuotaError('invalid-response', 'OpenDesign 返回了无效 JSON 对象')
      }
      return { status: response.status, body: parsed }
    })(), controller.signal)
  } catch (error) {
    if (controller.signal.aborted) throw cancelled()
    if (error instanceof QuotaError) throw error
    throw new QuotaError('network', 'OpenDesign 请求未完成，请稍后重试')
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}

function grantOf(record) {
  const p = record?.kind === 'grant' ? record.payload : undefined
  if (!p || !keyOf(p.access, 'sk-amr-')) return undefined
  if (p.type === 'api-key') return { type: 'api-key', access: p.access }
  if (p.type !== 'oauth' || !keyOf(p.control, 'vela_ctrl_')) return undefined
  return { type: 'oauth', access: p.access, control: p.control,
    ...(clean(p.uid) && { uid: clean(p.uid) }), ...(clean(p.email) && { email: clean(p.email) }) }
}
function scopeOf(grant) {
  return grant && hash(['opendesign', grant.type, grant.access, grant.control ?? ''])
}
function approvedGrant(body) {
  const payload = { type: 'oauth', access: body?.runtimeKey ?? body?.user?.runtimeKey,
    control: body?.controlKey ?? body?.user?.controlKey }
  const uid = clean(body?.user?.id) || clean(body?.user?.appUserId)
  const email = clean(body?.user?.email)
  if (uid && uid.length <= 512) payload.uid = uid
  if (email && email.length <= 512) payload.email = email
  const record = { kind: 'grant', payload }
  if (!grantOf(record)) throw new QuotaError('invalid-response', 'OpenDesign 授权响应缺少有效的双平面凭据')
  return record
}

/** Community-observed OpenDesign device protocol; not an official OAuth contract. */
export function createOpenDesignAuth({ credentials, fetchImpl = globalThis.fetch, timeoutMs = 15000,
  wait = (ms, signal) => sleep(ms, undefined, { signal }), now = Date.now, onChange } = {}) {
  let attempt, watch = null, generation = 0
  const read = async () => {
    try { return await credentials?.readRecord?.(OPENDESIGN_RECORD) }
    catch { throw new QuotaError('auth-required', 'OpenDesign 凭据暂不可读，请重新登录') }
  }
  const notify = () => { try { Promise.resolve(onChange?.()).catch(() => {}) } catch { /* notification cannot break storage */ } }
  const loginWatch = () => watch && { ...watch }
  const active = run => {
    check(run.controller.signal)
    if (attempt !== run || generation !== run.generation) throw cancelled()
  }
  function cancelLogin() {
    generation++
    if (attempt) {
      attempt.controller.abort()
      attempt = undefined
      watch = { status: 'cancelled' }
    }
    return loginWatch()
  }
  function fail(run, error) {
    if (attempt === run) {
      watch = { status: 'error', detail: error instanceof QuotaError && error.code === 'timeout'
        ? 'OpenDesign 登录已取消或超时，请重试' : 'OpenDesign 登录未能完成或授权已失效，请重试' }
      attempt = undefined
    }
  }
  async function poll(run, device, original) {
    const signal = run.controller.signal
    const deadline = setTimeout(() => run.controller.abort(), Math.max(1, device.expiresAt - now()))
    try {
      while (now() < device.expiresAt) {
        await abortable(wait(Math.min(device.intervalMs, device.expiresAt - now()), signal), signal)
        active(run)
        if (now() >= device.expiresAt) break
        let result
        try {
          result = await requestOpenDesignJson(DEVICE_PATH + '/' + encodeURIComponent(device.id) + '/token', {
            method: 'POST', body: { deviceSecret: device.secret }, signal, timeoutMs, fetchImpl })
        } catch (error) {
          active(run)
          if (error instanceof QuotaError && ['network', 'timeout'].includes(error.code)) continue
          throw error
        }
        active(run)
        if (now() >= device.expiresAt) break
        if (result.status === 401 || result.status === 403 || result.status === 404) {
          throw new QuotaError('auth-required', 'OpenDesign 设备授权已失效或被拒绝，请重新登录')
        }
        if (result.status < 200 || result.status >= 300) {
          throw new QuotaError(classifyHttp(result.status), 'OpenDesign 设备授权暂不可用，请重试')
        }
        const status = clean(result.body?.status).toLowerCase()
        if (['expired', 'canceled', 'cancelled', 'denied', 'rejected'].includes(status)) {
          throw new QuotaError('auth-required', 'OpenDesign 设备授权已过期或被拒绝，请重新登录')
        }
        if (status === 'pending') continue
        if (status && status !== 'approved') throw new QuotaError('invalid-response', 'OpenDesign 返回了未知授权状态')
        const record = approvedGrant(result.body)
        await credentials.modifyRecord(OPENDESIGN_RECORD, current => {
          active(run)
          if (hash(current ?? null) !== original) throw new QuotaError('auth-required', 'OpenDesign 凭据已变化，请重新登录')
          return record
        })
        active(run)
        watch = { status: 'ok' }
        attempt = undefined
        notify()
        return
      }
      throw new QuotaError('auth-required', 'OpenDesign 授权码已过期，请重新登录')
    } catch (error) { fail(run, error) }
    finally { clearTimeout(deadline) }
  }
  async function startLogin({ openBrowser = false, opener = systemOpen } = {}) {
    if (attempt) return attempt.start
    if (typeof credentials?.modifyRecord !== 'function') {
      watch = { status: 'error', detail: '宿主凭据服务不可写，无法保存 OpenDesign 登录' }
      return loginWatch()
    }
    const run = { controller: new AbortController(), generation: ++generation }
    attempt = run
    watch = { status: 'starting' }
    run.start = (async () => {
      try {
        const original = hash((await read()) ?? null)
        active(run)
        const result = await requestOpenDesignJson(DEVICE_PATH, { method: 'POST',
          body: { cliVersion: '0.1.4', host: 'dsh-providers-live-models', profile: 'prod' },
          signal: run.controller.signal, timeoutMs, fetchImpl })
        active(run)
        if (result.status < 200 || result.status >= 300) {
          throw new QuotaError(classifyHttp(result.status), 'OpenDesign 暂时无法启动设备登录，请重试')
        }
        const d = result.body
        let url
        try { url = new URL(d.activationUrl) } catch { throw new QuotaError('invalid-response', 'OpenDesign 授权链接无效') }
        const id = clean(d.deviceId), secret = clean(d.deviceSecret), userCode = clean(d.userCode)
        let decodedUrl
        try { decodedUrl = decodeURIComponent(url.href) } catch { throw new QuotaError('invalid-response', 'OpenDesign 授权链接无效') }
        if (url.origin !== ACTIVATE_ORIGIN || url.pathname !== '/cloud/cli/activate' || url.username || url.password || url.hash
          || !id || id.length > 512 || ['.', '..'].includes(id) || /[\u0000-\u0020\u007f]/.test(id)
          || !secret || secret.length > 8192 || /[\u0000-\u0020\u007f]/.test(secret)
          || decodedUrl.includes(secret) || userCode.includes(secret) || userCode.length > 64 || /[\u0000-\u001f\u007f]/.test(userCode)) {
          throw new QuotaError('invalid-response', 'OpenDesign 设备授权响应不完整或链接不受信任')
        }
        const parsedExpiry = typeof d.expiresAt === 'string' ? Date.parse(d.expiresAt) : NaN
        const expiresAt = Math.min(Number.isFinite(parsedExpiry) ? parsedExpiry : now() + 10 * 60 * 1000, now() + MAX_LOGIN_MS)
        if (expiresAt <= now()) throw new QuotaError('auth-required', 'OpenDesign 授权码已过期，请重新登录')
        const seconds = Number(d.pollIntervalSeconds)
        const intervalMs = Number.isFinite(seconds) && seconds > 0 ? Math.max(1000, seconds * 1000) : 2000
        watch = { status: 'waiting', openUrl: url.href, ...(userCode && { userCode }), expiresAt }
        if (openBrowser) {
          try { await opener(url.href) } catch { if (attempt === run) watch.detail = '浏览器未能自动打开，请点击授权链接' }
          active(run)
        }
        const started = loginWatch()
        run.poll = poll(run, { id, secret, expiresAt, intervalMs }, original)
        return started
      } catch (error) { fail(run, error); return loginWatch() }
    })()
    return run.start
  }
  async function saveApiKey(value) {
    cancelLogin()
    const version = generation
    const access = clean(value)
    if (!keyOf(access, 'sk-amr-')) throw new QuotaError('invalid-key', '请输入有效的 OpenDesign 模型 API Key（sk-amr-…），不能使用控制面密钥')
    if (typeof credentials?.modifyRecord !== 'function') throw new QuotaError('auth-required', '宿主凭据服务不可写，无法保存 OpenDesign API Key')
    try {
      await credentials.modifyRecord(OPENDESIGN_RECORD, () => {
        if (generation !== version) throw cancelled()
        return { kind: 'grant', payload: { type: 'api-key', access } }
      })
    } catch {
      if (generation !== version) throw cancelled()
      throw new QuotaError('auth-required', 'OpenDesign API Key 未能保存，请重试')
    }
    if (generation !== version) throw cancelled()
    watch = null
    notify()
    return { loggedIn: true, mode: 'api-key', login: null }
  }
  return {
    startLogin, loginWatch, cancelLogin, saveApiKey,
    async logout() {
      cancelLogin()
      if (typeof credentials?.deleteRecord !== 'function') throw new QuotaError('unsupported', '宿主不支持删除 OpenDesign 凭据')
      try { await credentials.deleteRecord(OPENDESIGN_RECORD) }
      catch { throw new QuotaError('auth-required', 'OpenDesign 凭据未能删除，请重试') }
      watch = null
      notify()
      return { loggedIn: false, login: null }
    },
    async status() {
      const grant = grantOf(await read())
      return { loggedIn: !!grant, ...(grant && { mode: grant.type === 'oauth' ? 'account' : 'api-key' }), login: loginWatch() }
    },
    async isConfigured() {
      try {
        if (credentials?.describeRecord && (await credentials.describeRecord(OPENDESIGN_RECORD))?.configured === false) return false
        return !!grantOf(await read())
      } catch { return false }
    },
    async displayKey() { const scope = scopeOf(grantOf(await read())); return scope && 'view_' + scope },
    async resolveAuth({ signal } = {}) {
      check(signal)
      const grant = grantOf(await read())
      check(signal)
      if (!grant) throw new QuotaError('auth-required', '请登录 OpenDesign 账号或保存模型 API Key')
      return { mode: grant.type === 'oauth' ? 'account' : 'api-key', runtimeKey: grant.access,
        ...(grant.type === 'oauth' && { controlKey: grant.control }), accountKey: 'acct_' + scopeOf(grant) }
    },
  }
}
