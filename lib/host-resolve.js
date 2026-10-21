/**
 * Resolve a package subpath from its own manifest, without a module loader hook.
 *
 * The host's `pluginPackages.packageOf()` already returns the parsed manifest of
 * the copy the host itself uses. Reading `exports` from it gives the same file a
 * loader would pick, while keeping this plugin out of the boot module graph: the
 * shared resolver lives in `@deepseek-ai/dsh-app-boot`, and importing the launcher
 * from a profile plugin is exactly what must not happen during startup.
 */
import { existsSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const inside = (path, dir) => resolve(path).startsWith(resolve(dir) + sep)

function targetOf(value) {
  if (typeof value === 'string') return value
  if (value === null || typeof value !== 'object') return undefined
  if (typeof value.import === 'string') return value.import
  if (typeof value.default === 'string') return value.default
  return Object.values(value).find(entry => typeof entry === 'string')
}

/** Read one export target from a manifest's `exports` map, patterns included. */
export function exportTarget(manifest, subpath) {
  const exports = manifest?.exports
  if (exports === undefined) return subpath === '.' ? manifest?.main : undefined
  if (typeof exports === 'string') return subpath === '.' ? exports : undefined
  if (exports === null || typeof exports !== 'object') return undefined
  if (Object.hasOwn(exports, subpath)) return targetOf(exports[subpath])
  for (const [key, value] of Object.entries(exports)) {
    const star = key.indexOf('*')
    if (star < 0) continue
    const prefix = key.slice(0, star), suffix = key.slice(star + 1)
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue
    if (subpath.length < prefix.length + suffix.length) continue
    const middle = subpath.slice(prefix.length, subpath.length - suffix.length)
    const target = targetOf(value)
    if (typeof target === 'string') return target.replace('*', middle)
  }
  return undefined
}

/**
 * Absolute path of one subpath inside a resolved package.
 * @returns the file path, or undefined when the manifest does not offer it.
 */
export function resolveFromPackage(pkg, subpath) {
  if (!pkg?.dir || !pkg.manifest) return undefined
  const target = exportTarget(pkg.manifest, subpath)
  if (typeof target !== 'string' || target.length === 0) return undefined
  const path = join(pkg.dir, target)
  return inside(path, pkg.dir) && existsSync(path) ? path : undefined
}

/** Import one subpath of an already-resolved package. */
export async function importFromPackage(pkg, subpath, importModule = specifier => import(specifier)) {
  const path = resolveFromPackage(pkg, subpath)
  if (path === undefined) throw new Error('package subpath not resolvable: ' + (pkg?.name ?? '?') + subpath)
  return importModule(pathToFileURL(path).href)
}
