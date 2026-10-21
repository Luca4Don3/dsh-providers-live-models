import { test } from 'node:test'
import assert from 'node:assert/strict'
import { locateVela, readVelaQuota, createVelaQuotaSource, FALLBACK_CREDITS_PER_USD } from '../lib/opendesign/vela.js'
import { createOpenDesignQuotaAdapter } from '../lib/opendesign/quota.js'

const windows = [{ durationSeconds: 18000, usedCredits: '16251', limitCredits: '50000', remainingCredits: '33749', resetsAt: '2030-01-01T05:00:00.000Z' }]

test('locateVela prefers the override, then the official install, then PATH', () => {
  const env = { OPENDESIGN_VELA_PATH: '/opt/vela', PATH: '/usr/bin:/opt/bin' }
  const exists = path => ['/opt/vela', '/usr/bin/vela'].includes(path)
  assert.deepEqual(locateVela({ env, exists, roots: [] }), { path: '/opt/vela', via: 'env' })
  assert.deepEqual(locateVela({ env: { PATH: '/usr/bin' }, exists, roots: [] }), { path: '/usr/bin/vela', via: 'path' })
  assert.equal(locateVela({ env: { PATH: '/none' }, exists: () => false, roots: [] }), undefined)
})

test('readVelaQuota discovers the workspace, validates windows and keeps the balance', async () => {
  const calls = []
  const exec = (binary, args, _options, callback) => {
    calls.push([binary, args.join(' ')])
    const body = args[0] === 'team-projects' ? { workspaceId: 'abcdef0123456789abcdef01' }
      : args[0] === 'billing' && args[1] === 'funding-check'
        ? { balanceUsd: '2.5000', codingPlan: { eligible: true, tier: 'go', windows } }
        : { creditsPerUsd: 12000, balanceUsd: '9.99' }
    callback(null, JSON.stringify(body))
  }
  const result = await readVelaQuota({ binary: '/opt/vela', exec })
  assert.deepEqual(calls.map(([, line]) => line), [
    'team-projects list',
    'billing funding-check --workspace-id abcdef0123456789abcdef01 --format json',
    'billing summary --format json',
  ])
  assert.equal(result.usage.windows[0].usedCredits, '16251')
  assert.equal(result.summary.balanceUsd, '2.5000')
  assert.equal(result.summary.membershipTier, 'go')
  assert.equal(result.summary.creditsPerUsd, 12000)
})

test('readVelaQuota rejects an unusable window set instead of inventing zero', async () => {
  const exec = (_binary, args, _options, callback) => callback(null, JSON.stringify(
    args[0] === 'team-projects' ? { workspaceId: 'abcdef0123456789abcdef01' }
      : { codingPlan: { eligible: true, windows: [{ durationSeconds: 0, usedCredits: 'x', limitCredits: '' }] } }))
  await assert.rejects(readVelaQuota({ binary: '/opt/vela', exec }), { code: 'invalid-response' })
})

test('readVelaQuota falls back to the documented rate when summary fails', async () => {
  const exec = (_binary, args, _options, callback) => {
    if (args[0] === 'billing' && args[1] === 'summary') { callback(new Error('403')); return }
    callback(null, JSON.stringify(args[0] === 'team-projects' ? { workspaceId: 'abcdef0123456789abcdef01' }
      : { codingPlan: { eligible: true, tier: 'go', windows } }))
  }
  const result = await readVelaQuota({ binary: '/opt/vela', exec })
  assert.equal(result.summary.creditsPerUsd, FALLBACK_CREDITS_PER_USD)
})

test('a missing workspace id is an explicit failure, not a silent empty read', async () => {
  const exec = (_binary, _args, _options, callback) => callback(null, JSON.stringify({}))
  await assert.rejects(readVelaQuota({ binary: '/opt/vela', exec }), { code: 'invalid-response' })
})

test('createVelaQuotaSource reports availability and reads through the discovered binary', async () => {
  const source = createVelaQuotaSource({ env: { OPENDESIGN_VELA_PATH: '/opt/vela' }, exists: () => true, roots: [], workspaceId: 'abcdef0123456789abcdef01',
    exec: (_binary, args, _options, callback) => callback(null, JSON.stringify(
      args[0] === 'billing' && args[1] === 'funding-check' ? { codingPlan: { eligible: true, windows } } : {})) })
  assert.equal(source.available, true)
  assert.equal(source.via, 'env')
  const result = await source.read({})
  assert.equal(result.usage.windows.length, 1)
})

test('the quota adapter prefers vela when available and never mixes credentials', async () => {
  const reads = []
  const vela = { available: true, via: 'open-design-install', read: async () => { reads.push('vela'); return { usage: { eligible: true, windows }, summary: {} } } }
  const adapter = createOpenDesignQuotaAdapter({ vela, quotaSource: 'auto',
    auth: { isConfigured: async () => false, resolveAuth: async () => { throw new Error('must not resolve a credential') } } })
  assert.equal(await adapter.isConfigured(), true)
  assert.deepEqual(await adapter.resolveAuth(), { mode: 'vela', accountKey: 'vela:open-design-install' })
  await adapter.fetchUsage({ mode: 'vela' })
  assert.deepEqual(reads, ['vela'])
})

test('control mode ignores an installed vela and requires account authorization', async () => {
  const adapter = createOpenDesignQuotaAdapter({ quotaSource: 'control',
    vela: { available: true, read: () => { throw new Error('must not run') } },
    auth: { isConfigured: async () => false, resolveAuth: async () => ({ mode: 'api-key' }) } })
  assert.equal(await adapter.isConfigured(), false)
  assert.deepEqual(await adapter.fetchUsage({ mode: 'api-key' }), { unsupported: true })
})

test('without vela and without authorization the reason is explicit', async () => {
  const adapter = createOpenDesignQuotaAdapter({ vela: { available: false }, auth: { isConfigured: async () => false } })
  assert.equal(adapter.source, 'control')
  assert.equal(await adapter.isConfigured(), false)
  await assert.rejects(adapter.fetchUsage({ mode: 'account', controlKey: 'bad' }), { code: 'auth-required' })
})
