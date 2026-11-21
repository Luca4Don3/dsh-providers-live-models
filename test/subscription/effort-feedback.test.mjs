import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../../lib/client.js', import.meta.url), 'utf8')
const high = { provider: 'opencode-go', model: 'glm-5.3', reasoningEffort: 'high' }
const max = { ...high, reasoningEffort: 'max' }
const low = { ...high, reasoningEffort: 'low' }
const other = { ...high, model: 'another' }
const ok = { ok: true, value: undefined }
const fail = { ok: false, error: { code: 'unchanged', message: 'not accepted' } }

function fixture() {
  class ModelDirectory {
    generation = 0
    disposed = false
    selection = { next: high }
    replies = []
    catalog = { reasoningFor: () => ({ efforts: [{ id: 'max', name: 'Max' }] }) }
    projected = { getSnapshot: () => this.selection }
    store = {
      getSnapshot: () => this.state,
      update: fn => { const next = { ...this.state }; fn(next); this.state = next },
    }
    state = { current: high, status: 'ready', pending: null,
      groups: [{ id: high.provider, models: [{ id: high.model }, { id: other.model }] }] }
    async select(selection) {
      const version = ++this.generation
      this.state.pending = selection
      const result = await new Promise(resolve => this.replies.push(resolve))
      if (version === this.generation && !this.disposed) {
        this.state.pending = null
        this.syncInputs()
      }
      return result
    }
    syncInputs() {
      if (this.state.status === 'ready' && this.selection) this.state.current = this.selection.next
    }
    resetConnected() { this.generation++; this.syncInputs() }
  }
  const native = ModelDirectory.prototype.select
  let entry, dispose
  runInNewContext(source, { window: { __ModuleLoader__: { load: value => { entry = value } } } })
  const client = entry.factory(id => id === 'react' ? {} : { ModelDirectory })
  client.apply({ slots: { inject() {} }, effect: fn => { dispose = fn() } })
  assert.notEqual(ModelDirectory.prototype.select, native, 'client mounted the compatibility patch')
  return { directory: new ModelDirectory(), cleanup: () => {
    dispose()
    assert.equal(ModelDirectory.prototype.select, native)
  } }
}

async function settle(directory, selection, reply = ok) {
  const request = directory.select(selection)
  directory.replies.shift()(reply)
  return request
}

test('effort label changes only on acknowledgement and survives catalog refresh', async () => {
  const { directory: d, cleanup } = fixture()
  const request = d.select(max)
  assert.equal(d.state.current.reasoningEffort, 'high')
  d.state.status = 'loading'
  d.replies.shift()(ok)
  await request
  assert.equal(d.state.current.reasoningEffort, 'max')
  assert.equal(d.state.retainedEffort, 'Max')
  assert.equal(d.selection.next.reasoningEffort, 'high', 'server projection never edited')
  d.state.status = 'ready'
  d.syncInputs()
  assert.equal(d.state.current.reasoningEffort, 'max')
  d.selection = { next: max }
  d.syncInputs()
  d.selection = { next: low }
  d.syncInputs()
  assert.equal(d.state.current.reasoningEffort, 'low', 'new projection wins')
  cleanup()
})

test('a projection arriving during a catalog refresh updates the existing model label', async () => {
  const { directory: d, cleanup } = fixture()
  d.state.status = 'loading'
  d.selection = { next: max }
  d.syncInputs()
  assert.equal(d.state.current.reasoningEffort, 'max')
  cleanup()
})

test('failed requests and model changes do not fake a confirmed effort', async () => {
  const { directory: d, cleanup } = fixture()
  assert.equal(await settle(d, max, fail), fail)
  assert.equal(d.state.current.reasoningEffort, 'high')
  await settle(d, other)
  assert.equal(d.state.current.model, high.model)
  cleanup()
})

test('stale replies after a newer selection or connection reset have no effect', async () => {
  const { directory: d, cleanup } = fixture()
  const old = d.select(max)
  const latest = d.select(low)
  d.replies.pop()(ok)
  await latest
  d.replies.shift()(ok)
  await old
  assert.equal(d.state.current.reasoningEffort, 'low')
  const pending = d.select(max)
  d.resetConnected()
  d.replies.shift()(ok)
  await pending
  assert.equal(d.state.current.reasoningEffort, 'high')
  cleanup()
})

test('an authoritative selection received before acknowledgement wins', async () => {
  const { directory: d, cleanup } = fixture()
  const pending = d.select(max)
  d.selection = { next: low }
  d.syncInputs()
  d.replies.shift()(ok)
  await pending
  assert.equal(d.state.current.reasoningEffort, 'low')
  cleanup()
})
