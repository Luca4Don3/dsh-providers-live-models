/** OpenDesign's roster is data, never a provider/transport configuration. */
export const OPENDESIGN_PROVIDER = 'opendesign'
export const OPENDESIGN_ORIGIN = 'https://amr-link.open-design.ai'
export const OPENDESIGN_BASE_URL = OPENDESIGN_ORIGIN + '/v1'
export const OPENDESIGN_MODELS_URL = OPENDESIGN_BASE_URL + '/models'

export function openDesignApiFor(protocol = 'chat-completions') {
  if (protocol === 'chat-completions') return 'openai-completions'
  if (protocol === 'responses') return 'openai-responses'
  throw new TypeError('OpenDesign protocol must be chat-completions or responses')
}

export class OpenDesignCatalogError extends Error {
  constructor(code, message, diagnostics = []) {
    super(message)
    this.name = 'OpenDesignCatalogError'
    this.code = code
    this.diagnostics = diagnostics
  }
}

/**
 * Display names for models the roster identifies by id alone. Presentation only:
 * the request always uses the id, and an unknown id keeps the id as its name.
 */
const DISPLAY_NAMES = {
  'claude-haiku-5.5': 'Claude Haiku 5.5',
  'deepseek-v4-flash': 'DeepSeek V4 Flash',
  'deepseek-v4-flash-vision-exp': 'DeepSeek V4 Flash Vision Exp',
  'deepseek-v4-pro': 'DeepSeek V4 Pro',
  'deepseek-v4.1-flash': 'DeepSeek V4.1 Flash',
  'deepseek-v4.1-flash-eco': 'DeepSeek V4.1 Flash Eco',
  'glm-5.3-flash': 'GLM-5.3 Flash',
  'glm-5.3-flashx': 'GLM-5.3 Flash-X',
  'gpt-6-luna': 'GPT-6 Luna',
  'hy4-preview': 'Hunyuan H4 Preview',
  'kimi-k2.7-code': 'Kimi K2.7 Code',
  'mimo-v2.6-flash': 'MiMo V2.6 Flash',
  'mimo-v2.6-pro': 'MiMo V2.6 Pro',
}

/**
 * Reasoning levels each known model documents. A model absent here declares
 * nothing, so the picker shows no control rather than an option the gateway may
 * reject.
 *
 * DeepSeek documents only three values for `reasoning_effort`: low, high and max
 * (its thinking-mode guide also lists minimal/medium/xhigh as *mapped* inputs,
 * but the documented control set is the three). GLM documents the same three.
 *
 * pi-ai reads a null entry as "not supported" and a missing `off` as "supported,
 * send nothing", which is what an unset effort means on the wire.
 */
const REASONING_LEVELS = {
  // api-docs.deepseek.com/guides/thinking_mode: reasoning_effort low/high/max.
  'deepseek-v4-flash': ['low', 'high', 'max'],
  'deepseek-v4-flash-vision-exp': ['low', 'high', 'max'],
  'deepseek-v4-pro': ['low', 'high', 'max'],
  'deepseek-v4.1-flash': ['low', 'high', 'max'],
  // Same weights as the standard Flash, served by a slower upstream (BytePlus
  // rather than Volcengine) for non-urgent work; OpenDesign documents the same
  // reasoning capabilities, and third-party probing confirms `reasoning_effort`
  // is accepted.
  'deepseek-v4.1-flash-eco': ['low', 'high', 'max'],
  'glm-5.3-flash': ['low', 'high', 'max'],
  'glm-5.3-flashx': ['low', 'high', 'max'],
}
const REASONING_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** The reasoning fields for one model, or an empty object when it declares none. */
export function reasoningOf(id, learned) {
  const accepted = Array.isArray(learned) && learned.length > 0 ? learned.filter(level => REASONING_ORDER.includes(level)) : REASONING_LEVELS[id]
  if (accepted === undefined || accepted.length === 0) return {}
  const thinkingLevelMap = {}
  for (const level of REASONING_ORDER) thinkingLevelMap[level] = accepted.includes(level) ? level : null
  // thinkingLevels is this plugin's own record of the opt-in set, for diagnostics
  // and for rebuilding a descriptor after a preference change.
  return { reasoning: true, thinkingLevelMap, thinkingLevels: [...accepted] }
}

/**
 * Input modalities this deployment declares itself, replacing the catalog's.
 *
 * `/v1/models` lists `deepseek-v4.1-flash-eco` as text-only, while OpenDesign's
 * own announcement and independent probing (960 measured requests) both report
 * image input working; the same endpoint already lists the standard Flash as
 * `text+image`. OpenDesign confirmed the field is theirs to fix and told callers
 * to declare it locally until then.
 *
 * A model named here uses the list below whatever the catalog says, so the entry
 * must be the complete set. An explicit `modelOverrides.input` still wins, being
 * the one place a deployment can override this plugin in turn.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
const DECLARED_INPUT = Object.freeze({
  'deepseek-v4.1-flash-eco': Object.freeze(['text', 'image']),
})

const positive = value => Number.isSafeInteger(value) && value > 0
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const safeId = value => typeof value === 'string' && value.trim() === value && value.length > 0
  && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value)

/**
 * The local request budget used when neither the deployment nor the roster names
 * one. A roster that does name one is followed; see the precedence below.
 */
export const DEFAULT_OUTPUT_TOKEN_BUDGET = 8192

/**
 * context_limit/context_window describes upstream context. maxTokens is our
 * local request budget, NOT a claim about the supplier output capability. The
 * undocumented context_budget is diagnostic only; never use it as output cap.
 *
 * `metadata.output_budget` is the roster's own per-model statement of how many
 * output tokens a request may reserve, so it seeds the budget instead of merely
 * being reported. It is not an enforced vendor limit either: an explicit
 * deployment budget or per-model override still outranks it, and the context
 * window and any hard `max_output_tokens` capability cap it further.
 *
 * @param config.outputTokenBudget - Deployment-wide budget. Omit it to follow
 *   each model's own roster value.
 */
export function normalizeOpenDesignModels(payload, { overrides = {}, maxModels = 5000, outputTokenBudget, protocol = 'chat-completions', learnedReasoning = {} } = {}) {
  const api = openDesignApiFor(protocol)
  if (outputTokenBudget !== undefined && !positive(outputTokenBudget)) {
    throw new TypeError('outputTokenBudget must be a positive safe integer when provided')
  }
  if (!object(payload) || !Array.isArray(payload.data) || payload.data.length > maxModels) {
    throw new OpenDesignCatalogError('invalid-response', 'OpenDesign returned an invalid model roster')
  }
  const models = [], diagnostics = [], seen = new Set()
  for (const entry of payload.data) {
    const id = entry?.id
    const reject = reason => diagnostics.push({ id: safeId(id) ? id : undefined, reason })
    if (!object(entry) || !safeId(id)) { reject('invalid-id'); continue }
    if (seen.has(id)) { reject('duplicate-id'); continue }
    seen.add(id)
    const metadata = object(entry.metadata) ? entry.metadata : {}
    const override = Object.hasOwn(overrides, id) && object(overrides[id]) ? overrides[id] : {}
    const contextWindow = override.contextWindow ?? metadata.context_limit ?? metadata.context_window
    if (!positive(contextWindow)) { reject('missing-or-invalid-context'); continue }
    const caps = [metadata.max_output_tokens, metadata.max_completion_tokens, metadata.output_limit]
      .filter(value => value !== undefined)
    if (caps.some(value => !positive(value))) { reject('invalid-output-limit'); continue }
    // Budget precedence, highest first: an explicit override, the deployment
    // budget, the roster's own statement, then the built-in floor. A
    // non-positive roster value is ignored rather than rejecting an otherwise
    // usable model, since the field is advisory in the first place.
    const rosterBudget = positive(metadata.output_budget) ? metadata.output_budget : undefined
    const budgetSource = override.maxTokens !== undefined ? 'local-override'
      : outputTokenBudget !== undefined ? 'local-config'
      : rosterBudget !== undefined ? 'catalog'
      : 'local-default'
    const localBudget = override.maxTokens ?? outputTokenBudget ?? rosterBudget ?? DEFAULT_OUTPUT_TOKEN_BUDGET
    if (!positive(localBudget)) { reject('invalid-output-budget'); continue }
    const maxTokens = Math.min(localBudget, contextWindow, ...caps)
    // Precedence, highest first: an explicit override, this deployment's own
    // declaration, then the catalog. A model declared below never consults the
    // catalog for modalities at all.
    const declared = DECLARED_INPUT[id]
    const modalities = override.input ?? declared ?? entry.architecture?.input_modalities ?? ['text']
    if (!Array.isArray(modalities)) { reject('invalid-input-modalities'); continue }
    const input = [...new Set(modalities.filter(value => value === 'text' || value === 'image'))]
    if (input.length === 0) { reject('unsupported-input-modalities'); continue }
    const supplied = typeof entry.name === 'string' && entry.name.trim() && entry.name.length <= 512
      && !/[\u0000-\u001f\u007f]/.test(entry.name) ? entry.name : undefined
    const name = supplied ?? DISPLAY_NAMES[id] ?? id
    diagnostics.push({ id, outputBudgetSource: budgetSource, maxTokens,
      ...(positive(metadata.context_budget) ? { ignoredContextBudget: metadata.context_budget } : {}),
      ...(rosterBudget !== undefined ? { catalogOutputBudget: rosterBudget } : {}),
      ...(caps.length ? { explicitOutputLimit: Math.min(...caps) } : {}) })
    // Zeroes satisfy pi-ai's structural cost contract; they are not a price quote.
    models.push(Object.freeze({
      id, name, provider: OPENDESIGN_PROVIDER, api, ...reasoningOf(id, learnedReasoning?.[id]),
      baseUrl: OPENDESIGN_BASE_URL, input: Object.freeze(input), contextWindow, maxTokens,
      // A local request policy for DeepSeek only, never a promise of gateway TTL.
      ...(/^deepseek/i.test(id) ? { compat: Object.freeze({ supportsLongCacheRetention: true }) } : {}),
      cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
    }))
  }
  if (!models.length) throw new OpenDesignCatalogError('incomplete-catalog',
    'OpenDesign returned no models with verified capacities and supported input', diagnostics)
  return { models: Object.freeze(models), diagnostics }
}
