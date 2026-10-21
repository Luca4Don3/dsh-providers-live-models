/**
 * Persisted per-model preferences: which models the user wants offered, and any
 * reasoning levels learned from a probe. Stores no credential, only ids.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const EMPTY = { disabledModels: [], reasoning: {}, providers: {} }

const isStringArray = value => Array.isArray(value) && value.every(entry => typeof entry === 'string')

/** Keep only the shapes this module understands; anything else is discarded. */
function sanitize(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ...EMPTY, providers: {} }
  const disabledModels = isStringArray(raw.disabledModels) ? [...new Set(raw.disabledModels)] : []
  const reasoning = {}
  if (raw.reasoning !== null && typeof raw.reasoning === 'object' && !Array.isArray(raw.reasoning)) {
    for (const [id, levels] of Object.entries(raw.reasoning)) {
      if (isStringArray(levels) && levels.length > 0) reasoning[id] = [...new Set(levels)]
    }
  }
  // Per-route selections for the routes this plugin overlays (opencode-go,
  // opencode, openai-codex). They share this file but never mix with the
  // OpenDesign entry above.
  const providers = {}
  if (raw.providers !== null && typeof raw.providers === 'object' && !Array.isArray(raw.providers)) {
    for (const [provider, entry] of Object.entries(raw.providers)) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
      if (!isStringArray(entry.disabledModels)) continue
      providers[provider] = { disabledModels: [...new Set(entry.disabledModels)] }
    }
  }
  return { disabledModels, reasoning, providers }
}

export function createOpenDesignPreferences({ file, fs = { readFile, writeFile, rename, mkdir } } = {}) {
  let value = { ...EMPTY }
  let writing = Promise.resolve()
  const listeners = new Set()

  /** Whether the last load found a readable file, for the diagnostic surface. */
  let loaded = false
  async function load() {
    if (typeof file !== 'string' || file.length === 0) { loaded = false; return }
    try { value = sanitize(JSON.parse(await fs.readFile(file, 'utf8'))); loaded = true }
    catch { value = { ...EMPTY }; loaded = false }
  }

  /**
   * Write the file, or report why it could not be written. A silent no-op here is
   * what let a missing path look like a successful save: the switches returned to
   * their old state after a restart with nothing in the log.
   */
  function persist() {
    if (typeof file !== 'string' || file.length === 0) {
      return Promise.reject(new Error('OpenDesign preferences have no storage path'))
    }
    const target = file
    const next = JSON.stringify(value, null, 2) + '\n'
    writing = writing.catch(() => {}).then(async () => {
      await fs.mkdir(dirname(target), { recursive: true })
      const temporary = target + '.tmp'
      await fs.writeFile(temporary, next, { mode: 0o600 })
      await fs.rename(temporary, target)
    })
    return writing
  }

  return {
    load,
    snapshot() {
      return { disabledModels: [...value.disabledModels], reasoning: { ...value.reasoning },
        providers: Object.fromEntries(Object.entries(value.providers).map(([id, entry]) => [id, { disabledModels: [...entry.disabledModels] }])) }
    },
    /** Disabled ids for one overlaid route (opencode-go, opencode, openai-codex). */
    disabledFor(provider) {
      const entry = value.providers[provider]
      return entry === undefined ? [] : [...entry.disabledModels]
    },
    /** Replace one route's disabled set; other routes are untouched. */
    async setDisabledFor(provider, ids) {
      if (typeof provider !== 'string' || provider.length === 0) throw new Error('a provider id is required')
      const providers = { ...value.providers }
      providers[provider] = { disabledModels: [...new Set(isStringArray(ids) ? ids : [])] }
      value = { ...value, providers }
      await persist()
      for (const listener of listeners) { try { listener(this.snapshot()) } catch { /* listener owns its failure */ } }
    },
    /** Drop ids one route no longer carries, leaving other routes alone. */
    async pruneProvider(provider, knownIds) {
      if (!Array.isArray(knownIds) || typeof provider !== 'string') return false
      const entry = value.providers[provider]
      if (entry === undefined) return false
      const known = new Set(knownIds.filter(id => typeof id === 'string'))
      const next = entry.disabledModels.filter(id => known.has(id))
      if (next.length === entry.disabledModels.length) return false
      const providers = { ...value.providers, [provider]: { disabledModels: next } }
      value = { ...value, providers }
      await persist()
      for (const listener of listeners) { try { listener(this.snapshot()) } catch { /* listener owns its failure */ } }
      return true
    },
    /** Replace the disabled set; an unknown id is harmless and ignored later. */
    async setDisabledModels(ids) {
      value = { ...value, disabledModels: [...new Set(isStringArray(ids) ? ids : [])] }
      await persist()
      for (const listener of listeners) { try { listener(this.snapshot()) } catch { /* listener owns its failure */ } }
    },
    /**
     * Drop entries whose id the current roster no longer carries.
     *
     * Runs once after the roster loads: a renamed or retired model would otherwise
     * linger in the disabled list forever, and a stale entry would silently hide a
     * model that later reappears under the same id. Only removal is applied, so a
     * transiently incomplete roster can never re-enable something the user turned
     * off.
     *
     * @param knownIds - ids present in the freshly loaded catalog.
     * @returns whether anything was removed.
     */
    async prune(knownIds) {
      if (!Array.isArray(knownIds)) return false
      const known = new Set(knownIds.filter(id => typeof id === 'string'))
      const disabled = value.disabledModels.filter(id => known.has(id))
      const reasoning = Object.fromEntries(Object.entries(value.reasoning).filter(([id]) => known.has(id)))
      const changed = disabled.length !== value.disabledModels.length
        || Object.keys(reasoning).length !== Object.keys(value.reasoning).length
      if (!changed) return false
      value = { ...value, disabledModels: disabled, reasoning }
      await persist()
      for (const listener of listeners) { try { listener(this.snapshot()) } catch { /* listener owns its failure */ } }
      return true
    },
    /** The path this store writes to, for diagnostics. */
    get file() { return file },
    /** Whether a saved selection was found on disk at load time. */
    get loaded() { return loaded },
    async setReasoning(id, levels) {
      const reasoning = { ...value.reasoning }
      if (isStringArray(levels) && levels.length > 0) reasoning[id] = [...new Set(levels)]
      else delete reasoning[id]
      value = { ...value, reasoning }
      await persist()
      for (const listener of listeners) { try { listener(this.snapshot()) } catch { /* as above */ } }
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
  }
}
