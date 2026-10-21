import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadHostCatalogs } from '../lib/host-catalogs.js'
import { exportTarget, resolveFromPackage } from '../lib/host-resolve.js'

function fixture({ shared = false, hostKnown = true, exportMissing = false } = {}) {
  const parent = 'file:///host/adapter/lib/index.js'
  const imports = [], resolved = []
  const packages = {
    packageOf(name, importer) {
      if (name === '@deepseek-ai/dsh-llm-pi-ai') return { dir: '/host/adapter', version: '0.2.1-rc.2' }
      if (name === '@earendil-works/pi-ai') {
        if (!hostKnown) return undefined
        return { dir: importer === parent || shared ? '/host/pi' : '/profile/pi', version: '1.3.0',
          manifest: { exports: { './providers/*': { import: './dist/providers/*.js' } } } }
      }
    },
  }
  const resolvePackage = async (pkg, subpath, importModule) => {
    resolved.push({ dir: pkg.dir, subpath })
    return importModule('stub:' + subpath)
  }
  const importModule = async specifier => {
    imports.push(specifier)
    return { OPENCODE_GO_MODELS: { g: 1 }, OPENCODE_MODELS: { z: 1 },
      ...(exportMissing ? {} : { OPENAI_CODEX_MODELS: { c: 1 } }) }
  }
  return { ctx: { get: () => packages }, options: { importModule, resolveModule: () => parent, resolvePackage }, imports, resolved }
}

test('host catalogs are read from the host copy, never the profile one', async () => {
  const f = fixture()
  const catalogs = await loadHostCatalogs(f.ctx, f.options)
  assert.deepEqual([...catalogs.keys()], ['opencode-go', 'opencode', 'openai-codex'])
  assert.ok(f.resolved.every(entry => entry.dir === '/host/pi'))
  assert.equal(f.imports.some(value => value.startsWith('@earendil-works/pi-ai/')), false, 'no bare pi-ai import')
})

test('a missing host copy fails instead of patching something else', async () => {
  const f = fixture({ hostKnown: false })
  await assert.rejects(loadHostCatalogs(f.ctx, f.options), /could not be identified|not resolvable/)
})

test('an identical copy is still read through the manifest, not by guessing', async () => {
  const f = fixture({ shared: true })
  const catalogs = await loadHostCatalogs(f.ctx, f.options)
  assert.equal(catalogs.size, 3)
  assert.ok(f.resolved.every(entry => entry.dir === '/host/pi'))
})

test('a missing export fails instead of leaving a partial map', async () => {
  const f = fixture({ exportMissing: true })
  await assert.rejects(loadHostCatalogs(f.ctx, f.options), /export missing/)
})

test('manifest export patterns resolve to files inside the package', () => {
  const manifest = { exports: { '.': { import: './dist/index.js' }, './api/*': { import: './dist/api/*.js' } } }
  assert.equal(exportTarget(manifest, '.'), './dist/index.js')
  assert.equal(exportTarget(manifest, './api/openai-completions.lazy'), './dist/api/openai-completions.lazy.js')
  assert.equal(exportTarget(manifest, './missing'), undefined)
  assert.equal(exportTarget({ main: 'lib/index.js' }, '.'), 'lib/index.js')
  assert.equal(resolveFromPackage({ dir: '/abs/pkg', manifest }, './api/x'), undefined, 'must exist on disk')
})
