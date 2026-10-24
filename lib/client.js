/**
 * Plugin-page login, account balances and native model-selection controls.
 *
 * Declared via package.json dsh.client. The button drives the host login over
 * the plugin loopback HTTP API; the host opens the browser, so the desktop
 * machine default browser is used even from a remote Web session. The client
 * registers a classic-script factory with the host module loader, matching
 * first-party client bundles.
 * React is resolved from the host rather than bundled.
 *
 * @module dsh-providers-live-models/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-providers-live-models',
  factory: (require) => {
    const { createElement: h, cloneElement, isValidElement, useState, useEffect, useRef, useMemo } = require('react')

    const BASE = '/dsh-providers-live-models'
    const MAX_SUBSCRIPTIONS = 4

    async function request(path, init) {
      const response = await fetch(BASE + path, {
        credentials: 'same-origin',
        ...init,
        headers: {
          accept: 'application/json',
          ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
      })
      const text = await response.text()
      const body = text.length === 0 ? {} : JSON.parse(text)
      return { status: response.status, body }
    }

    const styles = {
      card: { border: '0.5px solid var(--dsw-alias-border-l3, #d9d9e3)', borderRadius: 14, padding: '16px 18px',
        margin: '8px 0', background: 'var(--dsw-alias-settings-card-fill, transparent)',
        boxShadow: '0 1px 2px rgba(0,0,0,0.04)' },
      row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' },
      dim: { color: 'var(--ds-text-dim, #6b6b7b)', fontSize: 12 },
      para: { margin: '8px 0 0', fontSize: 13, lineHeight: 1.6 },
      err: { color: '#c0392b', fontSize: 13 },
      btn: { padding: '6px 14px', borderRadius: 8, border: '0.5px solid var(--dsw-alias-border-l3, #d9d9e3)',
        background: 'transparent', color: 'inherit', fontSize: 12.5, fontWeight: 500, cursor: 'pointer',
        transition: 'background 120ms ease, opacity 120ms ease' },
      primary: { background: '#1f6feb', color: '#fff' },
      ghost: { background: 'transparent', color: '#c0392b', border: '1px solid #c0392b' },
      input: { padding: '6px 8px', borderRadius: 6, border: '1px solid var(--ds-border, #d9d9e3)', minWidth: 260, fontSize: 13 },
      balanceCard: {
        display: 'flex', flexDirection: 'column',
        border: '0.5px solid var(--dsw-alias-border-l3, #555)',
        borderRadius: 'var(--dsw-radius-xl, 16px)',
        padding: 20, minWidth: 0,
        color: 'var(--dsw-alias-label-primary, inherit)',
        background: 'var(--dsw-alias-settings-card-fill, transparent)',
      },
    }

    const statusLabels = {
      ready: '可用', exhausted: '额度已用尽', stale: '数据已过期',
      'auth-required': '登录已失效', 'rate-limited': '请求受限',
      unknown: '未知', unsupported: '暂不支持', unavailable: '服务尚未就绪',
      network: '连接失败', timeout: '请求超时', 'risk-control': '服务拒绝访问',
      forbidden: '计费接口拒绝访问',
      'invalid-response': '余额响应不完整', 'invalid-input': '输入无效',
      'storage-unavailable': '无法写入偏好文件，开关未保存',
      'origin-refused': '仅允许本机同源操作', 'provider-unavailable': '模型适配器尚未就绪', upstream: '上游服务暂不可用',
      loading: '查询中…',
    }

    // Persist only the fields rendered by the cards. Credentials and upstream
    // account identifiers never enter the browser's display cache.
    const STORAGE_KEY = 'dsh-providers-live-models.subscription-balances.v1'
    const balances = new Map()
    let cacheIssue = ''

    function moneyBalance(value) {
      return Number.isFinite(value?.amount) && typeof value.currency === 'string' && /^[A-Z]{3}$/.test(value.currency)
        ? { amount: value.amount, currency: value.currency, ...(value.kind === 'credit' ? { kind: 'credit' } : {}) } : undefined
    }

    function displayEntry(entry) {
      const provider = entry?.provider, snapshot = entry?.snapshot
      if (!provider || typeof provider.providerId !== 'string' || !provider.providerId || /^deepseek(?:$|[-/])/i.test(provider.providerId)
        || typeof provider.cacheKey !== 'string' || !provider.cacheKey || !snapshot || snapshot.error
        || !Object.hasOwn(statusLabels, snapshot.status) || snapshot.status === 'loading'
        || !Number.isFinite(entry.savedAt) || !Number.isFinite(entry.freshMs) || entry.freshMs < 1000
        || !Array.isArray(snapshot.windows)) return undefined
      return {
        provider: { providerId: provider.providerId, label: typeof provider.label === 'string' ? provider.label : provider.providerId, cacheKey: provider.cacheKey,
          ...(provider.kind === 'balance' ? { kind: 'balance' } : {}) },
        savedAt: entry.savedAt, freshMs: entry.freshMs,
        snapshot: {
          status: snapshot.status,
          ...(provider.providerId === 'opendesign' && typeof snapshot.plan === 'string' ? { plan: snapshot.plan.slice(0, 80) } : {}),
          ...(provider.providerId === 'opendesign' && typeof snapshot.warning === 'string' ? { warning: snapshot.warning.slice(0, 500) } : {}),
          ...(moneyBalance(snapshot.balance) ? { balance: moneyBalance(snapshot.balance) } : {}),
          ...(Number.isFinite(snapshot.capturedAt) ? { capturedAt: snapshot.capturedAt } : {}),
          windows: snapshot.windows.filter(window => typeof window?.id === 'string').slice(0, 10).map(window => ({
            id: window.id,
            ...(typeof window.label === 'string' ? { label: window.label } : {}),
            ...(Number.isFinite(window.remainingPercent) && window.remainingPercent >= 0 && window.remainingPercent <= 100 ? { remainingPercent: window.remainingPercent } : {}),
            ...(Number.isFinite(window.resetsAt) || typeof window.resetsAt === 'string' ? { resetsAt: window.resetsAt } : {}),
          })),
        },
      }
    }

    function cacheFailed(action) {
      cacheIssue = action === 'read' ? '本地额度缓存读取失败，将重新查询' : '本地额度缓存保存失败，退出后可能无法保留'
      console.warn('[dsh-providers-live-models] display cache ' + action + ' failed')
    }

    function restoreBalances() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        if (!raw) return
        const stored = JSON.parse(raw)
        if (stored?.version !== 1 || !Array.isArray(stored.entries)) throw new Error('invalid display cache')
        for (const item of stored.entries) {
          const entry = displayEntry(item)
          if (entry && !balances.has(entry.provider.providerId) && balances.size < MAX_SUBSCRIPTIONS) {
            balances.set(entry.provider.providerId, { ...entry, cacheKey: entry.provider.cacheKey, restored: true })
          }
        }
      } catch { cacheFailed('read') }
    }

    function persistBalances() {
      try {
        const entries = [...balances.values()].map(displayEntry).filter(Boolean).slice(0, MAX_SUBSCRIPTIONS)
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, entries }))
        cacheIssue = ''
      } catch { cacheFailed('write') }
    }

    restoreBalances()

    function cachedBalance(provider) {
      const cached = balances.get(provider.providerId)
      return typeof provider.cacheKey === 'string' && cached?.cacheKey === provider.cacheKey ? cached : undefined
    }

    async function queryBalance(provider, freshMs, refresh) {
      const cached = cachedBalance(provider)
      const entry = cached ?? { cacheKey: provider.cacheKey }
      entry.provider = provider
      entry.freshMs = freshMs
      if (cached?.pending) return cached.pending
      if (!refresh && !cached?.restored && cached?.snapshot && Date.now() - cached.savedAt < freshMs) return cached.snapshot
      if (typeof provider.cacheKey === 'string') balances.set(provider.providerId, entry)
      entry.pending = (async () => {
        let snapshot
        try {
          const result = await request('/usage?provider=' + encodeURIComponent(provider.providerId) + (refresh ? '&refresh=1' : ''))
          snapshot = result.body
          if (result.status >= 400 && !snapshot.error) snapshot = { error: 'unavailable' }
          if (provider.kind === 'balance' && !snapshot.error && !moneyBalance(snapshot.balance)) snapshot = { error: 'invalid-response' }
        } catch {
          snapshot = { error: 'network' }
        }
        if (snapshot.error) {
          if (snapshot.error === 'auth-required') entry.snapshot = undefined
          else if (entry.snapshot) return { ...entry.snapshot, status: 'stale', staleReason: snapshot.error }
        } else {
          entry.snapshot = snapshot
          if (snapshot.status !== 'stale') {
            entry.savedAt = Number.isFinite(snapshot.capturedAt) ? Math.min(snapshot.capturedAt, Date.now()) : Date.now()
            entry.restored = false
          }
        }
        persistBalances()
        return snapshot
      })()
      try { return await entry.pending } finally { entry.pending = undefined }
    }

    function savedBalances() {
      const subscriptions = [...balances.values()].filter(entry => entry.snapshot).slice(0, MAX_SUBSCRIPTIONS).map(entry => ({
        ...entry.provider,
        snapshot: Date.now() - entry.savedAt < entry.freshMs ? entry.snapshot : { ...entry.snapshot, status: 'stale' },
      }))
      return subscriptions.length ? { subscriptions, checking: true } : null
    }

    function SubscriptionBalances() {
      const [state, setState] = useState(savedBalances)
      const [busy, setBusy] = useState(!!state)
      const mounted = useRef(true)
      const load = async (refresh = false) => {
        setBusy(true)
        try {
          const listed = await request('/subscriptions')
          if (listed.status >= 400) throw new Error('无法读取已登录订阅')
          const seen = new Set()
          const providers = (listed.body.subscriptions ?? []).filter(provider => {
            if (typeof provider.providerId !== 'string' || /^deepseek(?:$|[-/])/i.test(provider.providerId) || seen.has(provider.providerId)) return false
            seen.add(provider.providerId)
            return true
          }).slice(0, MAX_SUBSCRIPTIONS)
          const freshMs = Number.isFinite(listed.body.freshMs) && listed.body.freshMs >= 1000 ? listed.body.freshMs : 300000
          const scopes = new Map(providers.map(provider => [provider.providerId, provider.cacheKey]))
          for (const [id, cached] of balances) {
            if (!scopes.has(id) || scopes.get(id) !== cached.cacheKey) balances.delete(id)
          }
          persistBalances()
          let subscriptions = providers.map(provider => {
            const cached = cachedBalance(provider)
            const snapshot = cached?.snapshot
            return { ...provider, snapshot: snapshot
              ? Date.now() - cached.savedAt < freshMs ? snapshot : { ...snapshot, status: 'stale' }
              : { status: 'loading' } }
          })
          const publish = () => { if (mounted.current) setState({ subscriptions }) }
          publish()
          await Promise.all(providers.map(async (provider, index) => {
            const snapshot = await queryBalance(provider, freshMs, refresh)
            subscriptions = subscriptions.map((item, i) => i === index ? { ...provider, snapshot } : item)
            publish()
          }))
        } catch {
          if (mounted.current) setState(previous => ({ subscriptions: previous?.subscriptions ?? [], error: true }))
        } finally {
          if (mounted.current) setBusy(false)
        }
      }
      useEffect(() => {
        mounted.current = true
        void load()
        return () => { mounted.current = false }
      }, [])
      if (!state || (!state.error && state.subscriptions.length === 0)) return null
      const cards = [], monetaryCards = []
      for (const { providerId, label, kind, snapshot } of state.subscriptions ?? []) {
        const balance = moneyBalance(snapshot.balance)
        if (kind === 'balance' || (balance && providerId !== 'opendesign')) {
          monetaryCards.push(h('section', { key: providerId, 'data-balance': providerId, style: styles.balanceCard },
            h('div', { style: styles.row },
              h('strong', null, (label ?? providerId) + (balance?.kind === 'credit' ? ' 可用额度' : ' 余额')),
              h('strong', { style: { fontSize: 26 } }, balance
                ? new Intl.NumberFormat('zh-CN', { style: 'currency', currency: balance.currency, currencyDisplay: 'code' }).format(balance.amount)
                : snapshot.status === 'loading' ? '正在查询余额…' : snapshot.error === 'forbidden' ? '访问被拒绝' : '未知')),
            h('div', { style: { ...styles.row, marginTop: 16 } },
              h('span', { style: styles.dim }, statusLabels[snapshot.error ?? snapshot.status] ?? '查询失败'),
              h('button', { style: styles.btn, disabled: busy, onClick: () => void load(true) }, '刷新余额')),
            providerId === 'opencode' && (snapshot.error === 'forbidden' || snapshot.staleReason === 'forbidden')
              ? h('p', { style: styles.para }, '官方计费接口返回 HTTP 403。此结果不能证明 Key 缺少权限，All 权限的 Key 也可能被拒绝。可先在 OpenCode Console 查看余额。',
                ' ', h('a', { href: 'https://opencode.ai/console', target: '_blank', rel: 'noopener noreferrer' }, '前往 OpenCode Console')) : null,
            Number.isFinite(snapshot.capturedAt) ? h('footer', { style: { ...styles.dim, marginTop: 'auto', paddingTop: 16 } },
              '更新于 ' + new Date(snapshot.capturedAt).toLocaleString()) : null))
          continue
        }
        const rows = []
        if (providerId === 'opendesign' && snapshot.plan) rows.push(h('p', { key: 'plan', style: styles.para }, snapshot.plan))
        if (providerId === 'opendesign' && balance) rows.push(h('p', { key: 'wallet', style: styles.para }, '钱包余额：' + new Intl.NumberFormat('zh-CN', { style: 'currency', currency: balance.currency }).format(balance.amount)))
        if (providerId === 'opendesign' && (snapshot.error ?? snapshot.status) === 'unsupported') rows.push(h('p', { key: 'api-key-usage', style: styles.para }, 'API Key 可用于模型调用；套餐额度查询需要 OpenDesign 账号授权。'))
        if (providerId === 'opendesign' && snapshot.warning) rows.push(h('p', { key: 'quota-warning', role: 'status', style: styles.dim }, snapshot.warning))
        for (const window of snapshot.windows ?? []) {
          const title = { primary: '5小时', secondary: '1周', rolling: '5小时', weekly: '1周', monthly: '1月' }[window.id] ?? window.label ?? window.id
          rows.push(h('div', { key: window.id, style: { ...styles.row, marginTop: 12, fontSize: 13 } },
            h('span', null, title),
            h('strong', null, Number.isFinite(window.remainingPercent) ? '剩余 ' + window.remainingPercent + '%' : '剩余额度未知')))
          if (window.resetsAt !== undefined) {
            const reset = new Date(typeof window.resetsAt === 'number' ? window.resetsAt * 1000 : window.resetsAt)
            if (Number.isFinite(reset.getTime())) rows.push(h('p', { key: window.id + '-reset', style: { ...styles.dim, margin: '6px 0 0' } }, '重置：' + reset.toLocaleString()))
          }
        }
        if (!snapshot.error && !snapshot.windows?.length && !(providerId === 'opendesign' && snapshot.status === 'unsupported')) rows.push(h('p', { key: 'unknown', style: styles.para }, snapshot.status === 'loading' ? '正在查询额度…' : '剩余额度未知'))
        cards.push(h('section', { key: providerId, 'data-subscription': providerId, style: styles.balanceCard },
          h('div', { style: styles.row }, h('strong', null, providerId === 'openai-codex' ? 'OpenAI订阅' : label ?? providerId),
            h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #aaa)' } }, statusLabels[snapshot.error ?? snapshot.status] ?? '查询失败')),
          h('div', null, rows),
          Number.isFinite(snapshot.capturedAt) ? h('footer', { style: { ...styles.dim, marginTop: 'auto', paddingTop: 16 } },
            '更新于 ' + new Date(snapshot.capturedAt).toLocaleString()) : null))
      }
      return h('section', { 'aria-label': '订阅额度', style: { width: '100%', marginTop: 20 } },
        cards.length || state.error ? h('div', { style: { ...styles.row, marginBottom: 12 } },
          h('strong', null, cards.length ? '订阅额度' : '余额信息'),
          h('button', { style: { ...styles.btn, background: 'transparent', color: 'inherit', border: '0.5px solid var(--dsw-alias-border-l3, #555)' }, disabled: busy, onClick: () => void load(true) }, busy ? '查询中…' : '刷新额度')) : null,
        state.checking ? h('p', { role: 'status', style: styles.dim }, '正在更新，暂显示上次查询结果') : null,
        state.error ? h('p', { role: 'status', style: styles.err }, '订阅额度读取失败，请重试') : null,
        cacheIssue ? h('p', { role: 'status', style: styles.err }, cacheIssue) : null,
        cards.length ? h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 12 } }, cards) : null,
        monetaryCards.length ? h('div', { 'aria-label': '账户余额', style: { display: 'grid', gridTemplateColumns: '1fr', gap: 12, marginTop: cards.length ? 20 : 0 } }, monetaryCards) : null)
    }

    const ACCOUNT_WRAPPER = Symbol.for('dsh-providers-live-models.account-balances')

    function mountAccountBalances(ctx) {
      // This DSH version has no account footer slot. Decorate the existing
      // component in place: no duplicate navigation entry and no host file edit.
      const wrapped = new Map()
      const restore = (entry, record) => {
        if (entry.component === record.component) entry.component = record.original
      }
      const update = () => {
        const entries = ctx.slots.entries('settings.section').filter(entry => entry.options.id === 'account')
        for (const [entry, record] of wrapped) {
          if (!entries.includes(entry)) { restore(entry, record); wrapped.delete(entry) }
        }
        for (const entry of entries) {
          if (wrapped.get(entry)?.component === entry.component) continue
          const original = entry.component[ACCOUNT_WRAPPER]?.original ?? entry.component
          const component = props => h('div', { style: { width: '100%' } }, h(original, props), h(SubscriptionBalances))
          component[ACCOUNT_WRAPPER] = { original }
          wrapped.set(entry, { original, component })
          entry.component = component
        }
      }
      update()
      const unsubscribe = ctx.slots.subscribe('settings.section', update)
      return () => {
        unsubscribe()
        for (const [entry, record] of wrapped) restore(entry, record)
        wrapped.clear()
      }
    }

    const STARTUP_WRAPPER = Symbol.for('dsh-providers-live-models.startup-loading')

    // The native discovery dialog adds candidates to a Map of existing rows.
    // Replace only its selection handling; retain native discovery, form edits,
    // credential handling, validation and the provider's explicit Save action.
    function ModelSelectionEditor({ native, ...props }) {
      const [picked, setPicked] = useState(null)
      const session = useRef({})
      const latest = useRef(props)
      latest.current = props
      const operations = useMemo(() => ({ ...props.operations,
        async discoverModels(...args) {
          const request = session.current
          const answer = await props.operations.discoverModels(...args)
          if (request.fetching && session.current === request && answer.kind === 'found') {
            request.candidates = answer.models
            request.initial = new Set((latest.current.models.length ? latest.current.models : answer.models).map(model => model.id))
          }
          return answer
        },
      }), [props.operations])
      const tree = native({ ...props, operations })
      const candidates = session.current.candidates ?? []
      const chosen = picked ?? session.current.initial ?? new Set()
      const ids = new Set(candidates.map(model => model.id))
      const current = new Map(props.models.map(model => [model.id, model]))
      const selected = props.models.filter(model => !ids.has(model.id) || chosen.has(model.id))
      for (const candidate of candidates) {
        if (!chosen.has(candidate.id) || current.has(candidate.id)) continue
        selected.push({ id: candidate.id,
          ...(candidate.name === undefined ? {} : { name: candidate.name }),
          ...(candidate.contextWindow === undefined ? {} : { contextWindow: candidate.contextWindow }),
          ...(candidate.maxTokens === undefined ? {} : { maxTokens: candidate.maxTokens }),
          ...(candidate.inputModalities === undefined ? {} : { input: [...candidate.inputModalities] }),
        })
      }
      const close = callback => () => { session.current = {}; setPicked(null); callback() }
      const childrenOf = node => Array.isArray(node?.props?.children) ? node.props.children : [node?.props?.children]
      const candidateId = node => {
        if (node?.type !== 'label') return undefined
        return childrenOf(node).find(child => typeof child?.props?.children === 'string' && ids.has(child.props.children))?.props.children
      }
      const rewrite = (node, visit) => {
        if (Array.isArray(node)) return node.map(child => rewrite(child, visit))
        if (!isValidElement(node)) return node
        return visit(cloneElement(node, {}, rewrite(node.props.children, visit)))
      }
      return rewrite(tree, node => {
        if (node.props.children === props.t('fetchModels') && typeof node.props.onClick === 'function') {
          return cloneElement(node, { onClick: () => {
            session.current = { fetching: true }; setPicked(null); node.props.onClick()
          } })
        }
        if (node.props.title !== props.t('fetchTitle') || !node.props.open || typeof node.props.onClose !== 'function') return node
        const visible = []
        rewrite(node.props.children, child => { const id = candidateId(child); if (id) visible.push(id); return child })
        const allVisible = visible.length > 0 && visible.every(id => chosen.has(id))
        const content = rewrite(node.props.children, child => {
          const id = candidateId(child)
          if (id) return cloneElement(child, {}, ...childrenOf(child).map(input => input?.type === 'input' && input.props.type === 'checkbox'
            ? cloneElement(input, { checked: chosen.has(id), onChange: () => setPicked(previous => {
              const next = new Set(previous ?? session.current.initial)
              if (!next.delete(id)) next.add(id)
              return next
            }) }) : input))
          if ([props.t('fetchSelectAll'), props.t('fetchDeselectAll')].includes(child.props.children)) {
            return cloneElement(child, { onClick: () => setPicked(previous => {
              const next = new Set(previous ?? session.current.initial)
              for (const id of visible) { if (allVisible) next.delete(id); else next.add(id) }
              return next
            }) }, props.t(allVisible ? 'fetchDeselectAll' : 'fetchSelectAll'))
          }
          return child
        })
        const footer = rewrite(node.props.footer, child => {
          if (child.props.children !== props.t('fetchAdopt')) return child
          return cloneElement(child, { disabled: props.disabled || selected.length === 0, onClick: () => {
            if (selected.length === 0) return
            props.onChange(selected)
            close(node.props.onClose)()
          } }, '应用选择')
        })
        return cloneElement(node, { onClose: close(node.props.onClose), footer,
          description: '勾选的模型显示在聊天列表中，取消勾选会从目录移除。应用选择后，请保存供应商设置。',
        }, content, selected.length === 0 ? h('p', { role: 'status', style: styles.err }, '请至少保留一个模型；空目录会恢复默认全部模型。') : null)
      })
    }

    const MODEL_WRAPPER = Symbol.for('dsh-providers-live-models.model-selection')

    function mountModelSelection(ctx) {
      const wrapped = new Map(), types = new WeakMap()
      // These native components form the Models-section editor path. Scope the
      // decoration to this section; no React globals or host files are patched.
      const names = new Set(['Loaded', 'ProviderEditor', 'CustomProviderCard', 'ModelListEditor'])
      const project = node => {
        if (Array.isArray(node)) return node.map(project)
        if (!isValidElement(node)) return node
        if (typeof node.type === 'function' && names.has(node.type.name)) {
          if (!types.has(node.type)) {
            const original = node.type
            types.set(original, original.name === 'ModelListEditor'
              ? props => ModelSelectionEditor({ ...props, native: original })
              : props => project(original(props)))
          }
          return h(types.get(node.type), { ...node.props, ...(node.key == null ? {} : { key: node.key }) })
        }
        return cloneElement(node, {}, project(node.props.children))
      }
      const restore = (entry, record) => { if (entry.component === record.component) entry.component = record.original }
      const update = () => {
        const entries = ctx.slots.entries('settings.section').filter(entry => entry.options.id === 'models')
        for (const [entry, record] of wrapped) if (!entries.includes(entry)) { restore(entry, record); wrapped.delete(entry) }
        for (const entry of entries) {
          if (wrapped.get(entry)?.component === entry.component) continue
          const original = entry.component[MODEL_WRAPPER]?.original ?? entry.component
          const component = props => project(original(props))
          component[MODEL_WRAPPER] = { original }
          wrapped.set(entry, { original, component }); entry.component = component
        }
      }
      update()
      const unsubscribe = ctx.slots.subscribe('settings.section', update)
      return () => { unsubscribe(); for (const [entry, record] of wrapped) restore(entry, record); wrapped.clear() }
    }

    function mountStartupLoading(ctx) {
      const wrapped = new Map()
      const restore = (entry, record) => {
        if (entry.component === record.component) entry.component = record.original
      }
      const update = () => {
        const entries = ctx.slots.entries('shell.overlay').filter(entry => entry.options.id === 'desktop-onboarding')
        for (const [entry, record] of wrapped) {
          if (!entries.includes(entry)) { restore(entry, record); wrapped.delete(entry) }
        }
        for (const entry of entries) {
          if (wrapped.get(entry)?.component === entry.component) continue
          const original = entry.component[STARTUP_WRAPPER]?.original ?? entry.component
          const component = props => {
            // Always run the native entry once, retaining its hooks, portal,
            // window-drag handling and input lock throughout startup.
            const surface = original(props)
            const status = surface?.props?.children
            if (status?.type !== 'div' || status.props?.role !== 'status'
              || status.props.children !== props.t('onboardingLoading')) return surface
            const { BrandWordmark } = require('@deepseek-ai/dsh-client-ui-primitives')
            return h(surface.type, surface.props,
              h('div', { ...status.props, style: {
                ...status.props.style, display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center', alignSelf: 'stretch',
                width: '100%', height: '100%', boxSizing: 'border-box', padding: 24, gap: 24,
                textAlign: 'center', color: 'var(--dsw-alias-label-tertiary)',
              } },
              h('div', { role: 'img', 'aria-label': props.t('onboardingBrand'),
                style: { color: 'var(--dsw-alias-label-primary)', lineHeight: 0 } },
              h(BrandWordmark, { size: 36 })),
              h('span', { style: { fontSize: 14, lineHeight: '20px' } }, status.props.children)))
          }
          component[STARTUP_WRAPPER] = { original }
          wrapped.set(entry, { original, component })
          entry.component = component
        }
      }
      update()
      const unsubscribe = ctx.slots.subscribe('shell.overlay', update)
      return () => {
        unsubscribe()
        for (const [entry, record] of wrapped) restore(entry, record)
        wrapped.clear()
      }
    }

    function GptLoginSection() {
      const [status, setStatus] = useState(null)
      const [busy, setBusy] = useState(false)
      const [code, setCode] = useState('')
      const [error, setError] = useState('')
      const load = async () => {
        try {
          const res = await request('/status')
          setStatus(res.body)
        } catch (e) {
          setError(String((e && e.message) || e).slice(0, 160))
        }
      }
      useEffect(() => { void load() }, [])
      const waiting = !!(status && status.login && status.login.status === 'waiting')
      useEffect(() => {
        if (!waiting) return undefined
        const timer = setInterval(() => { void load() }, 2500)
        return () => clearInterval(timer)
      }, [waiting])
      const startSignIn = async () => {
        setBusy(true)
        setError('')
        try {
          const res = await request('/login', { method: 'POST' })
          setStatus(res.body)
          if (res.status >= 500) setError(String((res.body && (res.body.detail || res.body.error)) || 'login failed'))
        } catch (e) {
          setError(String((e && e.message) || e).slice(0, 160))
        } finally {
          setBusy(false)
        }
      }
      const signOut = async () => {
        setBusy(true)
        setError('')
        try {
          const res = await request('/logout', { method: 'POST' })
          if (res.status >= 400) setError(statusLabels[res.body?.error] ?? '退出失败，请重试')
          else await load()
        } catch { setError('退出失败，请重试') }
        finally { setBusy(false) }
      }
      const submit = async () => {
        setBusy(true)
        setError('')
        try {
          const res = await request('/code', { method: 'POST', body: JSON.stringify({ value: code }) })
          if (!res.body || res.body.ok !== true) setError('当前没有等待粘贴的登录 / nothing is waiting')
          setCode('')
          await load()
        } catch (e) {
          setError(String((e && e.message) || e).slice(0, 160))
        } finally {
          setBusy(false)
        }
      }
      const cancel = async () => {
        setBusy(true)
        setError('')
        try {
          const res = await request('/cancel', { method: 'POST' })
          setStatus(res.body)
        } catch (e) {
          setError(String((e && e.message) || e).slice(0, 160))
        } finally {
          setBusy(false)
        }
      }
      const login = status && status.login
      const loggedIn = !!(status && status.loggedIn)
      const blocks = []
      blocks.push(h('p', { style: styles.para },
        loggedIn
          ? '已登录 ChatGPT，可在模型选择器中选择 Codex 模型。'
          : '未登录：点击下方按钮，浏览器将自动打开 ChatGPT 授权页；授权完成后由本机回调自动结束。'))
      if (waiting) {
        blocks.push(h('p', { key: 'w', style: styles.para }, '等待授权中…'))
        if (login.openUrl) {
          blocks.push(h('a', { key: 'u', href: login.openUrl, target: '_blank', rel: 'noreferrer', style: { fontSize: 13 } },
            '打开授权页 / Open authorization page'))
        }
        if (login.prompt) {
          blocks.push(h('div', { key: 'p', style: { ...styles.row, marginTop: 8 } },
            h('span', { style: { ...styles.dim, maxWidth: 420 } }, login.prompt.message + '（回调不可达时粘贴最终跳转地址）'),
            h('div', { style: { display: 'flex', gap: 8, marginTop: 6 } },
              h('input', {
                style: styles.input, value: code, placeholder: 'http://localhost:1455/auth/callback?...',
                onChange: e => setCode(e.target.value),
              }),
              h('button', {
                style: { ...styles.btn, ...styles.primary },
                disabled: busy || code.trim() === '',
                onClick: () => void submit(),
              }, '提交 / Submit'))))
        }
        blocks.push(h('button', {
          key: 'c', style: { ...styles.btn, ...styles.ghost, marginTop: 8 },
          disabled: busy, onClick: () => void cancel(),
        }, '取消登录 / Cancel'))
      } else {
        if (login && login.status === 'error') {
          blocks.push(h('p', { key: 'e', style: { ...styles.para, ...styles.err } }, '上次登录失败：' + (login.detail || 'unknown')))
        }
        // Same two actions as the other cards: sign in again, or sign out.
        blocks.push(h('div', { key: 'b', style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
          h('button', { style: { ...styles.btn, ...styles.primary }, disabled: busy, onClick: () => void startSignIn() },
            busy ? '请稍候…' : loggedIn ? '重新登录' : '使用 ChatGPT 账号登录 / Sign in with ChatGPT'),
          loggedIn ? h('button', { style: { ...styles.btn, ...styles.ghost }, disabled: busy,
            onClick: () => {
              if (typeof window.confirm === 'function' && window.confirm('只清除 ChatGPT 登录？其他提供方的登录保持不变。')) void signOut()
            } }, '退出登录') : null))
      }
      if (error) blocks.push(h('p', { key: 'er', style: { ...styles.para, ...styles.err } }, error))
      return h('div', { style: styles.card },
        h('div', { style: styles.row },
          h('strong', null, 'ChatGPT 登录'),
          h('span', { style: styles.dim }, waiting ? '等待授权' : loggedIn ? '已登录' : '未登录')),
        blocks)
    }

    function OpenCodeLoginSection() {
      const [status, setStatus] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const load = async () => {
        try {
          const result = await request('/opencode/status')
          if (result.status >= 400) throw new Error('OpenCode 登录服务尚未就绪')
          setStatus(result.body)
        } catch { setError('OpenCode 登录状态读取失败，请重试') }
      }
      useEffect(() => { void load() }, [])
      const waiting = status?.login?.status === 'waiting' || status?.login?.status === 'starting'
      useEffect(() => {
        if (!waiting) return undefined
        const timer = setInterval(() => { void load() }, 2500)
        return () => clearInterval(timer)
      }, [waiting])
      const action = async path => {
        setBusy(true); setError('')
        try {
          const result = await request('/opencode/' + path, { method: 'POST' })
          setStatus(result.body)
          if (result.status >= 400) setError(result.body?.login?.detail ?? 'OpenCode 登录操作失败，请重试')
        } catch { setError('OpenCode 登录请求失败，请重试') }
        finally { setBusy(false) }
      }
      return h('section', { style: styles.card, 'data-opencode-login': true },
        h('div', { style: styles.row }, h('strong', null, 'OpenCode Console 登录'),
          h('span', { style: styles.dim }, waiting ? '等待授权' : status?.loggedIn ? '已登录' : '未登录')),
        h('p', { style: styles.para }, status?.loggedIn
          ? '已登录 OpenCode Console，可返回“账号与余额”刷新 Zen 余额。'
          : '用于读取 OpenCode Zen 余额。请在官方授权页面选择与你的 Zen Key 相同的工作区。'),
        waiting ? h('div', null,
          h('p', { style: styles.para }, '设备授权码：', h('strong', null, status?.login?.userCode ?? '…')),
          h('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' } },
            status?.login?.openUrl ? h('a', { href: status.login.openUrl, target: '_blank', rel: 'noopener noreferrer',
              style: { ...styles.btn, ...styles.primary, textDecoration: 'none', display: 'inline-block' } }, '打开授权页') : null,
            h('button', { style: { ...styles.btn, ...styles.ghost }, disabled: busy, onClick: () => void action('cancel') }, '取消登录')))
          : h('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
            h('button', { style: { ...styles.btn, ...styles.primary }, disabled: busy, onClick: () => void action('login') },
              busy ? '请稍候…' : status?.loggedIn ? '重新登录' : '登录 OpenCode Console'),
            status?.loggedIn ? h('button', { style: { ...styles.btn, ...styles.ghost }, disabled: busy,
              onClick: () => {
                if (typeof window.confirm === 'function' && window.confirm('只清除 OpenCode Console 登录？其他提供方的登录保持不变。')) void action('logout')
              } }, '退出登录') : null),
        status?.login?.detail ? h('p', { style: { ...styles.para, ...styles.err } }, status.login.detail) : null,
        error ? h('p', { role: 'status', style: { ...styles.para, ...styles.err } }, error) : null)
    }

    function OpenDesignLoginSection() {
      const [status, setStatus] = useState(null)
      const [busy, setBusy] = useState(false)
      const [apiKey, setApiKey] = useState('')
      const [error, setError] = useState('')
      const [catalog, setCatalog] = useState(null)
      const [catalogError, setCatalogError] = useState('')
      // Which sign-in path the user picked: null shows both, one shows only that one.
      const [mode, setMode] = useState(null)
      // Draft selection: checkbox clicks stay local until Save posts them once.
      const [draft, setDraft] = useState(null)
      const mounted = useRef(true)
      const load = async () => {
        try {
          const result = await request('/opendesign/status')
          if (result.status >= 400) throw new Error('unavailable')
          if (mounted.current) setStatus(result.body)
        } catch { if (mounted.current) setError('OpenDesign 状态读取失败，请重试') }
      }
      useEffect(() => {
        mounted.current = true
        void load()
        return () => { mounted.current = false }
      }, [])
      const waiting = status?.login?.status === 'waiting' || status?.login?.status === 'starting'
      useEffect(() => {
        if (!waiting && status?.models?.state !== 'loading') return undefined
        const timer = setInterval(() => { void load() }, 2500)
        return () => clearInterval(timer)
      }, [waiting, status?.models?.state])
      const loadModels = async () => {
        setCatalogError('')
        try {
          const result = await request('/opendesign/models')
          if (result.status >= 400) throw new Error('unavailable')
          if (mounted.current) setCatalog(result.body)
        } catch { if (mounted.current) setCatalogError('模型列表读取失败，请重试') }
      }
      useEffect(() => {
        if (status?.loggedIn !== true) { setCatalog(null); return }
        void loadModels()
      }, [status?.loggedIn, status?.models?.modelCount])
      const savedIds = () => (catalog?.models ?? []).filter(model => model.enabled !== false).map(model => model.id)
      const activeIds = () => draft ?? savedIds()
      const dirty = draft !== null && [...draft].sort().join('\u0000') !== [...savedIds()].sort().join('\u0000')
      /** Persist the whole set once; the page reloads the roster only after this. */
      const saveSelection = async () => {
        if (draft === null) return
        const pending = [...draft]
        setBusy(true); setError('')
        try {
          const result = await request('/opendesign/models/enabled', { method: 'POST', body: JSON.stringify({ enabledModels: draft }) })
          if (result.status >= 400) setError(statusLabels[result.body?.error] ?? '模型开关未保存，请重试')
          else {
            setStatus(result.body)
            // Reflect the saved set in place before clearing the draft, otherwise
            // the switches fall back to the stale catalog for one render.
            const kept = new Set(pending)
            setCatalog(previous => previous === null ? previous
              : { ...previous, models: previous.models.map(model => ({ ...model, enabled: kept.has(model.id) })) })
            setDraft(null)
            await loadModels()
          }
        } catch { if (mounted.current) setError('模型开关保存失败，请重试') }
        finally { if (mounted.current) setBusy(false) }
      }
      const toggleModel = (id, enabled) => {
        const current = activeIds()
        setDraft(enabled ? [...new Set([...current, id])] : current.filter(value => value !== id))
      }
      const toggleAll = enabled => {
        setDraft(enabled ? (catalog?.models ?? []).map(model => model.id) : [])
      }
      const action = async (path, body = {}) => {
        setBusy(true); setError('')
        try {
          const result = await request('/opendesign/' + path, { method: 'POST', body: JSON.stringify(body) })
          if (mounted.current) {
            if (result.status >= 400) setError(statusLabels[result.body?.error] ?? 'OpenDesign 操作未完成，请重试')
            else setStatus(result.body)
          }
        } catch { if (mounted.current) setError('OpenDesign 请求失败，请重试') }
        finally { if (mounted.current) { setBusy(false); if (path === 'key') setApiKey('') } }
      }
      const login = status?.login
      const models = status?.models
      const count = models?.modelCount ?? models?.count ?? models?.models?.length
      return h('section', { style: styles.card, 'data-opendesign-login': true },
        h('div', { style: styles.row }, h('strong', null, 'OpenDesign Cloud'),
          h('span', { style: styles.dim }, waiting ? '等待授权' : status?.loggedIn ? status.mode === 'account' ? '账号已授权' : '已配置 API Key' : '未登录')),
        h('p', { style: styles.para }, status?.loggedIn
          ? (status.mode === 'account'
            ? '已登录 OpenDesign 账号，可在模型选择器中选择 OpenDesign 模型。'
            : '已配置 API Key，可在模型选择器中选择 OpenDesign 模型；查看套餐额度需要账号授权。')
          : '未登录：用账号授权或 API Key 二选一，授权后即可在模型选择器中使用模型。'),
        // Two sign-in paths are offered while signed out; once one is under way the
        // other is withdrawn until the user cancels it, so the card never asks for
        // two credentials at once.
        mode === null && !waiting && !status?.loggedIn ? h('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
          h('button', { style: { ...styles.btn, ...styles.primary }, disabled: busy,
            onClick: () => { setMode('account'); void action('login') } }, '使用账号授权'),
          h('button', { style: styles.btn, disabled: busy,
            onClick: () => setMode('key') }, '使用 API Key')) : null,
        mode === 'key' && !status?.loggedIn ? h('div', null,
          h('div', { style: { ...styles.row, marginTop: 12 } },
            h('input', { type: 'password', autoComplete: 'new-password', spellCheck: false, style: styles.input,
              value: apiKey, placeholder: 'OpenDesign API Key', 'aria-label': 'OpenDesign API Key',
              onChange: event => setApiKey(event.target.value) }),
            h('button', { style: styles.btn, disabled: busy || !apiKey.trim(), onClick: () => void action('key', { apiKey }) }, '保存 API Key'),
            h('button', { style: { ...styles.btn, ...styles.ghost }, disabled: busy,
              onClick: () => { setMode(null); setApiKey('') } }, '取消')),
          h('p', { style: styles.dim }, '没有浏览器可用时用这种方式；它只用于调用模型，不显示套餐额度。Key 不会回显或保存在浏览器缓存。')) : null,
        waiting ? h('div', null,
          h('p', { style: styles.para }, '设备授权码：', h('strong', null, login?.userCode ?? '…')),
          // The link and the cancel action share one row so they never overlap, and the
          // link wears the button style: two controls of equal weight, no wrapper text.
          h('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' } },
            login?.openUrl ? h('a', { href: login.openUrl, target: '_blank', rel: 'noopener noreferrer',
              style: { ...styles.btn, ...styles.primary, textDecoration: 'none', display: 'inline-block' } }, '打开授权页') : null,
            h('button', { style: { ...styles.btn, ...styles.ghost }, disabled: busy,
              onClick: () => { setMode(null); void action('cancel') } }, '取消登录'))) : null,
        // Same shape as the ChatGPT and OpenCode cards: one primary action, with the
        // destructive one beside it. Model discovery lives in the unified catalog.
        status?.loggedIn ? h('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
          h('button', { style: { ...styles.btn, ...styles.primary }, disabled: busy,
            onClick: () => { setMode(null); void action('login') } }, '重新登录'),
          h('button', { style: { ...styles.btn, ...styles.ghost }, disabled: busy, onClick: () => {
            if (typeof window.confirm === 'function' && window.confirm('只清除 OpenDesign 凭据？其他提供方的登录保持不变。')) void action('logout')
          } }, '退出登录')) : null,
        login?.detail ? h('p', { role: 'status', style: { ...styles.para, ...styles.err } }, login.detail) : null,
        models?.state === 'error' || models?.state === 'unavailable' || models?.error ? h('p', { role: 'status', style: { ...styles.para, ...styles.err } }, models.message ?? 'OpenDesign 模型目录暂不可用；原有提供方保持不变。') : null,
        error ? h('p', { role: 'status', style: { ...styles.para, ...styles.err } }, error) : null)
    }

    /**
     * Model switches for the routes this plugin overlays (OpenCode Go, OpenCode
     * Zen, OpenAI Codex). Same interaction as the OpenDesign card: edits stay in a
     * local draft, one Save posts the whole set, and only then is the roster
     * reloaded.
     */
    /**
     * Model switches for the routes this plugin overlays. OpenCode GO and the Zen
     * gateway are two channels of one provider, so they share a card; Codex gets
     * its own. Edits stay in a draft and one Save posts each changed channel.
     */
    function RouteModelSection() {
      const [routes, setRoutes] = useState(null)
      const [draft, setDraft] = useState({})
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      // Which channel lists are open. Presentation only; never persisted.
      const [expanded, setExpanded] = useState({})
      // Which provider groups are open. Also presentation only.
      const [groupsOpen, setGroupsOpen] = useState({})
      const mounted = useRef(true)

      const load = async () => {
        try {
          // These routes live beside the OpenDesign ones: the server mounts every
          // handler under /dsh-providers-live-models/opendesign.
          const result = await request('/opendesign/routes')
          if (result.status >= 400) throw new Error('unavailable')
          if (mounted.current) { setRoutes(result.body); setDraft({}) }
        } catch { if (mounted.current) setError('模型列表读取失败，请重试') }
      }
      useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false } }, [])

      const selectionOf = route => draft[route.id] ?? route.models.filter(model => model.enabled !== false).map(model => model.id)
      const dirty = (routes?.routes ?? []).some(route => draft[route.id] !== undefined
        && [...draft[route.id]].sort().join('\u0000')
          !== [...route.models.filter(model => model.enabled !== false).map(model => model.id)].sort().join('\u0000'))

      const toggle = (route, id, on) => {
        const current = selectionOf(route)
        setDraft(previous => ({ ...previous, [route.id]: on ? [...new Set([...current, id])] : current.filter(value => value !== id) }))
      }
      const toggleAll = (route, on) => {
        setDraft(previous => ({ ...previous, [route.id]: on ? route.models.map(model => model.id) : [] }))
      }
      const save = async () => {
        setBusy(true); setError('')
        try {
          for (const route of routes?.routes ?? []) {
            if (draft[route.id] === undefined) continue
            const result = await request('/opendesign/routes/enabled', { method: 'POST',
              body: JSON.stringify({ provider: route.id, enabledModels: draft[route.id] }) })
            if (result.status >= 400) { setError(statusLabels[result.body?.error] ?? '保存失败，请重试'); return }
          }
          setDraft({})
          await load()
        } catch { if (mounted.current) setError('保存失败，请重试') }
        finally { if (mounted.current) setBusy(false) }
      }

      const switchFor = (route, model) => {
        const on = selectionOf(route).includes(model.id)
        return h('li', { key: model.id, 'data-route-model': model.id,
          style: { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', margin: '4px 0', borderRadius: 10,
            background: on ? 'var(--dsw-alias-settings-card-fill, rgba(127,127,127,0.05))' : 'transparent',
            border: '0.5px solid ' + (on ? 'var(--dsw-alias-border-l3, #e5e5ea)' : 'transparent'),
            opacity: on ? 1 : 0.5 } },
          h('span', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 } },
            h('strong', { style: { fontWeight: 600, fontSize: 13.5 } }, model.name),
            Number.isFinite(model.contextWindow) ? h('span', { style: { fontSize: 11.5, color: 'var(--dsw-alias-label-tertiary, #8e8e93)' } },
              model.contextWindow.toLocaleString() + ' 上下文') : null),
          h('label', { style: { position: 'relative', display: 'inline-flex', alignItems: 'center', width: 42, height: 25, flex: 'none', cursor: 'pointer' } },
            h('input', { type: 'checkbox', checked: on, 'aria-label': '启用 ' + model.name,
              style: { position: 'absolute', opacity: 0, width: '100%', height: '100%', margin: 0, cursor: 'pointer' },
              onChange: event => toggle(route, model.id, event.target.checked) }),
            h('span', { 'aria-hidden': 'true', style: { position: 'absolute', inset: 0, borderRadius: 999,
              background: on ? '#34c759' : 'rgba(120,120,128,0.32)', transition: 'background 160ms ease' } }),
            h('span', { 'aria-hidden': 'true', style: { position: 'absolute', top: 2, left: on ? 19 : 2, width: 21, height: 21,
              borderRadius: '50%', background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.28)',
              transition: 'left 160ms cubic-bezier(0.4, 0.0, 0.2, 1)' } })))
      }

      const channel = (route, first) => {
        const open = expanded[route.id] === true
        return h('div', { key: route.id, 'data-route': route.id,
          style: { marginTop: first ? 8 : 14, paddingTop: first ? 0 : 12,
            borderTop: first ? 'none' : '0.5px solid var(--dsw-alias-border-l3, #e5e5ea)' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('strong', { style: { fontSize: 12.5, fontWeight: 600 } }, route.label),
            h('span', { style: styles.dim }, selectionOf(route).length + ' / ' + route.models.length),
            route.note ? h('span', { style: { ...styles.dim, color: 'var(--dsw-alias-state-warn-label, #b26a00)' } }, route.note) : null,
            // Expand and collapse only change what is shown: the draft is untouched,
            // so collapsing can never save or discard an edit.
            h('button', { style: { ...styles.btn, marginLeft: 'auto' },
              'data-toggle-route': route.id,
              onClick: event => { event?.preventDefault?.(); setExpanded(previous => ({ ...previous, [route.id]: !open })) } },
              open ? '收起' : '展开'),
            h('button', { style: { ...styles.btn }, disabled: busy,
              onClick: event => { event?.preventDefault?.(); toggleAll(route, selectionOf(route).length !== route.models.length) } },
              selectionOf(route).length === route.models.length ? '全部关闭' : '全部开启')),
          open ? h('ul', { style: { margin: '6px 0 0', padding: 0, listStyle: 'none', fontSize: 13 } },
            route.models.map(model => switchFor(route, model)))
            : h('p', { style: { ...styles.dim, margin: '6px 0 0' } }, '已收起，点「展开」查看这 ' + route.models.length + ' 个模型'))
      }

      // One list per provider family. A new provider joins this table and its
      // group appears with the same switch UI — no per-provider card to maintain.
      const groups = [['opencode', 'OpenCode', ['opencode-go', 'opencode']],
        ['openai-codex', 'OpenAI', ['openai-codex']],
        ['opendesign', 'OpenDesign', ['opendesign']]]
      const cards = groups.map(([key, title, ids]) => {
        const members = ids.map(id => (routes?.routes ?? []).find(route => route.id === id)).filter(route => route !== undefined)
        if (members.length === 0) return null
        // The group header is a plain control rather than <details>, so its label can
        // follow the state: a native summary cannot change its own text.
        const open = groupsOpen[key] === true
        return h('section', { key, 'data-provider-group': key, style: { marginTop: 12 } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 500, lineHeight: '20px',
            color: 'var(--dsw-alias-label-primary, inherit)' } },
            h('span', null, title),
            h('span', { style: styles.dim }, members.length + ' 个渠道'),
            h('button', { style: { ...styles.btn, marginLeft: 'auto' }, 'data-toggle-group': key,
              onClick: event => { event?.preventDefault?.(); setGroupsOpen(previous => ({ ...previous, [key]: !open })) } },
              open ? '收起' : '展开')),
          open ? h('div', null, members.map((route, index) => channel(route, index === 0)))
            : h('p', { style: { ...styles.dim, margin: '6px 0 0' } }, '已收起，点「展开」查看这 ' + members.length + ' 个渠道'))
      })

      const anyModels = (routes?.routes ?? []).some(route => route.models.length > 0)
      return h('section', { style: styles.card, 'data-route-models': true },
        h('div', { style: styles.row }, h('strong', null, '模型展示'),
          h('button', { style: styles.btn, disabled: busy, onClick: () => { setDraft({}); void load() } }, '刷新列表')),
        h('p', { style: styles.para }, '这些开关决定会话的模型下拉里显示哪些模型；关闭的模型不会出现在选择器中。所有供应商的模型都在这里统一管理。'),
        anyModels ? cards : h('p', { style: styles.para }, '尚未读取到 OpenCode 或 OpenAI 的模型目录；先在模型页确认这些供应商已登录，再点「刷新列表」。'),
        h('div', { style: { display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginTop: 10 } },
          dirty ? h('span', { role: 'status', style: { ...styles.dim, marginRight: 'auto' } }, '有未保存的改动') : null,
          h('button', { style: { ...styles.btn, ...(dirty ? styles.primary : {}) }, disabled: busy || !dirty,
            onClick: () => void save() }, dirty ? '保存选择' : '已保存')),
        error ? h('p', { role: 'status', style: { ...styles.para, ...styles.err } }, error) : null)
    }

    function PluginSettings() {
      return h('div', null, h(GptLoginSection), h(OpenCodeLoginSection), h(OpenDesignLoginSection), h(RouteModelSection))
    }

    /** Required client services. */
    const inject = ['slots']

    /**
     * Register login directly in this package's sidebar plugin detail page.
     * @param {any} ctx - browser Cordis context.
     */
    function apply(ctx) {
      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: 'dsh-providers-live-models',
      }, PluginSettings))
      ctx.slots.inject('settings.section', () => mountAccountBalances(ctx))
      ctx.slots.inject('settings.section', () => mountModelSelection(ctx))
      ctx.slots.inject('shell.overlay', () => mountStartupLoading(ctx))
    }

    return { inject, apply }
  },
})
