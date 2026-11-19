import { fetchJson } from '../http.js'
import { QuotaError } from '../errors.js'
import { normalizeOpenCodeGo } from '../normalize.js'
import { displayScopeOf } from '../identity.js'

const ORIGIN = 'https://opencode.ai'
const USAGE_URL = ORIGIN + '/zen/go/v1/usage'
const GO_STATUS_URL = ORIGIN + '/console/api/go/status'

/**
 * OpenCode Go adapter: API-key reference resolved through the host public
 * credentials service; no OAuth involved.
 * @param {object} deps - credentials service, config, timeoutMs, fetchImpl.
 * @returns {object} the adapter.
 */
export function createOpenCodeGoAdapter({ credentials, consoleAuth, refName = 'OPENCODE_GO_API_KEY', timeoutMs = 15000, fetchImpl }) {
  /**
   * The plan a Go key belongs to. Only the Console session answers this: the
   * inference key is refused (HTTP 403) on every Console route, so a machine
   * that never signed in shows the limits without a plan name rather than a
   * guessed one. Any failure here is silent for the same reason — the usage
   * numbers are the reason this adapter exists.
   * @returns {Promise<string|undefined>} the Console product id (`go`, `go-plus`, `go-teams`).
   */
  async function planOf(signal) {
    if (!await consoleAuth?.isConfigured()) return undefined
    try {
      const auth = await consoleAuth.resolveAuth({ signal })
      if (!auth) return undefined
      const body = await fetchJson(GO_STATUS_URL, { headers: { accept: 'application/json', authorization: auth.authorization,
        ...(auth.orgId ? { 'x-org-id': auth.orgId } : {}) }, origin: ORIGIN, timeoutMs, signal, fetchImpl })
      // TEAM plans report `product` as the member's own, `renewalProduct` as the
      // workspace's; the current one is what the limits below were measured against.
      const product = body?.product
      return typeof product === 'string' && product !== '' ? product : undefined
    } catch { return undefined }
  }
  return {
    providerId: 'opencode-go',
    origin: ORIGIN,
    async isConfigured() {
      const hit = await credentials?.resolve(refName.startsWith('!') ? refName.slice(1) : refName)
      return typeof hit?.value === 'string' && hit.value.trim() !== ''
    },
    async displayKey() {
      const hit = await credentials?.resolve(refName.startsWith('!') ? refName.slice(1) : refName)
      return displayScopeOf('opencode-go/key', hit?.value)
    },
    async resolveAuth() {
      const hit = await credentials?.resolve(refName.startsWith('!') ? refName.slice(1) : refName)
      if (!hit || typeof hit.value !== 'string' || hit.value === '') {
        throw new QuotaError('auth-required', `credential reference ${refName} is not configured`)
      }
      return { authorization: 'Bearer ' + hit.value, accountKey: undefined }
    },
    async fetchUsage(auth, { signal } = {}) {
      const usage = await fetchJson(USAGE_URL, { headers: { accept: 'application/json', authorization: auth.authorization }, origin: ORIGIN, timeoutMs, signal, fetchImpl })
      const plan = await planOf(signal)
      // The vendor body plus one extra key, so normalize() keeps reading a body.
      return { ...usage, ...(plan === undefined ? {} : { plan }) }
    },
    normalize(result, { capturedAt }) {
      return normalizeOpenCodeGo(result, { capturedAt })
    },
  }
}
