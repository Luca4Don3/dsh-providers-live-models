import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createOpenDesignPreferences } from '../lib/opendesign/preferences.js'
import { findProfileDir } from '../lib/opendesign/profile-dir.js'

const dir = () => mkdtempSync(join(tmpdir(), 'od-prefs-'))


test('the store reports a missing path instead of pretending to save', async () => {
  const pref = createOpenDesignPreferences({ file: undefined })
  await assert.rejects(pref.setDisabledModels(['a']), /no storage path/)
})

test('profile discovery walks out of node_modules to the owning profile', () => {
  const root = dir()
  mkdirSync(join(root, 'node_modules', 'pkg', 'lib'), { recursive: true })
  writeFileSync(join(root, 'cordis.patch.yml'), '[]\n')
  const moduleUrl = 'file://' + join(root, 'node_modules', 'pkg', 'lib', 'index.js')
  assert.equal(findProfileDir(moduleUrl), root)
})

test('profile discovery returns undefined when no ancestor looks like a profile', () => {
  const root = dir()
  mkdirSync(join(root, 'a', 'b'), { recursive: true })
  assert.equal(findProfileDir('file://' + join(root, 'a', 'b', 'x.js')), undefined)
})


test('discovery returns the directory that owns node_modules, not the package', () => {
  // The bug that reset the selection: the package directory itself ships a
  // cordis.patch.yml, so a naive ancestor walk stopped there and wrote inside
  // node_modules, where a reinstall deletes the file.
  const root = dir()
  const pkg = join(root, 'node_modules', 'dsh-providers-live-models')
  mkdirSync(join(pkg, 'lib'), { recursive: true })
  writeFileSync(join(root, 'cordis.patch.yml'), '[]\n')
  writeFileSync(join(pkg, 'cordis.patch.yml'), '[]\n')
  assert.equal(findProfileDir('file://' + join(pkg, 'lib', 'index.js')), root)
})

test('a saved selection is reported as loaded, a missing one is not', async () => {
  const root = dir()
  const file = join(root, 'opendesign.json')
  const first = createOpenDesignPreferences({ file })
  await first.load()
  assert.equal(first.loaded, false, 'nothing on disk yet')
  await first.setDisabledModels(['od-two'])
  const second = createOpenDesignPreferences({ file })
  await second.load()
  assert.equal(second.loaded, true)
  assert.deepEqual(second.snapshot().disabledModels, ['od-two'])
})


test('prune removes ids the roster no longer offers, and only those', async () => {
  const file = join(dir(), 'opendesign.json')
  const pref = createOpenDesignPreferences({ file })
  await pref.setDisabledModels(['gone-model', 'still-here'])
  await pref.setReasoning('gone-model', ['low'])
  await pref.setReasoning('still-here', ['high'])
  const changed = await pref.prune(['still-here', 'other'])
  assert.equal(changed, true)
  assert.deepEqual(pref.snapshot(), { disabledModels: ['still-here'], reasoning: { 'still-here': ['high'] }, providers: {} })

  const reread = createOpenDesignPreferences({ file })
  await reread.load()
  assert.deepEqual(reread.snapshot(), { disabledModels: ['still-here'], reasoning: { 'still-here': ['high'] }, providers: {} })
})

test('prune is a no-op when everything still exists', async () => {
  const pref = createOpenDesignPreferences({ file: join(dir(), 'opendesign.json') })
  await pref.setDisabledModels(['a'])
  assert.equal(await pref.prune(['a', 'b']), false)
})

test('prune never adds or reorders entries', async () => {
  const pref = createOpenDesignPreferences({ file: join(dir(), 'opendesign.json') })
  await pref.setDisabledModels(['b', 'a'])
  await pref.prune(['a', 'b', 'c'])
  assert.deepEqual(pref.snapshot().disabledModels, ['b', 'a'])
})


test('per-route selections stay independent of the OpenDesign entry', async () => {
  const file = join(dir(), 'opendesign.json')
  const pref = createOpenDesignPreferences({ file })
  await pref.setDisabledModels(['claude-haiku-5.5'])
  await pref.setDisabledFor('opencode-go', ['glm-5.2', 'beam-free'])
  await pref.setDisabledFor('openai-codex', ['gpt-6-luna'])
  assert.deepEqual(pref.snapshot().disabledModels, ['claude-haiku-5.5'])
  assert.deepEqual(pref.disabledFor('opencode-go'), ['glm-5.2', 'beam-free'])
  assert.deepEqual(pref.disabledFor('openai-codex'), ['gpt-6-luna'])
  assert.deepEqual(pref.disabledFor('opencode'), [])

  const second = createOpenDesignPreferences({ file })
  await second.load()
  assert.deepEqual(second.disabledFor('opencode-go'), ['glm-5.2', 'beam-free'], 'survives a reload')
})

test('a route prune leaves other routes and the OpenDesign set alone', async () => {
  const pref = createOpenDesignPreferences({ file: join(dir(), 'opendesign.json') })
  await pref.setDisabledModels(['claude-haiku-5.5'])
  await pref.setDisabledFor('opencode-go', ['gone', 'kept'])
  assert.equal(await pref.pruneProvider('opencode-go', ['kept']), true)
  assert.deepEqual(pref.disabledFor('opencode-go'), ['kept'])
  assert.deepEqual(pref.snapshot().disabledModels, ['claude-haiku-5.5'])
  assert.equal(await pref.pruneProvider('missing', ['x']), false)
})

test('disabled models and learned levels round-trip through one file', async () => {
  const file = join(dir(), 'opendesign.json')
  const first = createOpenDesignPreferences({ file })
  await first.setDisabledModels(['b', 'a', 'a'])
  await first.setReasoning('deepseek-v4.1-flash', ['low', 'high'])
  assert.deepEqual(first.snapshot(), { disabledModels: ['b', 'a'], reasoning: { 'deepseek-v4.1-flash': ['low', 'high'] }, providers: {} })

  const second = createOpenDesignPreferences({ file })
  await second.load()
  assert.deepEqual(second.snapshot(), first.snapshot())
  const stored = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(stored.disabledModels, ['b', 'a'])
})

test('a missing or corrupt file falls back to empty without throwing', async () => {
  const file = join(dir(), 'opendesign.json')
  const missing = createOpenDesignPreferences({ file })
  await missing.load()
  assert.deepEqual(missing.snapshot(), { disabledModels: [], reasoning: {}, providers: {} })

  const corrupt = createOpenDesignPreferences({ file: join(dir(), 'bad.json') })
  await corrupt.load()
  assert.deepEqual(corrupt.snapshot(), { disabledModels: [], reasoning: {}, providers: {} })
})

test('unexpected shapes are ignored rather than trusted', async () => {
  const pref = createOpenDesignPreferences({ file: join(dir(), 'opendesign.json') })
  await pref.setDisabledModels('not-an-array')
  assert.deepEqual(pref.snapshot().disabledModels, [])
})

test('subscribers hear about a change and can stop listening', async () => {
  const pref = createOpenDesignPreferences({ file: join(dir(), 'opendesign.json') })
  const seen = []
  const stop = pref.subscribe(snapshot => seen.push([...snapshot.disabledModels]))
  await pref.setDisabledModels(['x'])
  stop()
  await pref.setDisabledModels(['y'])
  assert.deepEqual(seen, [['x']])
})
