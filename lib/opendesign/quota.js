import { QuotaError, classifyHttp } from '../subscription/errors.js'
import { CONTROL_ORIGIN, requestOpenDesignJson } from './auth.js'

const numberOf = value => {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()))) return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}
const text = value => typeof value === 'string' && value.trim() ? value.trim() : undefined
function when(value) {
  const t = typeof value === 'number' ? (value < 1e11 ? value * 1000 : value)
    : typeof value === 'string' && value.trim() ? Date.parse(value) : NaN
  return Number.isFinite(t) && Math.abs(t) <= 8640000000000000 ? new Date(t).toISOString() : undefined
}
function labelOf(seconds) {
  const n = seconds % 86400 === 0 ? seconds / 86400 : seconds / 3600
  const unit = seconds % 86400 === 0 ? 'day' : 'hour'
  return Number.isInteger(n) ? n + ' ' + unit + (n === 1 ? '' : 's') : Math.ceil(seconds / 60) + ' minutes'
}

/** Community-observed Design Plan fields; missing numbers remain unknown, never zero. */
export function normalizeOpenDesign(result, { capturedAt, accountKey } = {}) {
  const base = { providerId: 'opendesign', scope: 'subscription', capturedAt, ...(accountKey && { accountKey }) }
  if (result?.unsupported === true) return { ...base, status: 'unsupported', windows: [],
    detail: 'API Key 可调用模型，但套餐额度与余额需要 OpenDesign 账号授权' }
  const preflight = result?.preflight ?? {}
  const summary = result?.summary ?? {}
  const codingPlan = preflight.codingPlan ?? result?.usage ?? result?.codingPlan
    ?? (Array.isArray(preflight.windows) ? preflight : Array.isArray(result?.windows) ? result : undefined)
  const windows = (codingPlan?.eligible === false || !Array.isArray(codingPlan?.windows) ? [] : codingPlan.windows).flatMap((w, index) => {
    const used = numberOf(w?.usedCredits), limit = numberOf(w?.limitCredits), seconds = numberOf(w?.durationSeconds)
    if (used === undefined || used < 0 || limit === undefined || limit <= 0 || seconds === undefined || seconds <= 0) return []
    const ratio = used / limit * 100
    if (!Number.isFinite(ratio)) return []
    const usedPercent = Math.round(Math.max(0, Math.min(100, ratio)) * 10) / 10
    const resetsAt = when(w.resetsAt)
    return [{ id: 'window-' + seconds + '-' + index, label: labelOf(seconds), usedPercent,
      remainingPercent: Math.round((100 - usedPercent) * 10) / 10, windowMinutes: Math.ceil(seconds / 60),
      ...(resetsAt && { resetsAt }) }]
  }).sort((a, b) => a.windowMinutes - b.windowMinutes)
  const tier = text(summary.membershipTier) ?? text(codingPlan?.tier) ?? text(result?.workspace?.personalMembershipTier)
  const safeTier = tier && /^[a-z][a-z0-9_-]{0,31}$/i.test(tier) && !/^(sk-amr-|vela_ctrl_)/i.test(tier) ? tier : undefined
  const balance = numberOf(preflight.balanceUsd) ?? numberOf(summary.balanceUsd) ?? numberOf(summary.totalAvailableCreditsUsd)
  const warnings = []
  if (result?.summaryUnavailable) warnings.push('套餐补充接口暂不可用；已保留主接口读取的额度，缺失信息保持未知')
  if (balance === undefined) warnings.push('钱包余额未知')
  if (!safeTier) warnings.push('套餐名称未知')
  if (!windows.length && codingPlan?.eligible !== false) warnings.push('未取得有效的套餐额度窗口')
  const until = when(summary.subscriptionCurrentPeriodEnd)
  const renew = typeof summary.subscriptionCancelAtPeriodEnd === 'boolean' && text(summary.subscriptionStatus)
    ? summary.subscriptionCancelAtPeriodEnd ? 'off' : 'auto' : undefined
  return { ...base, status: windows.length ? windows.some(w => w.usedPercent >= 100) ? 'exhausted' : 'ready' : 'unknown', windows,
    ...(safeTier && { plan: 'Design Plan ' + safeTier[0].toUpperCase() + safeTier.slice(1) }),
    ...(balance === undefined ? {} : { balance: { amount: balance, currency: 'USD' } }),
    ...(until && { until }), ...(renew && { renew }),
    ...(warnings.length && { warnings, warning: warnings.join('；') }),
    ...(codingPlan?.eligible === false && { detail: '此账号没有 Design Plan 套餐额度，请求可能使用钱包余额' }) }
}

/** Only the control key can reach the fixed control origin; API-key mode sends no quota requests. */
export function createOpenDesignQuotaAdapter({ auth, fetchImpl, timeoutMs = 15000, vela, quotaSource = 'auto' } = {}) {
  // 'vela' reuses the desktop app's login, so it needs no credential of ours.
  const useVela = quotaSource !== 'control' && vela?.available === true
  const get = async (path, key, signal) => {
    const result = await requestOpenDesignJson(path, { key, signal, timeoutMs, fetchImpl })
    if (result.status < 200 || result.status >= 300) {
      throw new QuotaError(classifyHttp(result.status), 'OpenDesign 额度接口暂不可用，请稍后重试或重新登录')
    }
    return result.body
  }
  return {
    providerId: 'opendesign', origin: CONTROL_ORIGIN,
    source: useVela ? 'vela' : 'control',
    async isConfigured() {
      if (useVela) return true
      return await auth?.isConfigured?.() === true
    },
    async displayKey() {
      if (useVela) return 'vela:' + String(vela.via ?? 'unknown')
      return auth?.displayKey?.()
    },
    async resolveAuth(options) {
      if (useVela) return { mode: 'vela', accountKey: 'vela:' + String(vela.via ?? 'unknown') }
      if (!auth?.resolveAuth) throw new QuotaError('auth-required', '请先登录 OpenDesign')
      return auth.resolveAuth(options)
    },
    async fetchUsage(resolved, { signal } = {}) {
      if (signal?.aborted) throw new QuotaError('timeout', 'OpenDesign 额度请求已取消')
      if (resolved?.mode === 'vela' || useVela) return vela.read({ signal })
      if (resolved?.mode === 'api-key') return { unsupported: true }
      if (resolved?.mode !== 'account' || typeof resolved.controlKey !== 'string' || !resolved.controlKey.startsWith('vela_ctrl_')) {
        throw new QuotaError('auth-required', '读取 OpenDesign 套餐额度需要账号授权或本机 OpenDesign 桌面端登录')
      }
      const key = resolved.controlKey
      const workspace = await get('/api/v1/workspaces/current', key, signal)
      const id = text(workspace.activeWorkspaceId) ?? text(workspace.workspaceId)
      if (!id || id.length > 512 || ['.', '..'].includes(id) || /[\u0000-\u0020\u007f]/.test(id)) {
        throw new QuotaError('invalid-response', 'OpenDesign 未返回有效工作区')
      }
      const preflight = await get('/api/v1/workspaces/' + encodeURIComponent(id) + '/billing/preflight', key, signal)
      let summary, summaryUnavailable
      try { summary = await get('/api/v1/billing/summary', key, signal) }
      catch (error) {
        if (!(error instanceof QuotaError) || signal?.aborted) throw error
        // Summary permissions differ from preflight: even 401/403 cannot erase verified windows.
        summaryUnavailable = true
      }
      return { workspace, preflight, summary, ...(summaryUnavailable && { summaryUnavailable }) }
    },
    normalize: normalizeOpenDesign,
  }
}
