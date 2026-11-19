import { fetchJson, requestSignal } from '../http.js'
import { QuotaError, classifyHttp } from '../errors.js'
import { normalizeCodex, normalizeResetCredits } from '../normalize.js'
import { accountKeyOf, displayScopeOf } from '../identity.js'

const ORIGIN = 'https://chatgpt.com'
const USAGE_URL = ORIGIN + '/backend-api/wham/usage'
const RESETS_URL = ORIGIN + '/backend-api/wham/rate-limit-reset-credits'
const CONSUME_URL = RESETS_URL + '/consume'
const RECORD = 'llm-pi-ai/openai-codex'
const MIN_VALIDITY_MS = 5 * 60 * 1000

/**
 * Codex adapter: native Pi-AI OAuth credential, official Codex CLI endpoints.
 * Token refresh delegates to the host Pi-AI (injected), never reimplemented.
 * @param {object} deps - credentials service, optional refresh from Pi-AI, timeoutMs, fetchImpl.
 * @returns {object} the adapter.
 */
export function createCodexAdapter({ credentials, refresh, timeoutMs = 15000, fetchImpl }) {
  async function resolveAuth({ signal } = {}) {
    const record = await credentials?.readRecord(RECORD)
    const grant = record?.kind === 'grant' ? record.payload : undefined
    if (!grant || grant.type !== 'oauth' || typeof grant.access !== 'string' || typeof grant.expires !== 'number') {
      throw new QuotaError('auth-required', 'no native openai-codex OAuth credential')
    }
    let live = grant
    if (live.expires - Date.now() < MIN_VALIDITY_MS) {
      if (!refresh) throw new QuotaError('auth-required', 'credential expired and Pi-AI refresh is unavailable')
      live = await refresh({ signal })
      if (!live || typeof live.access !== 'string') throw new QuotaError('auth-required', 'Pi-AI refresh produced no credential')
    }
    return { authorization: 'Bearer ' + live.access, accountId: live.accountId, ...accountKeyOf(live.accountId) }
  }

  return {
    providerId: 'openai-codex',
    origin: ORIGIN,
    async isConfigured() {
      return (await credentials?.describeRecord(RECORD))?.configured === true
    },
    async displayKey() {
      const record = await credentials?.readRecord?.(RECORD)
      const grant = record?.kind === 'grant' ? record.payload : undefined
      if (grant?.type !== 'oauth') return undefined
      return displayScopeOf('openai-codex/account', grant.accountId)
        ?? displayScopeOf('openai-codex/grant', grant.refresh)
        ?? displayScopeOf('openai-codex/grant', grant.access)
    },
    resolveAuth,
    async fetchUsage(auth, { signal } = {}) {
      const headers = { accept: 'application/json', authorization: auth.authorization }
      if (auth.accountId) headers['chatgpt-account-id'] = auth.accountId
      const usage = await fetchJson(USAGE_URL, { headers, origin: ORIGIN, timeoutMs, signal, fetchImpl })
      let resetCredits
      try {
        resetCredits = normalizeResetCredits(await fetchJson(RESETS_URL, {
          headers,
          origin: ORIGIN, timeoutMs, signal, fetchImpl,
        }))
      } catch (error) {
        // The usage snapshot is primary; reset-credit detail is best effort.
        if (!(error instanceof QuotaError)) throw error
        resetCredits = { available: 0, options: [], unavailable: error.code }
      }
      return { usage, resetCredits }
    },
    normalize(result, { accountId, capturedAt }) {
      return normalizeCodex(result.usage, { httpStatus: 200, accountId, resetCredits: result.resetCredits, capturedAt })
    },
    /**
     * Redeem one reset ticket. This is the only write the plugin ever makes
     * against a vendor API, so it takes the ticket id explicitly: there is no
     * server-side "use whichever is available" shortcut to fall into.
     *
     * The caller supplies `requestId`, and a retry must reuse it. ChatGPT dedupes
     * on it, so a lost response can be retried without spending a second ticket.
     * @param {string} creditId - the ticket to consume, from the snapshot's options.
     * @param {string} requestId - idempotency id chosen before the first attempt.
     * @returns {Promise<{code: string, windowsReset: number}>} the server's outcome.
     */
    async consumeReset(creditId, requestId, { signal } = {}) {
      if (typeof creditId !== 'string' || creditId === '') throw new QuotaError('invalid-input', 'a reset ticket must be selected')
      if (typeof requestId !== 'string' || requestId === '') throw new QuotaError('invalid-input', 'a redeem request id is required')
      const auth = await resolveAuth({ signal })
      const headers = { accept: 'application/json', 'content-type': 'application/json', authorization: auth.authorization }
      if (auth.accountId) headers['chatgpt-account-id'] = auth.accountId
      const parsed = new URL(CONSUME_URL)
      // The same origin rule as every quota read: a credential never leaves chatgpt.com.
      if (parsed.origin !== ORIGIN) throw new QuotaError('origin-refused', 'refusing to send credentials to ' + parsed.origin)
      const held = requestSignal(signal, timeoutMs)
      try {
        let response
        try {
          response = await (fetchImpl ?? globalThis.fetch)(CONSUME_URL, { method: 'POST', headers, redirect: 'error',
            body: JSON.stringify({ redeem_request_id: requestId, credit_id: creditId }), signal: held.signal })
        } catch { throw new QuotaError(held.signal.aborted ? 'timeout' : 'network', 'reset request did not complete') }
        const text = await response.text()
        if (!response.ok) throw new QuotaError(classifyHttp(response.status, text), 'reset endpoint returned ' + response.status)
        let body
        try { body = JSON.parse(text) } catch { throw new QuotaError('invalid-response', 'reset endpoint returned a non-JSON body') }
        const codes = ['reset', 'nothing_to_reset', 'no_credit', 'already_redeemed']
        if (!codes.includes(body?.code)) throw new QuotaError('invalid-response', 'reset endpoint returned an unknown outcome')
        const windowsReset = typeof body.windows_reset === 'number' && Number.isSafeInteger(body.windows_reset) && body.windows_reset >= 0
          ? body.windows_reset : 0
        return { code: body.code, windowsReset }
      } finally { held.release() }
    },
  }
}
