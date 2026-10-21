import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeOpenDesignModels as normalize, OPENDESIGN_BASE_URL } from '../lib/opendesign/models.js'

const row = (id = 'model', metadata = {}) => ({ id, metadata: { context_limit: 128000, ...metadata } })

test('roster maps only trusted protocol, origin and supported modalities', () => {
  const remote = { ...row(), name: 'Display', provider: 'openai-codex', api: 'bad', baseURL: 'https://bad.invalid',
    headers: { authorization: 'bad' }, architecture: { input_modalities: ['text', 'image', 'file', 'audio', 'text'] },
    metadata: { context_limit: 128000, context_budget: 32000, capability: ['reasoning'] } }
  const { models: [model], diagnostics } = normalize({ data: [remote] })
  assert.equal(model.provider, 'opendesign'); assert.equal(model.api, 'openai-completions')
  assert.equal(model.baseUrl, OPENDESIGN_BASE_URL); assert.deepEqual(model.input, ['text', 'image'])
  assert.equal(model.name, 'Display'); assert.equal(model.maxTokens, 8192)
  assert.equal(model.reasoning, undefined); assert.equal(model.headers, undefined)
  assert.deepEqual(diagnostics, [{ id: 'model', outputBudgetSource: 'local-default', ignoredContextBudget: 32000 }])
  assert.equal(Object.isFrozen(model.input), true)
  assert.throws(() => { model.input.push('file') }, TypeError)
})
test('an id-only roster gets a readable display name without changing the request id', () => {
  const { models } = normalize({ data: [row('deepseek-v4.1-flash'), row('brand-new-model')] })
  assert.equal(models[0].id, 'deepseek-v4.1-flash')
  assert.equal(models[0].name, 'DeepSeek V4.1 Flash')
  assert.equal(models[1].id, 'brand-new-model')
  assert.equal(models[1].name, 'brand-new-model', 'unknown ids keep their id')
})

test('a roster-supplied name still wins over the display table', () => {
  const { models } = normalize({ data: [{ ...row('gpt-6-luna'), name: 'Team alias' }] })
  assert.equal(models[0].name, 'Team alias')
})

test('known models declare the reasoning levels they accept', () => {
  const { models } = normalize({ data: [row('glm-5.3-flash'), row('deepseek-v4.1-flash'), row('unknown-model')] })
  const glm = models[0]
  assert.equal(glm.reasoning, true)
  assert.equal(glm.thinkingLevelMap.low, 'low')
  assert.equal(glm.thinkingLevelMap.high, 'high')
  assert.equal(glm.thinkingLevelMap.max, 'max')
  assert.equal(glm.thinkingLevelMap.minimal, null, 'levels GLM rejects are unsupported')
  const deepseek = models[1]
  assert.equal(deepseek.reasoning, true)
  assert.equal(deepseek.thinkingLevelMap.low, 'low')
  assert.equal(deepseek.thinkingLevelMap.max, 'max')
  assert.equal(deepseek.thinkingLevelMap.minimal, null, 'DeepSeek documents only low/high/max')
  assert.equal(deepseek.thinkingLevelMap.medium, null)
  assert.equal(deepseek.thinkingLevelMap.xhigh, null)
  assert.equal(Object.hasOwn(deepseek.thinkingLevelMap, 'off'), false, 'off means send nothing')
  assert.equal(models[2].reasoning, undefined, 'an unknown model declares no reasoning control')
})

test('models without a documented effort set get no extended levels', () => {
  const { models } = normalize({ data: [row('gpt-6-luna'), row('claude-haiku-5.5')] })
  assert.equal(models[0].reasoning, undefined, 'GPT-6 Luna is declared without a reasoning control')
  assert.equal(models[1].reasoning, undefined, 'Claude Haiku 5.5 likewise')
})

test('output request budget is independent of undocumented context_budget', () => {
  const { models, diagnostics } = normalize({ data: [row('a', { context_budget: 1 }),
    row('b', { max_output_tokens: 2000, max_completion_tokens: 1000, output_limit: 3000 })] }, { outputTokenBudget: 4096 })
  assert.deepEqual(models.map(model => model.maxTokens), [4096, 1000])
  assert.equal(diagnostics[0].outputBudgetSource, 'local-config')
  assert.equal(diagnostics[1].explicitOutputLimit, 1000)
})
test('output_budget is informational and never overrides the local request budget', () => {
  const result = normalize({ data: [row('m', { output_budget: 1 })] })
  assert.equal(result.models[0].maxTokens, 8192)
  assert.equal(result.diagnostics[0].informationalOutputBudget, 1)
})
test('missing context is rejected individually and good entries survive', () => {
  const { models, diagnostics } = normalize({ data: [{ id: 'unknown' }, row('good'), row('good'),
    row('file-only', {}), { id: 'bad\n', metadata: { context_limit: 100 } }].map(entry => entry.id === 'file-only'
      ? { ...entry, architecture: { input_modalities: ['file'] } } : entry) })
  assert.deepEqual(models.map(model => model.id), ['good'])
  assert.deepEqual(diagnostics.filter(item => item.reason).map(item => item.reason),
    ['missing-or-invalid-context', 'duplicate-id', 'unsupported-input-modalities', 'invalid-id'])
})
test('explicit context_window and verified local overrides do not become wire config', () => {
  const { models: [model] } = normalize({ data: [{ id: 'm', metadata: { context_window: 4000 } }] },
    { overrides: { m: { maxTokens: 2000, input: ['text'], baseUrl: 'bad' } } })
  assert.equal(model.contextWindow, 4000); assert.equal(model.maxTokens, 2000)
  assert.equal(model.baseUrl, OPENDESIGN_BASE_URL)
})
test('Responses is explicit and remote protocol hints never choose the wire API', () => {
  const payload = { data: [{ ...row(), api: 'openai-responses' }] }
  assert.equal(normalize(payload).models[0].api, 'openai-completions')
  assert.equal(normalize(payload, { protocol: 'responses' }).models[0].api, 'openai-responses')
  assert.throws(() => normalize(payload, { protocol: 'unknown' }), TypeError)
})
test('invalid capacities, envelope and bounds fail explicitly', () => {
  for (const context of [0, -1, 0.5, '100', Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => normalize({ data: [row('bad', { context_limit: context })] }), { code: 'incomplete-catalog' })
  }
  assert.throws(() => normalize({ data: [row('bad', { max_output_tokens: 0 })] }), { code: 'incomplete-catalog' })
  assert.throws(() => normalize({ data: [] }), { code: 'incomplete-catalog' })
  assert.throws(() => normalize({ data: [row()] }, { maxModels: 0 }), { code: 'invalid-response' })
  assert.throws(() => normalize({ data: [row()] }, { outputTokenBudget: 0 }), TypeError)
})
