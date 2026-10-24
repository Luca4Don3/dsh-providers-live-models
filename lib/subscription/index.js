/**
 * dsh-providers-live-models — read-only subscription quota monitoring for the
 * providers OpenAI Codex, OpenCode Go and OpenCode Zen balances.
 *
 * Design boundaries:
 * - Existing quota reads are passive; OpenDesign registers only its own route.
 * - Existing OpenAI, OpenCode and third-party registrations are never replaced.
 * - Credentials come only from the host public services (ctx.credentials) and
 *   are sent only to each provider's official origin.
 * - Codex refresh delegates to host Pi-AI; optional OpenCode Console login uses
 *   its documented device flow and the same host credential store.
 * - Every in-flight quota request is cancelled when this plugin's fiber is
 *   disposed (disable, unload, HMR reload), satisfying the gate's cancellation
 *   requirement.
 * - The quota engine caches only verified account identities. The account UI
 *   uses separate, stable credential scopes to retain display snapshots.
 *
 * @module dsh-providers-live-models
 */
import { createQuotaEngine } from './engine.js'
import { createCodexAdapter } from './providers/codex.js'
import { createOpenCodeGoAdapter } from './providers/opencode-go.js'
import { createOpenRouterAdapter } from './providers/openrouter.js'
import { createCommandCodeAdapter } from './providers/commandcode.js'
import { createOpenCodeZenAdapter } from './providers/opencode-zen.js'
import { createLoginController } from './login.js'
import { makeCodexRefresh } from './refresh.js'
import { handleLoginHttp } from './login-http.js'
import { createOpenCodeConsoleAuth } from './opencode-auth.js'
import { createOpenDesignAuth } from '../opendesign/auth.js'
import { createOpenDesignQuotaAdapter } from '../opendesign/quota.js'
import { createVelaQuotaSource } from '../opendesign/vela.js'
import { createOpenDesignPreferences } from '../opendesign/preferences.js'
import { findProfileDir } from '../opendesign/profile-dir.js'
import { createOpenDesignProvider } from '../opendesign/provider.js'

export const name = 'subscription-usage'
export const inject = ['credentials']

export async function apply(ctx, config = {}) {
  const { freshMs = 300000, timeoutMs = 15000, goApiKeyRef = 'OPENCODE_GO_API_KEY', zenApiKeyRef = 'OPENCODE_API_KEY' } = config
  if (!Number.isFinite(freshMs) || freshMs < 1000 || !Number.isFinite(timeoutMs) || timeoutMs < 1000) {
    throw new TypeError('freshMs and timeoutMs must be numbers >= 1000')
  }
  if (typeof goApiKeyRef !== 'string' || goApiKeyRef.trim() === '') throw new TypeError('goApiKeyRef must be a non-empty string')
  if (typeof zenApiKeyRef !== 'string' || zenApiKeyRef.trim() === '') throw new TypeError('zenApiKeyRef must be a non-empty string')
  const abort = new AbortController()
  const login = createLoginController()
  const credentials = ctx.get('credentials')
  const consoleAuth = createOpenCodeConsoleAuth({ credentials, timeoutMs })
  let openDesignProvider, engine
  // Per-model preferences live beside this profile, never in the credential store.
  // The package itself is installed under <profile>/node_modules, so walking up
  // from this module is the one path that is always right; the environment is a
  // fallback for a linked or nested install.
  const profileDir = findProfileDir() ?? process.env.DSH_PROFILE_DIR
  const preferencesFile = typeof profileDir === 'string' && profileDir.length > 0
    ? profileDir + '/.dsh-opencode-live-models/opendesign.json' : undefined
  if (preferencesFile === undefined) ctx.logger.warn('subscription-usage: no profile directory; OpenDesign model preferences will not persist')
  // Reuse the instance the main plugin already publishes: one store, one file, so
  // a write here is immediately what the model filter reads.
  const sharedPreferences = ctx.get?.('opencodeModelPreferences')
  const openDesignPreferences = sharedPreferences ?? createOpenDesignPreferences({ file: preferencesFile })
  if (sharedPreferences === undefined) void openDesignPreferences.load()
  const openDesignAuth = createOpenDesignAuth({ credentials, timeoutMs, onChange() {
    engine?.invalidate('opendesign')
    openDesignProvider?.invalidate()
    if (openDesignProvider) void openDesignProvider.refresh({ force: true }).catch(() => {
      ctx.logger.warn('subscription-usage: OpenDesign model refresh failed; existing providers are unchanged')
    })
    ctx.emit?.('llm/adapters-updated')
  } })
  // All OpenDesign state is owned by this fiber, never by the other providers.
  ctx.effect(() => () => {
    abort.abort(); login.cancelLogin('plugin disposed'); consoleAuth.cancelLogin()
    openDesignAuth.cancelLogin(); openDesignProvider?.dispose()
  }, 'subscription-usage.cancel-in-flight')
  if (config.openDesign?.enabled !== false && typeof ctx.get('llm')?.registerAdapter === 'function') {
    void createOpenDesignProvider(ctx, { auth: openDesignAuth, timeoutMs,
      protocol: config.openDesign?.protocol ?? 'chat-completions',
      outputTokenBudget: config.openDesign?.outputTokenBudget ?? 8192,
      stripTemperature: config.openDesign?.stripTemperature === true,
      modelOverrides: config.openDesign?.modelOverrides,
      preferences: openDesignPreferences,
    }).then(provider => {
      if (abort.signal.aborted) { provider.dispose(); return }
      openDesignProvider = provider
      // A preference change rebuilds the offered set and republishes the route.
      const release = openDesignPreferences.subscribe(() => provider.applyPreferences())
      ctx.effect(() => release, 'subscription-usage.opendesign-preferences')
    }).catch(() => {
      if (!abort.signal.aborted) ctx.logger.warn('subscription-usage: OpenDesign model adapter unavailable; existing providers are unchanged')
    })
  }
  if (credentials === undefined) {
    ctx.logger.warn('subscription-usage: no credentials service; quota queries will report auth-required')
  }
  const refresh = await makeCodexRefresh(credentials)
  if (abort.signal.aborted) return
  const adapters = {
    'openai-codex': createCodexAdapter({ credentials, refresh, timeoutMs }),
    'opencode-go': createOpenCodeGoAdapter({ credentials, refName: goApiKeyRef, timeoutMs }),
    'opencode': createOpenCodeZenAdapter({ credentials, consoleAuth, refName: zenApiKeyRef, timeoutMs }),
    // OpenRouter bills a key against its own cap; Command Code bills a plan. Neither
    // has a device sign-in, so a key is the whole credential for both.
    openrouter: createOpenRouterAdapter({ credentials, refName: config.openRouter?.apiKeyRef ?? 'OPENROUTER_API_KEY', timeoutMs }),
    commandcode: createCommandCodeAdapter({ credentials, refName: config.commandCode?.apiKeyRef ?? 'COMMANDCODE_API_KEY', timeoutMs }),
    opendesign: createOpenDesignQuotaAdapter({ auth: openDesignAuth, timeoutMs,
      quotaSource: config.openDesign?.quotaSource ?? 'auto',
      vela: createVelaQuotaSource({ workspaceId: config.openDesign?.workspaceId }) }),
  }
  engine = createQuotaEngine({ adapters, freshMs, abort })
  ctx.provide('subscriptionUsage', {
    providers: Object.keys(adapters),
    freshMs,
    configured: async () => (await Promise.all(Object.entries(adapters).map(async ([providerId, adapter]) => {
      if (!await adapter.isConfigured()) return undefined
      return {
        providerId,
        label: { 'openai-codex': 'OpenAI订阅', 'opencode-go': 'OpenCode Go', opencode: 'OpenCode Zen', opendesign: 'OpenDesign' }[providerId],
        cacheKey: await adapter.displayKey(),
        ...(adapter.kind === 'balance' ? { kind: 'balance' } : {}),
      }
    }))).filter(Boolean).slice(0, 4),
    query: (providerId, opts) => engine.query(providerId, { ...opts, signal: opts?.signal ?? abort.signal }),
    invalidate: (providerId) => engine.invalidate(providerId),
  })

  // Plugin-page login API: mounted only when the host webServer exists
  // (ctx.inject waits for the service; headless profiles simply never run it).
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (httpCtx) => {
      httpCtx.effect(() => httpCtx.webServer.register({
        kind: 'prefix',
        path: '/dsh-providers-live-models',
        handler: (req, res) => { void handleLoginHttp(ctx, req, res, { login, consoleAuth, openDesignAuth,
          getOpenDesignProvider: () => openDesignProvider, openDesignPreferences,
          getRoutes: () => ctx.get?.('opencodeModelCatalog')?.routes?.() ?? [] }) },
      }), 'subscription-usage: login http')
    })
  }
}
