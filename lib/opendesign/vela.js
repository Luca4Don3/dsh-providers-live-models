/**
 * Quota through the OpenDesign desktop app's own `vela` CLI.
 *
 * `vela` already holds the desktop login, so this channel needs no credential
 * from this plugin. It is a private CLI, not a published contract: every field is
 * validated, and a surprise degrades to an explicit error instead of a number.
 *
 * Discovery is deliberately narrow — an explicit override, then the official
 * install directory, then PATH — because this module executes what it finds.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { QuotaError } from '../subscription/errors.js'

const CALL_TIMEOUT_MS = 15000
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024

/** Credits per US dollar as the Go plan publishes them. */
export const FALLBACK_CREDITS_PER_USD = 10000

function binaryName() {
  return platform() === 'win32' ? 'vela.exe' : 'vela'
}

function installRoots() {
  if (platform() === 'win32') {
    const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
    return [join(local, 'Programs', 'Open Design', 'resources', 'open-design', 'bin')]
  }
  if (platform() === 'darwin') return ['/Applications/Open Design.app/Contents/Resources/open-design/bin']
  return [join(homedir(), '.local', 'share', 'open-design', 'bin')]
}

/**
 * Find the executable, preferring the copy that shares the app's login.
 * @returns {{path: string, via: 'env'|'open-design-install'|'path'} | undefined}
 */
export function locateVela({ env = process.env, exists = existsSync, roots = installRoots() } = {}) {
  const override = (env.OPENDESIGN_VELA_PATH ?? '').trim()
  if (override.length > 0 && exists(override)) return { path: override, via: 'env' }
  for (const root of roots) {
    const candidate = join(root, binaryName())
    if (exists(candidate)) return { path: candidate, via: 'open-design-install' }
  }
  const onPath = (env.PATH ?? '').split(platform() === 'win32' ? ';' : ':')
    .map(entry => entry.trim()).filter(entry => entry.length > 0)
    .map(entry => join(entry, binaryName())).find(candidate => exists(candidate))
  return onPath === undefined ? undefined : { path: onPath, via: 'path' }
}

function run(exec, binary, args, signal) {
  return new Promise((resolve, reject) => {
    exec(binary, args, { timeout: CALL_TIMEOUT_MS, windowsHide: true, maxBuffer: MAX_OUTPUT_BYTES, signal },
      (error, stdout) => {
        if (error !== null && error !== undefined) {
          reject(new QuotaError(signal?.aborted ? 'timeout' : 'network', 'vela 调用失败，请确认已在 OpenDesign 桌面端登录'))
          return
        }
        const text = String(stdout ?? '').trim()
        if (text.length === 0) { reject(new QuotaError('invalid-response', 'vela 没有输出')); return }
        try { resolve(JSON.parse(text)) }
        catch { reject(new QuotaError('invalid-response', 'vela 的输出不是 JSON')) }
      })
  })
}

const number = value => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())) return Number(value)
  return undefined
}
const text = value => typeof value === 'string' && value.trim() ? value.trim() : undefined

/** Only a plausible workspace id is tried; a stray value would look like a login fault. */
function workspaceIdOf(value) {
  return typeof value === 'string' && /^[a-z0-9]{16,32}$/.test(value.trim()) ? value.trim() : undefined
}

function windowOf(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const duration = number(raw.durationSeconds)
  const used = number(raw.usedCredits)
  const limit = number(raw.limitCredits)
  if (duration === undefined || used === undefined || limit === undefined || duration <= 0 || limit <= 0) return undefined
  return {
    durationSeconds: duration,
    usedCredits: String(raw.usedCredits),
    limitCredits: String(raw.limitCredits),
    ...(text(raw.remainingCredits) ? { remainingCredits: text(raw.remainingCredits) } : {}),
    ...(text(raw.resetsAt) ? { resetsAt: text(raw.resetsAt) } : {}),
  }
}

/**
 * Read windows through `vela`, or report why it could not.
 * @returns {Promise<{usage: object, summary: object}>} shaped for the shared normalizer.
 */
export async function readVelaQuota({ binary, workspaceId, exec, signal } = {}) {
  const runExec = exec ?? execFile
  let workspace = workspaceIdOf(workspaceId)
  if (workspace === undefined) {
    const listed = await run(runExec, binary, ['team-projects', 'list'], signal)
    workspace = workspaceIdOf(listed?.workspaceId)
  }
  if (workspace === undefined) {
    throw new QuotaError('invalid-response', '未能从 vela 取得工作空间 ID，请确认已在 OpenDesign 桌面端登录')
  }
  const funding = await run(runExec, binary, ['billing', 'funding-check', '--workspace-id', workspace, '--format', 'json'], signal)
  const plan = funding?.codingPlan
  if (plan === undefined || plan === null) throw new QuotaError('invalid-response', 'vela 未返回套餐信息')
  const windows = Array.isArray(plan.windows) ? plan.windows.map(windowOf).filter(Boolean) : []
  if (windows.length === 0) throw new QuotaError('invalid-response', 'vela 未返回任何有效的额度窗口')
  let summary = { ...(text(funding?.balanceUsd) ? { balanceUsd: text(funding.balanceUsd) } : {}) }
  try {
    const extra = await run(runExec, binary, ['billing', 'summary', '--format', 'json'], signal)
    if (summary.balanceUsd === undefined && text(extra?.balanceUsd)) summary.balanceUsd = text(extra.balanceUsd)
    if (number(extra?.creditsPerUsd) !== undefined) summary.creditsPerUsd = number(extra.creditsPerUsd)
  } catch { summary.creditsPerUsd = FALLBACK_CREDITS_PER_USD }
  if (text(plan.tier)) summary.membershipTier = text(plan.tier)
  return { usage: { eligible: plan.eligible !== false, windows }, summary }
}

/**
 * A quota source bound to this machine's `vela`, discovered once.
 * @returns {{available: boolean, via?: string, path?: string, read: Function}}
 */
export function createVelaQuotaSource({ env, exists, roots, exec, workspaceId } = {}) {
  const found = locateVela({ ...(env === undefined ? {} : { env }), ...(exists === undefined ? {} : { exists }), ...(roots === undefined ? {} : { roots }) })
  return {
    available: found !== undefined,
    ...(found === undefined ? {} : { via: found.via, path: found.path }),
    read: ({ signal } = {}) => {
      if (found === undefined) throw new QuotaError('unsupported', '未找到 OpenDesign 桌面端自带的 vela，无法用本机登录读取额度')
      return readVelaQuota({ binary: found.path, workspaceId, exec, signal })
    },
  }
}
