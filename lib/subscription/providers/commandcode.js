import { fetchJson } from '../http.js'
import { QuotaError } from '../errors.js'
import { normalizeCommandCode } from '../normalize.js'
import { displayScopeOf } from '../identity.js'

const ORIGIN = 'https://api.commandcode.ai'
const CREDITS_URL = ORIGIN + '/alpha/billing/credits'
const SUBS_URL = ORIGIN + '/alpha/billing/subscriptions'
/** `billing/subscriptions` has been seen to take 15-20s, so its answer is held
 * far longer than the credits one and never blocks a refresh on its own. */
const PLAN_TTL_MS = 10 * 60 * 1000

/**
 * Command Code adapter: an API key from Studio (or the CLI's own auth.json,
 * offered as a one-click fill by the page). Credits carry the plan's windows;
 * the plan's name comes from the subscription endpoint, cached separately
 * because that call is the slow one.
 * @param {object} deps - credentials service, config, timeoutMs, fetchImpl.
 * @returns {object} the adapter.
 */
export function createCommandCodeAdapter({ credentials, refName = 'COMMANDCODE_API_KEY', timeoutMs = 20000, fetchImpl, now = Date.now }) {
  const ref = refName.startsWith('!') ? refName.slice(1) : refName
  let planCache // { accountKey, planId, planName, renews, periodEnd, at }
  const readKey = async () => {
    const hit = await credentials?.resolve(ref)
    return typeof hit?.value === 'string' ? hit.value.trim() : ''
  }
  const headersOf = authorization => ({ accept: 'application/json', authorization })
  async function readPlan(authorization, accountKey, signal) {
    if (planCache?.accountKey === accountKey && now() - planCache.at < PLAN_TTL_MS) return planCache
    try {
      const body = await fetchJson(SUBS_URL, { headers: headersOf(authorization), origin: ORIGIN, timeoutMs, signal, fetchImpl })
      const data = body?.data
      const plan = { planId: typeof data?.planId === 'string' ? data.planId : '',
        status: typeof data?.status === 'string' ? data.status : '',
        periodEnd: data?.currentPeriodEnd, cancelAtEnd: data?.cancelAtPeriodEnd === true }
      planCache = { accountKey, ...plan, at: now() }
      return planCache
    } catch { return planCache?.accountKey === accountKey ? planCache : null }
  }
  return {
    providerId: 'commandcode',
    // A plan reports windows and dollars together, like Codex, so it keeps the
    // subscription card rather than the balance one.
    origin: ORIGIN,
    async isConfigured() { return (await readKey()) !== '' },
    async displayKey() { return displayScopeOf('commandcode/key', await readKey()) },
    async resolveAuth() {
      const key = await readKey()
      if (key === '') throw new QuotaError('auth-required', `credential reference ${ref} is not configured`)
      return { authorization: 'Bearer ' + key, accountKey: 'commandcode:' + displayScopeOf('commandcode/key', key) }
    },
    async fetchUsage(auth, { signal } = {}) {
      const credits = await fetchJson(CREDITS_URL, { headers: headersOf(auth.authorization), origin: ORIGIN, timeoutMs, signal, fetchImpl })
      const plan = await readPlan(auth.authorization, auth.accountKey, signal)
      return { credits, plan }
    },
    normalize(payload, { capturedAt }) { return normalizeCommandCode(payload, { capturedAt }) },
  }
}
