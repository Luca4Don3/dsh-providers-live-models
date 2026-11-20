import { fetchJson } from '../http.js'
import { QuotaError } from '../errors.js'
import { normalizeOllamaCloud } from '../normalize.js'
import { displayScopeOf } from '../identity.js'

const ORIGIN = 'https://ollama.com'
const BALANCE_URL = ORIGIN + '/api/balance'

/**
 * Ollama Cloud adapter: one API key from ollama.com/settings/keys, read through
 * the host credential service like every other key-based provider.
 *
 * `/api/balance` allows 10 requests/minute per user across all keys and devices,
 * and the engine caches for `freshMs` (5 minutes by default), so ordinary use
 * stays far below the limit. A 429 is surfaced as `rate-limited` rather than
 * retried here.
 * @param {object} deps - credentials service, config, timeoutMs, fetchImpl.
 * @returns {object} the adapter.
 */
export function createOllamaAdapter({ credentials, refName = 'OLLAMA_API_KEY', timeoutMs = 15000, fetchImpl }) {
  const ref = refName.startsWith('!') ? refName.slice(1) : refName
  const readKey = async () => {
    const hit = await credentials?.resolve(ref)
    return typeof hit?.value === 'string' ? hit.value.trim() : ''
  }
  return {
    providerId: 'ollama',
    origin: ORIGIN,
    async isConfigured() { return (await readKey()) !== '' },
    async displayKey() { return displayScopeOf('ollama/key', await readKey()) },
    async resolveAuth() {
      const key = await readKey()
      if (key === '') throw new QuotaError('auth-required', `credential reference ${ref} is not configured`)
      // An API key carries no account identity, so two keys cannot be proven to be
      // the same account; the display scope alone keeps their caches apart.
      return { authorization: 'Bearer ' + key, accountKey: undefined }
    },
    async fetchUsage(auth, { signal } = {}) {
      return fetchJson(BALANCE_URL, { headers: { accept: 'application/json', authorization: auth.authorization },
        origin: ORIGIN, timeoutMs, signal, fetchImpl })
    },
    normalize(payload, { capturedAt }) { return normalizeOllamaCloud(payload, { capturedAt }) }
  }
}