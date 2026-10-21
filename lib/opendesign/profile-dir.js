/**
 * Locate the profile directory that owns this installed plugin.
 *
 * The package lives at <profile>/node_modules/dsh-providers-live-models, so the
 * profile is the directory that CONTAINS the node_modules we sit inside — not the
 * package directory itself. Treating the package as the profile wrote preferences
 * into node_modules, where a reinstall discards them.
 *
 * A linked install (no node_modules ancestor) falls back to the nearest ancestor
 * that declares a profile manifest.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const isProfileRoot = dir => {
  if (existsSync(join(dir, 'cordis.patch.yml'))) return true
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    return manifest?.dsh?.profile !== undefined
  } catch { return false }
}

export function findProfileDir(from = import.meta.url) {
  let dir
  try { dir = dirname(realpathSync(fileURLToPath(from))) }
  catch { dir = dirname(fileURLToPath(from)) }

  // Walk up to the node_modules we live inside; its parent owns this install.
  let cursor = dir
  for (let depth = 0; depth < 8; depth += 1) {
    if (basename(cursor) === 'node_modules') {
      const owner = resolve(cursor, '..')
      return isProfileRoot(owner) ? owner : undefined
    }
    const parent = resolve(cursor, '..')
    if (parent === cursor) break
    cursor = parent
  }

  // Linked install: the nearest ancestor that looks like a profile wins.
  cursor = dir
  for (let depth = 0; depth < 6; depth += 1) {
    if (isProfileRoot(cursor)) return cursor
    const parent = resolve(cursor, '..')
    if (parent === cursor) break
    cursor = parent
  }
  return undefined
}
