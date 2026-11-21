import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const STATE_KEY = Symbol.for('dsh-providers-live-models.state')

/**
 * Mount the plugin the way the desktop Host does, but without the optional
 * `settings` injection: a filter that only exists once that service resolves
 * leaves every switched-off model in the picker, which is the bug this covers.
 */
async function mount() {
  globalThis[STATE_KEY] = undefined
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('offline') }
  const models = [
    { id: 'glm-5.3', name: 'GLM-5.3', api: 'openai-completions', contextWindow: 1000000, maxTokens: 131072, input: ['text'], cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
    { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', api: 'openai-completions', contextWindow: 1000000, maxTokens: 131072, input: ['text'], cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
  ]
  let provider = { getModels: () => models.map(model => ({ ...model, provider: 'opencode-go' })), stream() {}, streamSimple() {} }
  const collection = {
    getProvider: id => (id === 'opencode-go' ? provider : undefined),
    setProvider: next => { provider = next },
    getModels: id => collection.getProvider(id)?.getModels() ?? [],
  }
  const adapter = { current: () => ({ profiles: new Map(), models: collection }), providerInfo: () => ({ name: 'OpenCode Go' }) }
  const emitted = []
  const ctx = {
    llm: { adapters: new Map([['opencode-go', { adapter, provider: { name: 'OpenCode Go' } }]]) },
    logger: { info() {}, warn() {}, debug() {} },
    emit: event => emitted.push(event), on() {}, effect(fn) { return fn() },
    // Deliberately absent: the pre-fix filter lived inside this injection.
    inject() {},
    get: name => (name === 'settings' ? { describe: () => [] } : undefined),
    provide() {},
  }
  const module = await import('../lib/index.js?route-filter=' + mkdtempSync(join(tmpdir(), 'route-filter-')))
  module.apply(ctx)
  await new Promise(resolve => setTimeout(resolve, 20))
  return {
    state: globalThis[STATE_KEY], offered: () => collection.getModels('opencode-go').map(model => model.id),
    emitted, cleanup() { globalThis.fetch = previousFetch },
  }
}

test('a switched-off model never reaches the picker, even without the settings service', async () => {
  const mounted = await mount()
  try {
    const identity = mounted.state.selectModels.toString().includes('=> models')
    assert.equal(identity, false, 'the filter is installed at mount, not by an optional injection')
    mounted.state.disabledModelsFor = provider => (provider === 'opencode-go' ? ['glm-5.3-flash'] : [])
    assert.deepEqual(mounted.offered(), ['glm-5.3'])
    assert.deepEqual(mounted.state.knownModels.get('opencode-go').map(model => model.id),
      ['glm-5.3', 'glm-5.3-flash'], 'the switches page still lists what it can re-enable')
  } finally { mounted.cleanup() }
})

test('an empty disabled list offers the full roster', async () => {
  const mounted = await mount()
  try {
    mounted.state.disabledModelsFor = () => []
    assert.deepEqual(mounted.offered(), ['glm-5.3', 'glm-5.3-flash'])
  } finally { mounted.cleanup() }
})
