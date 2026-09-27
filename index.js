// dsh-model-usage-widget — static host half (composition plugin row).
//
// Same static dual-face shape as dsh-ark-usage-widget (no dynamic Cordis
// runner, no per-start conversation wake):
//
//   - HOST half (this module): registers GET /model-usage on the web server
//     (same origin as the GUI), guarded by the connection trust fence. The
//     route reads the model provider list from the settings service — the
//     `llm-deepseek` namespace (builtin DeepSeek route) plus the `llm-pi-ai`
//     namespace (`providers` dict, exactly what the 模型 panel edits) —
//     resolves each provider's API key through the credentials seam (plain
//     strings are valid credential refs at runtime; branding is compile-time
//     only), then queries per-provider usage:
//
//       deepseek        GET https://api.deepseek.com/user/balance (Bearer)
//       minimax-cn      GET https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains
//                       (remaining-percent semantics: usage = 100 - remaining)
//       volcengine-ark  coding-plan quota is SSO-bound (not API-key queryable):
//                       usage is read through the local `arkcli` CLI (usage plan
//                       + seat milestones, 60s cache) and the 登录认证 button
//                       POSTs /model-usage/ark-login, which spawns
//                       `arkcli auth login volc-sso` (browser SSO with local
//                       loopback callback) — the dsh-ark-usage-widget way
//
//   - CLIENT half (src/client.js → lib/client.js): a static browser plugin
//     declared via `dsh.client` + `exports["./client"]` rendering one
//     sidebar footer row per provider in the same `sidebar.footer.action`
//     slot the ark widget used, with the auth jump button after the usage.
//
// Fail-soft: nothing here may throw into composition startup; a missing
// service or provider failure degrades into the structured status payload
// the client renders (未配置 / 未授权 / 获取失败 with a retry button).

import { createHash, createHmac } from 'node:crypto'

const CACHE_TTL_MS = 60000
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

export const name = 'dsh-model-usage-widget'
export const inject = ['webServer', 'connection', 'settings', 'credentials', 'subprocess']

/** Route served to the browser widget; GET /model-usage, optional ?force=1. */
export const MODEL_USAGE_ROUTE = '/model-usage'

/** POST /model-usage/ark-login: spawn `arkcli auth login volc-sso` on the host. */
export const ARK_LOGIN_ROUTE = MODEL_USAGE_ROUTE + '/ark-login'

const MINIMAX_HOSTS = { 'minimax-cn': 'api.minimaxi.com', 'minimax': 'api.minimax.io' }
const AUTH_URLS = {
  'deepseek-official': 'https://platform.deepseek.com/',
  'minimax-cn': 'https://platform.minimaxi.com/',
  'minimax': 'https://www.minimax.io/',
  'volcengine-ark': 'https://console.volcengine.com/ark',
  'stepfun': 'https://platform.stepfun.com/',
}
const PRETTY_NAMES = { 'minimax-cn': 'MiniMax', 'minimax': 'MiniMax', 'volcengine-ark': '火山方舟' }

function connectionOf(ctx) {
  return Reflect.get(ctx, 'connection')
}

function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

function shortErr(err) {
  const text = String(err && err.message ? err.message : err)
  return text.length > 200 ? text.slice(0, 200) : text
}

function num(v) {
  const n = Number(v)
  return isFinite(n) ? n : null
}

function clampPercent(v) {
  return Math.round(Math.max(0, Math.min(100, v)) * 100) / 100
}

function toIso(ms) {
  const n = Number(ms)
  return isFinite(n) && n > 0 ? new Date(n).toISOString() : null
}

function cyclePercentOf(resetAtIso, windowMs) {
  if (!resetAtIso || !(windowMs > 0)) return null
  const end = Date.parse(resetAtIso)
  if (!isFinite(end)) return null
  const start = end - windowMs
  return clampPercent(((Date.now() - start) / (end - start)) * 100)
}

export function apply(ctx) {
  const fetcher = createFetcher(ctx)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: MODEL_USAGE_ROUTE,
    handler: async (req, res) => {
      const connection = connectionOf(ctx)
      const rejection = connection === undefined ? undefined : connection.requestRejection(req)
      if (rejection !== undefined) {
        res.statusCode = rejection
        res.end()
        return
      }
      if (req.method !== 'GET') {
        res.statusCode = 405
        res.setHeader('allow', 'GET')
        res.end()
        return
      }
      // Node always sets url on server requests; String keeps that fact local.
      const url = new URL(String(req.url), 'http://localhost')
      const force = url.searchParams.get('force') === '1'
      sendJson(res, 200, await fetcher.fetch(force))
    },
  }), 'dsh-model-usage-widget: GET /model-usage')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ARK_LOGIN_ROUTE,
    handler: async (req, res) => {
      const connection = connectionOf(ctx)
      const rejection = connection === undefined ? undefined : connection.requestRejection(req)
      if (rejection !== undefined) {
        res.statusCode = rejection
        res.end()
        return
      }
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end()
        return
      }
      sendJson(res, 200, await fetcher.arkLogin())
    },
  }), 'dsh-model-usage-widget: POST /model-usage/ark-login')
}

// ── provider config + per-provider usage fetchers ───────────────────────────

function createFetcher(ctx) {
  /** 递归物化 cordis Config：嵌套值可能是带 .get() 的包装器，JSON.stringify 会静默丢内容。 */
  function materializeConfig(v, depth) {
    if (depth > 6 || v === null || typeof v !== 'object') return v
    let cur = v
    try { if (typeof cur.get === 'function') cur = cur.get() } catch (e) {}
    if (cur === null || typeof cur !== 'object') return cur
    if (Array.isArray(cur)) return cur.map(function (x) { return materializeConfig(x, depth + 1) })
    const out = {}
    for (const k of Object.keys(cur)) {
      if (k === 'get' && typeof cur[k] === 'function') continue
      out[k] = materializeConfig(cur[k], depth + 1)
    }
    return out
  }

  function settingsGet(ns) {
    // DSH 0.1.5: SettingsForms.get(ns) 直读命名空间。0.1.7 起该方法被移除
    // （只剩 describe/update/replace/mutate），命名空间 = profile entry id，
    // 活配置要走 configEditor：configuration()[].entry.fiber.config，
    // 或 settings.describe() 里 ns 匹配的 descriptor.value（需条目有表单 schema）。
    try {
      const settings = Reflect.get(ctx, 'settings')
      if (settings && typeof settings.get === 'function') return settings.get(ns)
    } catch (e) {}
    try {
      const editor = typeof ctx.get === 'function' ? ctx.get('configEditor') : Reflect.get(ctx, 'configEditor')
      if (editor && typeof editor.configuration === 'function') {
        const row = editor.configuration().find(function (r) {
          return r && r.entry && r.entry.options && r.entry.options.id === ns
        })
        if (row) {
          // a) 用户补丁层 override：纯对象（structuredClone 自补丁文件），
          //    设置面板写入（settings.update → configEditor.edit）也落在这层。优先。
          const ov = row.override
          if (ov && typeof ov === 'object' && Object.keys(ov).length > 0) {
            try { return JSON.parse(JSON.stringify(ov)) } catch (e) {}
          }
          // b) 活配置 fiber.config：cordis 响应式包装，嵌套值是带 .get() 的
          //    Config 包装器（JSON.stringify 会静默丢成 {}），递归物化。
          const cfg = row.entry && row.entry.fiber ? row.entry.fiber.config : undefined
          const plain = materializeConfig(cfg, 0)
          if (plain && typeof plain === 'object' && Object.keys(plain).length > 0) return plain
        }
      }
    } catch (e) {}
    try {
      const settings = Reflect.get(ctx, 'settings')
      if (settings && typeof settings.describe === 'function') {
        const hit = settings.describe().find(function (d) { return d && d.ns === ns })
        if (hit && hit.value && typeof hit.value === 'object') return hit.value
      }
    } catch (e) {}
    return undefined
  }

  async function resolveKey(refName) {
    if (typeof refName !== 'string' || !REF_PATTERN.test(refName)) return null
    try {
      const credentials = Reflect.get(ctx, 'credentials')
      if (credentials && typeof credentials.resolve === 'function') {
        const hit = await credentials.resolve(refName)
        if (hit && typeof hit.value === 'string' && hit.value) return hit.value
      }
    } catch (e) {}
    try {
      const env = typeof process !== 'undefined' && process.env ? process.env[refName] : undefined
      if (typeof env === 'string' && env) return env
    } catch (e) {}
    return null
  }

  // Which usage strategy applies to a custom (llm-pi-ai) provider. Known
  // shapes win by id; a declared baseURL is the fallback signal.
  function classify(id, p) {
    const lower = String(id).toLowerCase()
    if (MINIMAX_HOSTS[id]) return 'minimax'
    if (id === 'volcengine-ark' || id === 'ark' || lower.indexOf('volcengine') === 0) return 'ark'
    const base = p && typeof p.baseURL === 'string' ? p.baseURL.toLowerCase() : ''
    if (lower.indexOf('deepseek') >= 0 || base.indexOf('deepseek.com') >= 0) return 'deepseek'
    if (lower.indexOf('stepfun') >= 0 || base.indexOf('stepfun.com') >= 0) return 'stepfun'
    if (base.indexOf('minimaxi.com') >= 0 || base.indexOf('minimax.io') >= 0) return 'minimax'
    if (base.indexOf('volces.com') >= 0 || base.indexOf('volcengine') >= 0) return 'ark'
    return 'na'
  }

  function providerConfig() {
    const list = []
    // Builtin DeepSeek route (dsh-llm-deepseek): ns `llm-deepseek`,
    // credential ref defaults to DEEPSEEK_API_KEY.
    const ds = settingsGet('llm-deepseek')
    const dsRef = ds && typeof ds.apiKeyEnv === 'string' && ds.apiKeyEnv ? ds.apiKeyEnv : 'DEEPSEEK_API_KEY'
    list.push({ id: 'deepseek-official', displayName: 'DeepSeek', keyRef: dsRef, kind: 'deepseek' })
    // Custom providers (dsh-llm-pi-ai): ns `llm-pi-ai`, `providers` dict,
    // `apiKeyEnv` is the credential reference per provider.
    const pi = settingsGet('llm-pi-ai')
    const providers = pi && pi.providers && typeof pi.providers === 'object' ? pi.providers : {}
    for (const id of Object.keys(providers)) {
      const p = providers[id] && typeof providers[id] === 'object' ? providers[id] : {}
      list.push({
        id: id,
        displayName: typeof p.displayName === 'string' && p.displayName ? p.displayName : (PRETTY_NAMES[id] || id),
        keyRef: typeof p.apiKeyEnv === 'string' && p.apiKeyEnv ? p.apiKeyEnv : null,
        kind: classify(id, p),
      })
    }
    return list
  }

  async function fetchDeepseek(entry, key) {
    const authUrl = AUTH_URLS[entry.id] || AUTH_URLS['deepseek-official']
    if (!key) return { status: 'nocred', message: '未配置 ' + (entry.keyRef || 'DEEPSEEK_API_KEY'), authUrl: authUrl }
    try {
      const r = await fetch('https://api.deepseek.com/user/balance', {
        headers: { authorization: 'Bearer ' + key, accept: 'application/json' },
      })
      if (r.status === 401 || r.status === 403) {
        return { status: 'unauth', message: 'API 密钥无效或已过期（HTTP ' + r.status + '）', authUrl: authUrl }
      }
      if (!r.ok) return { status: 'error', message: 'HTTP ' + r.status, authUrl: authUrl }
      const j = await r.json()
      const infos = j && Array.isArray(j.balance_infos) ? j.balance_infos : []
      const info = infos[0]
      if (!info) return { status: 'error', message: '响应缺少 balance_infos', authUrl: authUrl }
      return {
        status: 'ok',
        balance: {
          currency: String(info.currency || ''),
          total: String(info.total_balance === undefined || info.total_balance === null ? '' : info.total_balance),
          available: j.is_available !== false,
        },
      }
    } catch (e) {
      return { status: 'error', message: shortErr(e), authUrl: authUrl }
    }
  }

  async function fetchMinimax(entry, key) {
    const host = MINIMAX_HOSTS[entry.id]
    const authUrl = AUTH_URLS[entry.id] || null
    if (!key) return { status: 'nocred', message: '未配置 ' + (entry.keyRef || 'API 密钥'), authUrl: authUrl }
    if (!host) return { status: 'error', message: '未知的 MiniMax 端点', authUrl: authUrl }
    try {
      const r = await fetch('https://' + host + '/v1/api/openplatform/coding_plan/remains', {
        headers: { authorization: 'Bearer ' + key, accept: 'application/json' },
      })
      if (r.status === 401 || r.status === 403) {
        return { status: 'unauth', message: 'API 密钥无效或已过期（HTTP ' + r.status + '）', authUrl: authUrl }
      }
      if (!r.ok) return { status: 'error', message: 'HTTP ' + r.status, authUrl: authUrl }
      const j = await r.json()
      if (j && j.base_resp && typeof j.base_resp.status_code === 'number' && j.base_resp.status_code !== 0) {
        return { status: 'error', message: String(j.base_resp.status_msg || ('status_code ' + j.base_resp.status_code)), authUrl: authUrl }
      }
      const remains = j && Array.isArray(j.model_remains) ? j.model_remains : []
      const general = remains.find((e) => e && e.model_name === 'general')
      if (!general) return { status: 'error', message: '响应缺少 general 模型条目', authUrl: authUrl }
      const windows = []
      const intervalRemaining = num(general.current_interval_remaining_percent)
      if (intervalRemaining !== null) {
        const resetsAt = toIso(general.end_time)
        const startMs = num(general.start_time)
        const endMs = num(general.end_time)
        windows.push({
          key: '5h',
          name: '近5小时',
          percent: clampPercent(100 - intervalRemaining),
          resetsAt: resetsAt,
          cyclePercent: cyclePercentOf(resetsAt, startMs !== null && endMs !== null && endMs > startMs ? endMs - startMs : 0),
        })
      }
      if (general.current_weekly_status === 1) {
        const weeklyRemaining = num(general.current_weekly_remaining_percent)
        if (weeklyRemaining !== null) {
          const resetsAt = toIso(general.weekly_end_time)
          const startMs = num(general.weekly_start_time)
          const endMs = num(general.weekly_end_time)
          windows.push({
            key: 'week',
            name: '近一周',
            percent: clampPercent(100 - weeklyRemaining),
            resetsAt: resetsAt,
            cyclePercent: cyclePercentOf(resetsAt, startMs !== null && endMs !== null && endMs > startMs ? endMs - startMs : 0),
          })
        }
      }
      if (!windows.length) return { status: 'error', message: '无用量窗口数据', authUrl: authUrl }
      return { status: 'ok', windows: windows }
    } catch (e) {
      return { status: 'error', message: shortErr(e), authUrl: authUrl }
    }
  }

  async function fetchStepfun(entry, key) {
    // StepFun 账户余额：GET /v1/accounts（Bearer），响应 { balance, total_cash_balance, total_voucher_balance }，CNY
    const authUrl = AUTH_URLS['stepfun'] || null
    if (!key) return { status: 'nocred', message: '未配置 ' + (entry.keyRef || 'STEPFUN_API_KEY'), authUrl: authUrl }
    try {
      const r = await fetch('https://api.stepfun.com/v1/accounts', {
        headers: { authorization: 'Bearer ' + key, accept: 'application/json' },
      })
      if (r.status === 401 || r.status === 403) {
        return { status: 'unauth', message: 'API 密钥无效或已过期（HTTP ' + r.status + '）', authUrl: authUrl }
      }
      if (!r.ok) return { status: 'error', message: 'HTTP ' + r.status, authUrl: authUrl }
      const j = await r.json()
      if (typeof j.balance !== 'number') return { status: 'error', message: '响应缺少 balance 字段', authUrl: authUrl }
      return {
        status: 'ok',
        balance: {
          currency: 'CNY',
          total: String(j.balance),
          available: true,
        },
      }
    } catch (e) {
      return { status: 'error', message: shortErr(e), authUrl: authUrl }
    }
  }

  async function fetchOne(entry, force) {
    const base = { id: entry.id, displayName: entry.displayName, kind: entry.kind }
    try {
      if (entry.kind === 'ark') {
        return Object.assign(base, await fetchArk(entry, force))
      }
      if (entry.kind === 'na') {
        return Object.assign(base, { status: 'na', message: '暂不支持该提供方的用量查询' })
      }
      const key = await resolveKey(entry.keyRef)
      let result
      if (entry.kind === 'minimax') result = await fetchMinimax(entry, key)
      else if (entry.kind === 'stepfun') result = await fetchStepfun(entry, key)
      else result = await fetchDeepseek(entry, key)
      return Object.assign(base, result)
    } catch (e) {
      return Object.assign(base, { status: 'error', message: shortErr(e) })
    }
  }

  let cache = null

  // ── arkcli pipeline (ported from dsh-ark-usage-widget) ─────────────────────
  // Ark coding-plan quota is SSO/STS-bound: no API key can query it. Usage is
  // read through the local arkcli exactly like dsh-ark-usage-widget does, and
  // the 登录认证 action spawns `arkcli auth login volc-sso` so the SSO flow
  // runs on this machine (browser + loopback callback) instead of jumping to
  // a console page that authenticates nothing.

  const ARK_LOGIN_TIMEOUT_MS = 180000
  const WINDOW_5H = 5 * 3600 * 1000
  const WINDOW_7D = 7 * 86400 * 1000
  const WINDOW_30D = 30 * 86400 * 1000

  function getCwd() {
    try {
      const policy = typeof ctx.get === 'function' ? ctx.get('sandboxPolicy') : undefined
      if (policy && typeof policy.workspaceRoot === 'string' && policy.workspaceRoot) return policy.workspaceRoot
    } catch (e) {}
    try {
      const fs = typeof ctx.get === 'function' ? ctx.get('fs') : undefined
      if (fs) {
        const target = fs.resolve('.')
        if (target) return fs.processPath(target)
      }
    } catch (e) {}
    return process.cwd() || '/'
  }

  // arkcli 调用串行队列：多火山条目并发时避免多个 arkcli 进程争用同一份配置/STS 刷新
  let arkQueue = Promise.resolve()
  async function runCli(argv) {
    const exec = async function () {
      const subprocess = Reflect.get(ctx, 'subprocess')
      if (subprocess === undefined || subprocess === null) {
        throw new Error('subprocess 服务不可用，无法调用 arkcli')
      }
      let exe = 'arkcli'
      try {
        exe = await subprocess.resolveExecutable('arkcli')
      } catch (e) {
        throw new Error('未检测到 arkcli 命令行工具（请先 npm i -g @volcengine/ark-cli）')
      }
      const handle = subprocess.spawn({
        argv: [exe].concat(argv),
        cwd: getCwd(),

        stdio: { stdin: 'ignore', stdout: { maxBytes: 2000000 }, stderr: { maxBytes: 200000 } },
        graceMs: 3000,
      })
      const outcome = await handle.done
      const out = handle.collected && handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : ''
      const errText = handle.collected && handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : ''
      if (outcome.exitCode !== 0) {
        throw new Error(errText.trim() || 'arkcli 退出码 ' + outcome.exitCode)
      }
      return out
    }
    const result = arkQueue.then(exec, exec)
    arkQueue = result.then(function () {}, function () {})
    return result
  }

  function epochToIso(ts) {
    return typeof ts === 'number' && ts > 0 ? new Date(Math.round(ts * 1000)).toISOString() : null
  }

  async function fetchSeatMilestones(knownSeatId) {
    try {
      let seatId = knownSeatId
      if (!seatId) {
        const out = await runCli(['api', 'usage.get_seat_info', '--params', '{"ProjectName":"default"}', '--format', 'json'])
        const json = JSON.parse(out)
        seatId = json && json.Result && json.Result.SeatID
      }
      if (!seatId) return null
      const params = JSON.stringify({ SeatID: String(seatId).trim(), ProjectName: 'default' })
      const out = await runCli(['api', 'usage.get_seat_info_usage', '--params', params, '--format', 'json'])
      const json = JSON.parse(out)
      const r = json && json.Result
      if (!r) return null
      return {
        seatId: String(seatId),
        shortTermReset: epochToIso(r.ShortTermResetMilestone),
        weeklyReset: epochToIso(r.WeeklyResetMilestone),
        monthlyReset: epochToIso(r.MonthlyResetMilestone),
        monthlySubscribe: epochToIso(r.MonthlySubscribeMilestone),
        shortTermUsage: typeof r.ShortTermUsage === 'number' ? r.ShortTermUsage : null,
        weeklyUsage: typeof r.WeeklyUsage === 'number' ? r.WeeklyUsage : null,
        monthlyUsage: typeof r.MonthlyUsage === 'number' ? r.MonthlyUsage : null,
      }
    } catch (e) {
      return null
    }
  }

  function arkWindowsFromPlan(jsonVal, milestones) {
    const windows = []
    const rawItems = jsonVal && Array.isArray(jsonVal.items) ? jsonVal.items : []
    for (const item of rawItems) {
      const rawPeriods = Array.isArray(item.periods) ? item.periods : []
      for (const p of rawPeriods) {
        const label = String(p.label || '').toLowerCase()
        let percent = Number(p.percent)
        if (!isFinite(percent)) percent = 0
        let resetAt = p.reset_at !== undefined && p.reset_at !== null ? String(p.reset_at) : null
        let cyclePercent = null
        let name = label
        if (label === 'session') {
          name = '近5小时'
          if (milestones) {
            if (milestones.shortTermReset) {
              resetAt = milestones.shortTermReset
              cyclePercent = cyclePercentOf(resetAt, WINDOW_5H)
            }
            if (milestones.shortTermUsage !== null) percent = milestones.shortTermUsage
          }
        } else if (label === 'weekly') {
          name = '近一周'
          if (milestones) {
            if (milestones.weeklyReset) {
              resetAt = milestones.weeklyReset
              cyclePercent = cyclePercentOf(resetAt, WINDOW_7D)
            }
            if (milestones.weeklyUsage !== null) percent = milestones.weeklyUsage
          }
        } else if (label === 'monthly') {
          name = '近一月'
          if (milestones) {
            if (milestones.monthlyReset) {
              resetAt = milestones.monthlyReset
              let win = WINDOW_30D
              if (milestones.monthlySubscribe) {
                const s = Date.parse(milestones.monthlySubscribe)
                const e = Date.parse(milestones.monthlyReset)
                if (isFinite(s) && isFinite(e) && e > s) win = e - s
              }
              cyclePercent = cyclePercentOf(resetAt, win)
            }
            if (milestones.monthlyUsage !== null) percent = milestones.monthlyUsage
          }
        }
        windows.push({ key: label || 'p', name: name, percent: clampPercent(percent), resetsAt: resetAt, cyclePercent: cyclePercent })
      }
    }
    return windows
  }

  // ── Ark OpenAPI V4 签名（个人账号 AK/SK 直查，不走 arkcli）──────────────────
  // 对照 volcengine SDK SignerV4：canonical headers 每行含尾部 \n（末行后有空行），
  // sorted keys；scope = shortdate/cn-beijing/ark/request；Action/Version 走查询串。
  function arkV4Sign(ak, sk, action, bodyHash, xDate) {
    const shortDate = xDate.slice(0, 8)
    const query = 'Action=' + action + '&Version=2024-01-01'
    const canonicalHeaders = 'content-type:application/json; charset=utf-8\nhost:open.volcengineapi.com\nx-content-sha256:' + bodyHash + '\nx-date:' + xDate + '\n'
    const signedHeaders = 'content-type;host;x-content-sha256;x-date'
    const canonical = ['POST', '/', query, canonicalHeaders, signedHeaders, bodyHash].join('\n')
    const hash = createHash('sha256').update(canonical).digest('hex')
    const scope = shortDate + '/cn-beijing/ark/request'
    const sts = ['HMAC-SHA256', xDate, scope, hash].join('\n')
    const kDate = createHmac('sha256', sk).update(shortDate).digest()
    const kRegion = createHmac('sha256', kDate).update('cn-beijing').digest()
    const kService = createHmac('sha256', kRegion).update('ark').digest()
    const kSigning = createHmac('sha256', kService).update('request').digest()
    const sig = createHmac('sha256', kSigning).update(sts).digest('hex')
    return 'HMAC-SHA256 Credential=' + ak + '/' + scope + ', SignedHeaders=' + signedHeaders + ', Signature=' + sig
  }

  async function fetchArkAkSk(ak, sk) {
    const body = '{}'
    const bodyHash = createHash('sha256').update(body).digest('hex')
    const xDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
    const auth = arkV4Sign(ak, sk, 'GetCodingPlanUsage', bodyHash, xDate)
    const r = await fetch('https://open.volcengineapi.com/?Action=GetCodingPlanUsage&Version=2024-01-01', {
      method: 'POST',
      headers: { Authorization: auth, 'X-Date': xDate, 'X-Content-Sha256': bodyHash, 'Content-Type': 'application/json; charset=utf-8' },
      body: body,
    })
    const j = await r.json().catch(function () { return null })
    if (!r.ok || !j || !j.Result || !Array.isArray(j.Result.QuotaUsage)) {
      const msg = j && j.ResponseMetadata && j.ResponseMetadata.Error ? (j.ResponseMetadata.Error.Message || j.ResponseMetadata.Error.Code) : 'HTTP ' + r.status
      throw new Error('AKSK:' + msg)
    }
    const windows = []
    for (const q of j.Result.QuotaUsage) {
      const key = String(q.Level || '').toLowerCase()
      const name = key === 'session' ? '近5小时' : key === 'weekly' ? '近一周' : key === 'monthly' ? '近一月' : key
      windows.push({
        key: key || 'p',
        name: name,
        percent: clampPercent(Number(q.Percent) || 0),
        resetsAt: q.ResetTimestamp > 0 ? new Date(q.ResetTimestamp * 1000).toISOString() : null,
        cyclePercent: null,
      })
    }
    if (!windows.length) throw new Error('无用量窗口数据')
    return windows
  }

  function classifyArkError(err) {
    const text = String(err && err.message ? err.message : err)
    if (/未检测到 arkcli|subprocess 服务不可用|binary not found|二进制可能下载失败/i.test(text)) {
      return { status: 'nocred', message: 'arkcli 未安装或二进制缺失（npm i -g @volcengine/ark-cli 重装修复）' }
    }
    if (/^AKSK:/.test(text)) { return { status: 'error', message: 'AK/SK 查询失败：' + text.slice(5) } }
    if (/rate.?limit|too many requests|\b429\b/i.test(text)) {
      return { status: 'error', message: '火山接口限流中（此前失败重试过于频繁），几分钟内自动恢复，无需重新登录' }
    }
    if (/unexpected token|unexpected end of json|in json at position/i.test(text)) {
      return { status: 'error', message: 'arkcli 返回了非 JSON 输出（获取失败，非登录问题）' }
    }
    if (/login|auth|credential|token|未登录|登录|access.?denied|not.?logged/i.test(text)) {
      return { status: 'unauth', message: '未登录火山方舟或登录已过期，点击「登录认证」重新授权' }
    }
    return { status: 'error', message: '获取火山方舟用量失败' }
  }

  let arkBackoffUntil = 0
  let arkLastFail = null
  async function fetchArk(entry, force) {
    // 失败退避：ark 失败（如 STS 限流）后 5 分钟内不再 spawn arkcli，避免重试风暴加重限流；
    // force（弹窗刷新按钮 / 登录成功后的立即刷新）绕过退避，用户显式要求时允许重试。
    if (!force && Date.now() < arkBackoffUntil && arkLastFail) return arkLastFail
    // AK/SK 模式（个人账号）：凭据 seam 存在 <apiKeyEnv>_AK + <apiKeyEnv>_SK 时，
    // 直接 V4 签名调用 Ark OpenAPI GetCodingPlanUsage（open.volcengineapi.com），
    // 不经 arkcli（arkcli 对已初始化配置无视身份切换 env，实测无效）。
    // 无 AK/SK → 默认 profile（arkcli SSO 登录态 = IAM 账号）。
    const ak = entry.keyRef ? await resolveKey(entry.keyRef + '_AK') : null
const sk = entry.keyRef ? await resolveKey(entry.keyRef + '_SK') : null
    const useAkSk = !!(ak && sk)
    try {
      if (useAkSk) {
        const windows = await fetchArkAkSk(ak, sk)
        arkBackoffUntil = 0
        arkLastFail = null
        return { status: 'ok', windows: windows }
      }
      const planOut = await runCli(['usage', 'plan', '--format', 'json'])
      const planJson = JSON.parse(planOut)
      const seatId = planJson.items && planJson.items.length ? (planJson.items[0].seat_id || null) : null
      const milestones = await fetchSeatMilestones(seatId)
      const windows = arkWindowsFromPlan(planJson, milestones)
      if (!windows.length) return { status: 'error', message: '无用量窗口数据' }
      arkBackoffUntil = 0
      arkLastFail = null
      return { status: 'ok', windows: windows }
    } catch (e) {
      const c = classifyArkError(e)
      const out = { status: c.status, message: c.message }
      if (c.status === 'unauth') out.authUrl = AUTH_URLS['volcengine-ark']
      arkBackoffUntil = Date.now() + 5 * 60 * 1000
      out.retryAt = arkBackoffUntil
      arkLastFail = out
      return out
    }
  }

  let loginBusy = false
  async function arkLogin() {
    if (loginBusy) return { ok: false, message: '登录流程已在进行中' }
    loginBusy = true
    try {
      let timer
      const timeout = new Promise(function (resolve) { timer = setTimeout(function () { resolve(false) }, ARK_LOGIN_TIMEOUT_MS) })
      const result = await Promise.race([
        runCli(['auth', 'login', 'volc-sso']).then(function () { return true }).catch(function (e) { return { error: e } }),
        timeout,
      ])
      clearTimeout(timer)
      if (result === true) {
        cache = null
        arkBackoffUntil = 0
        arkLastFail = null
        return { ok: true, message: '登录成功' }
      }
      if (result === false) return { ok: false, message: '登录超时：完成浏览器授权后稍候，点「刷新」查看结果' }
      const c = classifyArkError(result.error)
      return { ok: false, message: c.message, detail: shortErr(result.error) }
    } finally {
      loginBusy = false
    }
  }

  async function fetchAll(force) {
    const now = Date.now()
    if (!force && cache && now - cache.at < CACHE_TTL_MS) return cache.data
    const list = providerConfig()
    const settled = await Promise.all(list.map((entry) => fetchOne(entry, force)))
    const data = { ok: true, updatedAt: now, providers: settled }
    cache = { at: now, data: data }
    return data
  }

  return { fetch: fetchAll, arkLogin: arkLogin }
}