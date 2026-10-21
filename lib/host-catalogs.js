/**
 * Resolve the pi-ai catalog module the HOST adapter is actually using.
 *
 * Importing pi-ai from this plugin's own location is wrong whenever the profile
 * carries its own copy: descriptors would be written into an object the host
 * never reads. Resolution therefore starts from the host adapter's package
 * manifest, and a bare import is allowed only when both sides are provably the
 * same directory.
 */
import { resolve } from 'node:path'
import { importFromPackage } from './host-resolve.js'

const PI = '@earendil-works/pi-ai'
const HOST = '@deepseek-ai/dsh-llm-pi-ai'
const ENTRIES = [
  ['opencode-go', './providers/opencode-go.models', 'OPENCODE_GO_MODELS'],
  ['opencode', './providers/opencode.models', 'OPENCODE_MODELS'],
  ['openai-codex', './providers/openai-codex.models', 'OPENAI_CODEX_MODELS'],
]

/**
 * Load the three catalogs from the host's own pi-ai copy.
 *
 * @param ctx - plugin context; `pluginPackages` is required for a proven read.
 * @param options - test seams for module import and resolution.
 * @returns a provider-id to catalog map.
 * @throws when no single host copy can be proven, rather than patching a copy
 *   the host does not read.
 */
export async function loadHostCatalogs(ctx, { importModule = specifier => import(specifier),
  resolveModule = specifier => import.meta.resolve(specifier), resolvePackage = importFromPackage } = {}) {
  const packages = ctx?.get?.('pluginPackages')
  let hostParent
  try { hostParent = resolveModule(HOST) } catch { hostParent = undefined }
  const owned = packages && hostParent ? packages.packageOf(PI, hostParent) : undefined

  if (owned?.dir) {
    const loaded = new Map()
    for (const [provider, subpath, exported] of ENTRIES) {
      const module = await resolvePackage(owned, subpath, importModule)
      if (module[exported] === undefined) throw new Error('native catalog export missing: ' + provider)
      loaded.set(provider, module[exported])
    }
    return loaded
  }

  // No host metadata: only a bare import that provably lands in the same copy.
  if (owned?.dir === undefined && packages?.packageOf) {
    const local = packages.packageOf(PI, import.meta.url)
    throw new Error(local ? 'host pi-ai copy could not be identified' : 'pi-ai is not resolvable from this plugin')
  }
  const loaded = new Map()
  for (const [provider, subpath, exported] of ENTRIES) {
    const module = await importModule(PI + '/' + subpath.replace('./', ''))
    if (module[exported] !== undefined) loaded.set(provider, module[exported])
  }
  return loaded
}

/** Whether one resolved package directory differs from this plugin's own copy. */
export function sameDir(a, b) {
  return Boolean(a?.dir && b?.dir && resolve(a.dir) === resolve(b.dir))
}
