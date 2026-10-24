import { fetchJson } from '../http.js'
import { QuotaError } from '../errors.js'
import { normalizeOpenRouterKey } from '../normalize.js'
import { displayScopeOf } from '../identity.js'

const ORIGIN = 'https://openrouter.ai'
// The key endpoint, not /credits: the latter is documented for management keys
// only, so a normal inference key would get 401 there while this one answers.
const KEY_URL = ORIGIN + '/api/v1/key'

/**
 * OpenRouter adapter: an inference API key read through the host credential
 * service. OpenRouter has no device sign-in, so a key is the whole credential.
 * @param {object} deps - credentials service, config, timeoutMs, fetchImpl.
 * @returns {object} the adapter.
 */
export function createOpenRouterAdapter({ credentials, refName = 'OPENROUTER_API_KEY', timeoutMs = 15000, fetchImpl }) {
  const ref = refName.startsWith('!') ? refName.slice(1) : refName
  const readKey = async () => {
    const hit = await credentials?.resolve(ref)
    return typeof hit?.value === 'string' ? hit.value.trim() : ''
  }
  return {
    providerId: 'openrouter',
    // A key's spend cap is money, not a percentage allowance: render a balance card.
    kind: 'balance',
    origin: ORIGIN,
    async isConfigured() { return (await readKey()) !== '' },
    async displayKey() { return displayScopeOf('openrouter/key', await readKey()) },
    async resolveAuth() {
      const key = await readKey()
      if (key === '') throw new QuotaError('auth-required', `credential reference ${ref} is not configured`)
      // The key names the account: two keys on one account share a snapshot, and
      // a different account invalidates the cached one.
      return { authorization: 'Bearer ' + key, accountKey: 'openrouter:' + displayScopeOf('openrouter/key', key) }
    },
    async fetchUsage(auth, { signal } = {}) {
      return fetchJson(KEY_URL, { headers: { accept: 'application/json', authorization: auth.authorization }, origin: ORIGIN, timeoutMs, signal, fetchImpl })
    },
    normalize(payload, { capturedAt }) { return normalizeOpenRouterKey(payload, { capturedAt }) },
  }
}
