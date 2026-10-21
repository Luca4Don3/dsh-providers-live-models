#!/usr/bin/env node
/**
 * Read-only detector for the pi-ai duplication hazard.
 *
 * The plugin repairs native model descriptors by importing pi-ai from its own
 * location. When a profile carries a hoisted pi-ai copy, that import lands on a
 * different object than the host adapter reads, and models absent from the
 * host's built-in catalog stay unresolvable. This script reports what the
 * profile resolves; it changes nothing and never reads credentials.
 *
 * The host lives inside app.asar, which plain Node cannot read. Pass its pi-ai
 * version explicitly:
 *   node scripts/check-pi-ai-duplication.mjs <profile-dir> [host-pi-ai-version]
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const PI = '@earendil-works/pi-ai'

function version(dir) {
  try { return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version } catch { return undefined }
}
function resolveFrom(base) {
  let dir = base
  for (;;) {
    const candidate = join(dir, 'node_modules', PI)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    const parent = resolve(dir, '..')
    if (parent === dir) return undefined
    dir = parent
  }
}
function copies(root) {
  const found = []
  const queue = [[root, 0]]
  while (queue.length) {
    const [dir, depth] = queue.shift()
    if (depth > 6) continue
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '.git') continue
      const child = join(dir, entry.name)
      const owned = join(child, PI)
      if (existsSync(join(owned, 'package.json'))) found.push(owned)
      if (entry.name === 'node_modules' || entry.name === '.pnpm' || depth < 2) queue.push([child, depth + 1])
    }
  }
  return found
}

const profile = process.argv[2] ?? process.env.DSH_PROFILE_DIR
if (profile === undefined) {
  console.error('usage: node scripts/check-pi-ai-duplication.mjs <profile-dir> [host-pi-ai-version]')
  process.exit(2)
}
const hostVersion = process.argv[3]
const profilePi = resolveFrom(resolve(profile))
const nested = copies(resolve(profile))
const report = {
  profile: resolve(profile),
  profilePiAi: profilePi === undefined ? null : { dir: profilePi, version: version(profilePi) },
  otherCopies: nested.filter(dir => dir !== profilePi).map(dir => ({ dir, version: version(dir) })),
  hostPiAiVersion: hostVersion ?? null,
}
const present = profilePi !== undefined || report.otherCopies.length > 0
if (!present) {
  report.risk = false
  report.verdict = 'OK: the profile carries no pi-ai copy, so the plugin resolves the host one'
} else if (hostVersion === undefined) {
  report.risk = 'unknown'
  report.verdict = 'PRESENT: the profile carries a pi-ai copy; pass the host pi-ai version to compare'
} else {
  const versions = [report.profilePiAi?.version, ...report.otherCopies.map(entry => entry.version)].filter(Boolean)
  const differs = versions.some(value => value !== hostVersion)
  report.risk = differs
  report.verdict = differs
    ? 'SPLIT: a profile copy differs from the host pi-ai; native catalog repair can land on the wrong object'
    : 'OK: every profile copy matches the host pi-ai version'
}
console.log(JSON.stringify(report, null, 2))
process.exit(report.risk === true ? 1 : 0)
