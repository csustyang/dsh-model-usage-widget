// smoke.mjs — offline verification of the HOST half (no DSH process needed).
// Doubles as the "DSH 启动模拟": apply() runs against a mock ctx (full and
// degraded service sets) and must register the routes without throwing.
import { apply, MODEL_USAGE_ROUTE, ARK_LOGIN_ROUTE } from './index.js'

const realFetch = globalThis.fetch
let failures = 0
function check(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (cond || extra === undefined ? '' : ' :: ' + JSON.stringify(extra)))
  if (!cond) failures++
}

const MINIMAX_BODY = {
  model_remains: [{
    model_name: 'general',
    start_time: Date.now() - 3600000, end_time: Date.now() + 3600000,
    current_interval_remaining_percent: 97,
    current_weekly_status: 1,
    current_weekly_remaining_percent: 98,
    weekly_start_time: Date.now() - 86400000, weekly_end_time: Date.now() + 6 * 86400000,
  }],
  base_resp: { status_code: 0, status_msg: 'success' },
}
const DEEPSEEK_BODY = { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '1.60', granted_balance: '0.00', topped_up_balance: '1.60' }] }

const ARK_AKSK_BODY = { ResponseMetadata: { Action: 'GetCodingPlanUsage', Version: '2024-01-01', Service: 'ark', Region: 'cn-beijing' }, Result: { Status: 'Running', QuotaUsage: [ { Level: 'session', Percent: 12.96, ResetTimestamp: Math.floor(Date.now() / 1000) + 3600, Cap: 100 }, { Level: 'weekly', Percent: 1.73, ResetTimestamp: Math.floor(Date.now() / 1000) + 86400, Cap: 100 }, { Level: 'monthly', Percent: 0.86, ResetTimestamp: Math.floor(Date.now() / 1000) + 5 * 86400, Cap: 100 } ] } }
const STEPFUN_BODY = { object: 'account', type: 'prepaid', balance: 10.51, total_cash_balance: 0.00, total_voucher_balance: 10.51 }
const ARK_PLAN_BODY = {
  ok: true,
  viewer: { user_name: 'yangtao', account_id: '2126402578', profile: 'coding-plan-team', region: 'cn-beijing', user_id: '89342225' },
  items: [{
    product: 'coding-plan-team', edition: 'team', seat_id: 'seat-1', subscribed: true, error: null,
    periods: [
      { label: 'session', percent: 66.1, used: 66.1, total: 100, reset_at: new Date(Date.now() + 3600000).toISOString() },
      { label: 'weekly', percent: 49.3, used: 49.3, total: 100, reset_at: new Date(Date.now() + 86400000).toISOString() },
      { label: 'monthly', percent: 24.7, used: 24.7, total: 100, reset_at: new Date(Date.now() + 5 * 86400000).toISOString() },
    ],
  }],
}
const ARK_SEAT_BODY = {
  Result: {
    SeatID: 'seat-1',
    ShortTermResetMilestone: (Date.now() + 1800000) / 1000,
    WeeklyResetMilestone: (Date.now() + 86400000) / 1000,
    MonthlyResetMilestone: (Date.now() + 5 * 86400000) / 1000,
    ShortTermUsage: 66.1, WeeklyUsage: 49.3, MonthlyUsage: 24.7,
  },
}

// subprocess seam mock: 'ok' | 'fail-usage' | 'fail-login' | null (service absent)
function fakeSubprocess(mode) {
  const fake = {
    calls: [],
    async resolveExecutable(name) { return 'C:/fake/' + name + '.exe' },
    spawn(opts) {
      fake.calls.push({ argv: opts.argv, env: opts.env || null })
      const argv = opts.argv.join(' ')
      let stdoutText = ''
      let stderrText = ''
      let exitCode = 0
      if (argv.indexOf('usage plan') >= 0) {
        if (mode === 'fail-usage') { exitCode = 1; stderrText = 'STS 续期失败: token 交换失败: invalid_request' }
        else if (mode === 'rate-limit') { exitCode = 1; stderrText = 'STS 续期失败: token 交换失败: invalid_request - Too many requests, rate limit exceeded' }
        else if (mode === 'bad-json') { stdoutText = 'WARNING: something went slightly wrong {not-json' }
        else if (mode === 'no-binary') { exitCode = 1; stderrText = 'arkcli: binary not found at C:\\x\\arkcli-windows-amd64.exe 安装时平台二进制可能下载失败' }
        else stdoutText = JSON.stringify(ARK_PLAN_BODY)
      } else if (argv.indexOf('usage.get_seat_info') >= 0) {
        if (mode === 'fail-usage' || mode === 'rate-limit') { exitCode = 1; stderrText = 'STS 续期失败' }
        else stdoutText = JSON.stringify(ARK_SEAT_BODY)
      } else if (argv.indexOf('auth login') >= 0) {
        if (mode !== 'ok') { exitCode = 1; stderrText = 'mock: arkcli auth failed' }
      }
      return {
        done: Promise.resolve({ exitCode: exitCode }),
        collected: {
          stdout: { readFrom() { return { text: stdoutText } } },
          stderr: { readFrom() { return { text: stderrText } } },
        },
      }
    },
  }
  return fake
}
function mockRes() {
  const headers = {}
  return {
    statusCode: 0, body: null, headers,
    setHeader(k, v) { headers[k] = v },
    end(payload) { this.body = payload === undefined ? null : payload },
  }
}

function makeCtx(opts = {}) {
  const { withServices = true, fetchImpl, credentialValue = 'test-key', subprocessMode = 'ok', extraProviders = {}, akSkRefs = false } = opts
  const routes = new Map()
  const effectIds = []
  const disposers = []
  const ctx = {
    effect(fn, id) { effectIds.push(id); const d = fn(); if (typeof d === 'function') disposers.push(d) },
    webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path) } },
    connection: { requestRejection(req) { return req && req.rejectWith ? 403 : undefined } },
  }
  if (withServices) {
    ctx.settings = {
      get(ns) {
        if (ns === 'llm-deepseek') return { apiKeyEnv: 'DEEPSEEK_API_KEY' }
        if (ns === 'llm-pi-ai') {
          const providers = {
            'minimax-cn': { models: [{ id: 'MiniMax-M3' }], apiKeyEnv: 'MINIMAX_CN_API_KEY' },
            'volcengine-ark': { displayName: '火山方舟', apiKeyEnv: 'VOLCENGINE_ARK_API_KEY', api: 'openai-completions', baseURL: 'https://ark.cn-beijing.volces.com/api/coding/v3' },
          }
          for (const [k, v] of Object.entries(extraProviders)) providers[k] = v
          return { providers: providers }
        }
        return undefined
      },
    }
    ctx.credentials = { async resolve(name) {
      if (!akSkRefs && /_(AK|SK|PROFILE)$/.test(name)) return null
      return { value: credentialValue, source: 'test' }
    } }
    if (subprocessMode) ctx.subprocess = fakeSubprocess(subprocessMode)
  }
  globalThis.fetch = fetchImpl || (async (url) => {
    const u = String(url)
    if (u.indexOf('api.deepseek.com') >= 0) return { ok: true, status: 200, json: async () => DEEPSEEK_BODY }
    if (u.indexOf('/v1/accounts') >= 0) return { ok: true, status: 200, json: async () => STEPFUN_BODY }
    if (u.indexOf('open.volcengineapi.com') >= 0) return { ok: true, status: 200, json: async () => ARK_AKSK_BODY }
    return { ok: true, status: 200, json: async () => MINIMAX_BODY }
  })
  return { ctx, routes, effectIds, disposers }
}

// ── 1. full services: apply + first fetch ──────────────────────────────────
const a = makeCtx()
apply(a.ctx)
check('usage route registered at ' + MODEL_USAGE_ROUTE, a.routes.has(MODEL_USAGE_ROUTE))
check('login route registered at ' + ARK_LOGIN_ROUTE, a.routes.has(ARK_LOGIN_ROUTE))
check('exactly two effect ids', a.effectIds.length === 2 && a.effectIds[0] === 'dsh-model-usage-widget: GET /model-usage' && a.effectIds[1] === 'dsh-model-usage-widget: POST /model-usage/ark-login', a.effectIds)

const res1 = mockRes()
await a.routes.get(MODEL_USAGE_ROUTE)({ method: 'GET', url: '/model-usage' }, res1)
check('HTTP 200', res1.statusCode === 200)
check('content-type json', String(res1.headers['content-type']).includes('application/json'))
const body1 = JSON.parse(res1.body)
check('payload ok:true', body1.ok === true && typeof body1.updatedAt === 'number')
check('3 providers (deepseek + minimax-cn + ark)', body1.providers.length === 3, body1.providers)
const [ds, mm, ark] = body1.providers
check('deepseek id/displayName', ds.id === 'deepseek-official' && ds.displayName === 'DeepSeek', ds)
check('deepseek ok + balance 1.60 CNY available', ds.status === 'ok' && ds.balance && ds.balance.total === '1.60' && ds.balance.currency === 'CNY' && ds.balance.available === true, ds)
check('minimax ok + 2 windows', mm.id === 'minimax-cn' && mm.status === 'ok' && mm.windows.length === 2, mm)
check('minimax 5h percent = 100-97 = 3', mm.windows[0].key === '5h' && mm.windows[0].percent === 3, mm.windows[0])
check('minimax 5h cyclePercent sane (0-100)', typeof mm.windows[0].cyclePercent === 'number' && mm.windows[0].cyclePercent >= 0 && mm.windows[0].cyclePercent <= 100, mm.windows[0])
check('minimax week percent = 2 + resetsAt ISO', mm.windows[1].key === 'week' && mm.windows[1].percent === 2 && !isNaN(Date.parse(mm.windows[1].resetsAt)), mm.windows[1])
check('ark ok + 3 windows via arkcli', ark.id === 'volcengine-ark' && ark.status === 'ok' && Array.isArray(ark.windows) && ark.windows.length === 3, ark)
check('ark session percent 66.1', ark.windows[0].key === 'session' && ark.windows[0].percent === 66.1, ark.windows[0])
check('ark weekly percent 49.3 + resetsAt ISO', ark.windows[1].key === 'weekly' && ark.windows[1].percent === 49.3 && !isNaN(Date.parse(ark.windows[1].resetsAt)), ark.windows[1])
check('ark monthly percent 24.7', ark.windows[2].key === 'monthly' && ark.windows[2].percent === 24.7, ark.windows[2])
check('ark windows carry cyclePercent when milestones known', typeof ark.windows[0].cyclePercent === 'number', ark.windows[0])

// ── 2. cache: second GET within TTL is served from cache (no fetch) ────────
globalThis.fetch = async () => { throw new Error('should not be called (cache)') }
const res2 = mockRes()
await a.routes.get(MODEL_USAGE_ROUTE)({ method: 'GET', url: '/model-usage' }, res2)
check('cache hit returns same updatedAt', JSON.parse(res2.body).updatedAt === body1.updatedAt)

// ── 3. force=1 bypasses cache ──────────────────────────────────────────────
globalThis.fetch = async () => { throw new Error('network down (forced)') }
const res3 = mockRes()
await a.routes.get(MODEL_USAGE_ROUTE)({ method: 'GET', url: '/model-usage?force=1' }, res3)
const body3 = JSON.parse(res3.body)
check('force bypasses cache, deepseek degrades to error', body3.providers[0].status === 'error', body3.providers[0])
check('force bypasses cache, still ok:true envelope', body3.ok === true)
check('force: ark unaffected by HTTP fetch outage (arkcli seam)', body3.providers[2].status === 'ok', body3.providers[2])

// ── 4. POST → 405; trust fence rejection honored ───────────────────────────
const res4 = mockRes()
await a.routes.get(MODEL_USAGE_ROUTE)({ method: 'POST', url: '/model-usage' }, res4)
check('POST → 405 + allow header', res4.statusCode === 405 && res4.headers.allow === 'GET')
const res5 = mockRes()
await a.routes.get(MODEL_USAGE_ROUTE)({ method: 'GET', url: '/model-usage', rejectWith: true }, res5)
check('requestRejection → status passthrough', res5.statusCode === 403 && res5.body === null)

// ── 5. ark login route: fence + 405 + success (fresh ctx, own cache) ───────
const lg = makeCtx()
apply(lg.ctx)
const resL0 = mockRes()
await lg.routes.get(ARK_LOGIN_ROUTE)({ method: 'GET', url: ARK_LOGIN_ROUTE }, resL0)
check('ark-login GET → 405 + allow POST', resL0.statusCode === 405 && resL0.headers.allow === 'POST', resL0)
const resL1 = mockRes()
await lg.routes.get(ARK_LOGIN_ROUTE)({ method: 'GET', url: ARK_LOGIN_ROUTE, rejectWith: true }, resL1)
check('ark-login trust fence honored', resL1.statusCode === 403 && resL1.body === null)
const resL2 = mockRes()
await lg.routes.get(ARK_LOGIN_ROUTE)({ method: 'POST', url: ARK_LOGIN_ROUTE }, resL2)
check('ark-login POST → 200 ok:true', resL2.statusCode === 200 && JSON.parse(resL2.body).ok === true, resL2.body)

// ── 6. arkcli not logged in (usage plan exits 1 with token error) → unauth ─
const fu = makeCtx({ subprocessMode: 'fail-usage' })
apply(fu.ctx)
const resL3 = mockRes()
await fu.routes.get(MODEL_USAGE_ROUTE)({ method: 'GET', url: '/model-usage?force=1' }, resL3)
const arkFail = JSON.parse(resL3.body).providers[2]
check('ark fail-usage → unauth', arkFail.status === 'unauth', arkFail)
check('ark unauth carries authUrl', typeof arkFail.authUrl === 'string' && arkFail.authUrl.indexOf('https://') === 0, arkFail)
const resL3b = mockRes()
await fu.routes.get(ARK_LOGIN_ROUTE)({ method: 'POST', url: ARK_LOGIN_ROUTE }, resL3b)
const loginFail = JSON.parse(resL3b.body)
check('ark-login POST fail → 200 ok:false + message', resL3b.statusCode === 200 && loginFail.ok === false && typeof loginFail.message === 'string', loginFail)

// ── 6b. STS rate-limited → error status with 限流 message (NOT 未登录) ──────
const rl = makeCtx({ subprocessMode: 'rate-limit' })
apply(rl.ctx)
const resRl = mockRes()
await rl.routes.get(MODEL_USAGE_ROUTE)({ method: 'GET', url: '/model-usage?force=1' }, resRl)
const arkRl = JSON.parse(resRl.body).providers[2]
check('ark rate-limit → error status', arkRl.status === 'error', arkRl)
check('ark rate-limit message blames 限流 not 登录', /限流/.test(arkRl.message) && !/未登录/.test(arkRl.message), arkRl)
check('ark rate-limit carries retryAt countdown', typeof arkRl.retryAt === 'number' && arkRl.retryAt > Date.now(), arkRl)

// ── 6c. arkcli exit 0 but non-JSON stdout → error (NOT unauth via /token/) ──
const bj = makeCtx({ subprocessMode: 'bad-json' })
apply(bj.ctx)
const resBj = mockRes()
await bj.routes.get(MODEL_USAGE_ROUTE)({ method: 'GET', url: '/model-usage?force=1' }, resBj)
const arkBj = JSON.parse(resBj.body).providers[2]
check('ark bad-json → error status (not unauth)', arkBj.status === 'error' && arkBj.status !== 'unauth', arkBj)
check('ark bad-json message says 非 JSON', /非 JSON/.test(arkBj.message), arkBj)

// ── 7. subprocess service absent → nocred, no crash, no authUrl ────────────
const ns = makeCtx({ subprocessMode: null })
apply(ns.ctx)
const resL4 = mockRes()
await ns.routes.get(MODEL_USAGE_ROUTE)({ method: 'GET', url: '/model-usage?force=1' }, resL4)
const arkNoSub = JSON.parse(resL4.body).providers[2]
check('ark no subprocess → nocred (no crash)', arkNoSub.status === 'nocred' && arkNoSub.authUrl === undefined, arkNoSub)

// ── 8. degraded boot: NO settings/credentials services; fetch throws ───────
const b = makeCtx({ withServices: false, fetchImpl: async () => { throw new Error('no network') } })
apply(b.ctx)
check('degraded boot still registers routes', b.routes.has(MODEL_USAGE_ROUTE) && b.routes.has(ARK_LOGIN_ROUTE))
const res6 = mockRes()
await b.routes.get(MODEL_USAGE_ROUTE)({ method: 'GET', url: '/model-usage' }, res6)
check('degraded fetch → HTTP 200 fail-soft envelope', res6.statusCode === 200 && JSON.parse(res6.body).ok === true)
const body6 = JSON.parse(res6.body)
check('degraded: deepseek nocred (no key, no settings)', body6.providers[0].status === 'nocred', body6.providers[0])
check('degraded: deepseek nocred carries authUrl', typeof body6.providers[0].authUrl === 'string' && body6.providers[0].authUrl.startsWith('https://'), body6.providers[0])
check('degraded: only deepseek default entry (no pi-ai ns)', body6.providers.length === 1)

// ── 9. key resolution falls back to env when credentials missing ───────────
process.env.DEEPSEEK_API_KEY = 'env-key-test'
const c = makeCtx({ withServices: false })
delete c.ctx.credentials
apply(c.ctx)
const res7 = mockRes()
await c.routes.get(MODEL_USAGE_ROUTE)({ method: 'GET', url: '/model-usage' }, res7)
check('env fallback key used (deepseek ok from env key)', JSON.parse(res7.body).providers[0].status === 'ok')
delete process.env.DEEPSEEK_API_KEY

// ── 10. credentials resolve throwing → fail-soft nocred ────────────────────
const d = makeCtx({ fetchImpl: async () => { throw new Error('x') } })
d.ctx.credentials = { async resolve() { throw new Error('seam broken') } }
// settings still present; deepseek key falls to env (deleted) → nocred
apply(d.ctx)
const res8 = mockRes()
await d.routes.get(MODEL_USAGE_ROUTE)({ method: 'GET', url: '/model-usage' }, res8)
check('broken credentials seam → nocred not crash', JSON.parse(res8.body).providers[0].status === 'nocred')

// ── 10b. second deepseek entry (custom, id collides with builtin) ──────────
const dupe = makeCtx({
  extraProviders: {
    'deepseek-official': { displayName: 'DeepSeek 备用', apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com/v1' },
    'stepfun': { displayName: 'StepFun', apiKeyEnv: 'STEPFUN_API_KEY', baseURL: 'https://api.stepfun.com/v1' },
  },
})
apply(dupe.ctx)
const resD = mockRes()
await dupe.routes.get(MODEL_USAGE_ROUTE)({ method: 'GET', url: '/model-usage?force=1' }, resD)
const dBody = JSON.parse(resD.body)
check('dupe: 5 providers (builtin + custom deepseek + minimax + ark + stepfun)', dBody.providers.length === 5, dBody.providers)
const customDs = dBody.providers.find(function (p) { return p.kind === 'deepseek' && p.displayName === 'DeepSeek 备用' })
check('dupe: custom deepseek classified as deepseek kind', customDs !== undefined, dBody.providers)
check('dupe: custom deepseek fetches balance (not na)', customDs && customDs.status === 'ok' && customDs.balance && customDs.balance.total === '1.60', customDs)
const sf = dBody.providers.find(function (p) { return p.kind === 'stepfun' })
check('stepfun: classified + balance 10.51 CNY', sf && sf.status === 'ok' && sf.balance && sf.balance.total === '10.51' && sf.balance.currency === 'CNY', sf)

// ── 10c. dual volcengine accounts: volcengine-p uses AK/SK OpenAPI (fetch), ark uses SSO (arkcli)
const dv = makeCtx({
  akSkRefs: true,
  extraProviders: { 'volcengine-p': { displayName: '火山个人版', apiKeyEnv: 'VOLCENGINE_P_API_KEY', baseURL: 'https://ark.cn-beijing.volces.com/api/coding/v3' } },
})
apply(dv.ctx)
const fake = dv.ctx.subprocess
const resV = mockRes()
await dv.routes.get(MODEL_USAGE_ROUTE)({ method: 'GET', url: '/model-usage?force=1' }, resV)
const vBody = JSON.parse(resV.body)
const arkList = vBody.providers.filter(function (p) { return p.kind === 'ark' })
check('dual-ark: 2 ark providers ok', arkList.length === 2 && arkList.every(function (p) { return p.status === 'ok' }), arkList)
const arkP = arkList.find(function (p) { return p.id === 'volcengine-p' })
check('dual-ark: volcengine-p AK/SK windows (session 12.96)', arkP && arkP.status === 'ok' && arkP.windows && arkP.windows[0].percent === 12.96, arkP)
check('dual-ark: both entries via OpenAPI (zero arkcli spawns)', fake.calls.length === 0, fake.calls.map(function (c) { return c.argv.join(' ') }))

// ── 10d. arkcli binary missing → nocred ─────────────────────────────────────
const nb = makeCtx({ subprocessMode: 'no-binary' })
apply(nb.ctx)
const resNb = mockRes()
await nb.routes.get(MODEL_USAGE_ROUTE)({ method: 'GET', url: '/model-usage?force=1' }, resNb)
const arkNb = JSON.parse(resNb.body).providers[2]
check('ark binary-missing → nocred', arkNb.status === 'nocred' && /二进制缺失/.test(arkNb.message), arkNb)

// ── 11. disposer unregisters routes (composition teardown) ─────────────────
for (const dispose of a.disposers) dispose()
check('disposers remove routes', !a.routes.has(MODEL_USAGE_ROUTE) && !a.routes.has(ARK_LOGIN_ROUTE))

globalThis.fetch = realFetch
console.log(failures === 0 ? '\nALL GREEN' : '\n' + failures + ' FAILURES')
process.exit(failures === 0 ? 0 : 1)
