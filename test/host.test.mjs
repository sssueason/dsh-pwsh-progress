/**
 * dsh-pwsh-progress — 宿主侧回归测试（2026-09-26 事故的护栏）。
 *
 * 事故：内核把 `jobs.onJobsChanged` 换成了 `jobs.events.subscribe`，而插件里那行调用在新内核上抛
 * TypeError ⇒ `apply()` 中途夭折 ⇒ **路由与系统提示公告一起没注册**（进度条在 UI 上彻底消失，
 * 且没有任何日志）。本文件锁住三件事：
 *
 *   1) **可见面先注册**：即使 jobs 服务缺 `onJobsChanged`/`events`（或整个 jobs 缺失），
 *      3 条路由与 `tool:pwsh-progress` 公告也必须注册（旧顺序下这里会红）；
 *   2) **caller 用 SessionId 字符串**：`jobs.get/kill` 收到的是 `exec.agent.id`，不是 Agent 对象；
 *   3) **事件订阅走新 API**：有 `events.subscribe` 时用它（老 API 作为兜底仍可用）。
 *
 * 运行：node --test test/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { apply as applyPlugin } from '../index.js';

/** 最小 cordis 风格 ctx 桩：只实现插件真正用到的面。 */
function makeCtx({ jobs, withWebServer = true } = {}) {
  const routes = [];
  const sections = [];
  const effects = [];
  const handlers = new Map();
  const warns = [];
  const ctx = {
    logger: { warn: (m) => warns.push(String(m)) },
    get: (name) => {
      if (name === 'jobs') return jobs;
      if (name === 'webServer') return withWebServer ? { register: (r) => { routes.push(r); return () => {}; } } : undefined;
      return undefined;
    },
    on: (event, handler) => { handlers.set(event, handler); },
    effect: (fn, label) => { const d = fn(); effects.push({ label, d }); return () => { if (typeof d === 'function') d(); }; },
    setInterval: () => () => {},
    systemPrompt: { section: (s) => { sections.push(s); return () => {}; } },
  };
  return { ctx, routes, sections, effects, handlers, warns };
}

/** 假 jobs 服务：`get` 会把 caller 记下来，并对"非字符串 caller"直接判失败（复刻内核的归属栅栏）。 */
function makeJobs({ withEvents = true, withLegacy = false, withProgress = false } = {}) {
  const calls = { get: [], kill: [] };
  let subscribed = 0;
  let legacySubscribed = 0;
  let onEvent = null;
  const jobs = {
    calls,
    get subscribed() { return subscribed; },
    get legacySubscribed() { return legacySubscribed; },
    emit(event) { if (onEvent !== null) onEvent(event); },
    get(id, caller) {
      calls.get.push({ id, caller });
      if (caller !== undefined && typeof caller !== 'string') {
        throw new Error(`job ${id} belongs to another session`);
      }
      return {
        id,
        kind: 'pwsh',
        label: 'demo command',
        status: 'running',
        startedAt: 1000,
        ...(withProgress ? { progress: 'warm-up' } : {}),
      };
    },
    kill(id, caller, reason) {
      calls.kill.push({ id, caller, reason });
      if (caller !== undefined && typeof caller !== 'string') throw new Error('belongs to another session');
      return 'requested';
    },
  };
  if (withEvents) {
    jobs.events = { subscribe: (filter, listener) => { subscribed += 1; onEvent = listener; return () => { subscribed -= 1; }; } };
  }
  if (withLegacy) {
    jobs.onJobsChanged = (listener) => { legacySubscribed += 1; onEvent = listener; return () => { legacySubscribed -= 1; }; };
  }
  return jobs;
}

/** 假 req/res：走宿主侧 isLoopbackRequest 要求的形状，并捕获响应体。 */
function makeReqRes({ method = 'POST', body = {} } = {}) {
  const chunks = [Buffer.from(JSON.stringify(body), 'utf8')];
  const req = {
    method,
    headers: { host: '127.0.0.1:19387' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; },
  };
  let status = null;
  let payload = null;
  const res = {
    writeHead: (s) => { status = s; },
    end: (text) => { payload = text === undefined ? null : JSON.parse(text); },
  };
  return { req, res, get: () => ({ status, payload }) };
}

/** 触发一次"后台 pwsh 调用"的 tools/execute 旁路（agent 带 id 才算有主任务）。 */
async function runBackgroundCall(handlers, { agent = { id: 'session-1' }, jobId = 'pwsh-1', command = 'demo' } = {}) {
  const exec = { name: 'pwsh', agent, arguments: { command, run_in_background: true } };
  const next = async () => ({ isError: false, value: { kind: 'background', jobId } });
  return handlers.get('tools/execute')(exec, next);
}

const byPath = (routes, path) => routes.find((r) => r.path === path);

test('事故护栏：jobs 只有新 API（events.subscribe，无 onJobsChanged）时，可见面必须全部注册', () => {
  const jobs = makeJobs({ withEvents: true, withLegacy: false });
  const { ctx, routes, sections } = makeCtx({ jobs });
  applyPlugin(ctx);
  assert.equal(routes.length, 3, '三条路由都要注册');
  for (const p of ['/api/dsh-pwsh-progress/state', '/api/dsh-pwsh-progress/list', '/api/dsh-pwsh-progress/kill']) {
    assert.ok(byPath(routes, p) !== undefined, `缺路由 ${p}`);
  }
  assert.equal(sections.length, 1, '系统提示公告要注册');
  assert.equal(sections[0].name, 'tool:pwsh-progress');
  assert.equal(jobs.subscribed, 1, '要用新的 events.subscribe');
  assert.equal(jobs.legacySubscribed, 0);
});

test('事故护栏：jobs 一个事件 API 都没有时也不许抛（可见面照注册）', () => {
  const jobs = makeJobs({ withEvents: false, withLegacy: false });
  const { ctx, routes, sections } = makeCtx({ jobs });
  assert.doesNotThrow(() => applyPlugin(ctx));
  assert.equal(routes.length, 3);
  assert.equal(sections.length, 1);
});

test('事故护栏：整个 jobs 服务缺失时也不许抛', () => {
  const { ctx, routes, sections } = makeCtx({ jobs: undefined });
  assert.doesNotThrow(() => applyPlugin(ctx));
  assert.equal(routes.length, 3);
  assert.equal(sections.length, 1);
});

test('老内核兜底：只有 onJobsChanged 时仍订阅（向后兼容）', () => {
  const jobs = makeJobs({ withEvents: false, withLegacy: true });
  const { ctx } = makeCtx({ jobs });
  applyPlugin(ctx);
  assert.equal(jobs.legacySubscribed, 1);
});

test('caller 契约：jobs.get / jobs.kill 收到的是 SessionId 字符串（不是 Agent 对象）', async () => {
  const jobs = makeJobs({ withEvents: true });
  const { ctx, routes, handlers } = makeCtx({ jobs });
  applyPlugin(ctx);

  await runBackgroundCall(handlers);          // 登记背景任务（agent.id = session-1）

  const list = makeReqRes({ body: {} });
  await byPath(routes, '/api/dsh-pwsh-progress/list').handler(list.req, list.res);
  assert.equal(list.get().status, 200);
  // 登记时会先取一次快照，list 再取一次 ⇒ 至少 1 次；关键是**每一次** caller 都是 session id 字符串
  assert.ok(jobs.calls.get.length >= 1, '至少要查过一次快照');
  for (const call of jobs.calls.get) {
    assert.equal(call.caller, 'session-1', 'caller 必须是 session id 字符串（传 Agent 对象会被归属栅栏判成别人的任务）');
  }
  assert.equal(list.get().payload.jobs.length, 1);
  assert.equal(list.get().payload.jobs[0].status, 'running');

  const kill = makeReqRes({ body: { jobId: 'pwsh-1' } });
  await byPath(routes, '/api/dsh-pwsh-progress/kill').handler(kill.req, kill.res);
  assert.equal(jobs.calls.kill.length, 1);
  assert.equal(jobs.calls.kill[0].caller, 'session-1', 'kill 的 caller 也必须是 session id 字符串');
});

test('投影 progress 兜底：输出里没有百分比时，用内核的进度行当标签', async () => {
  const jobs = makeJobs({ withEvents: true, withProgress: true });
  const { ctx, routes, handlers } = makeCtx({ jobs });
  applyPlugin(ctx);
  await runBackgroundCall(handlers);

  const list = makeReqRes({ body: {} });
  await byPath(routes, '/api/dsh-pwsh-progress/list').handler(list.req, list.res);
  const row = list.get().payload.jobs[0];
  assert.equal(row.progressLabel, 'warm-up');
  assert.equal(row.progressPct, null, '纯文本进度行没有百分比 ⇒ 前端走不确定进度条');
});

test('job_output 旁路：解析出的 N/M 进度进入 state 路由', async () => {
  const jobs = makeJobs({ withEvents: true });
  const { ctx, routes, handlers } = makeCtx({ jobs });
  applyPlugin(ctx);
  await runBackgroundCall(handlers);

  const exec = { name: 'job_output', agent: { id: 'session-1' }, arguments: { job_id: 'pwsh-1' } };
  await handlers.get('tools/execute')(exec, async () => ({ isError: false, value: { text: 'step 7/10\n' } }));

  const state = makeReqRes({ body: { jobId: 'pwsh-1' } });
  await byPath(routes, '/api/dsh-pwsh-progress/state').handler(state.req, state.res);
  const s = state.get().payload;
  assert.equal(s.progressPct, 0.7);
  assert.equal(s.progressLabel, '70%（7/10）');
});

test('路由栅栏：非回环来源 403、错误方法 405、未知 job 回 unknown', async () => {
  const jobs = makeJobs({ withEvents: true });
  const { ctx, routes } = makeCtx({ jobs });
  applyPlugin(ctx);
  const list = byPath(routes, '/api/dsh-pwsh-progress/list');

  const foreign = makeReqRes({ body: {} });
  foreign.req.socket.remoteAddress = '10.0.0.5';
  await list.handler(foreign.req, foreign.res);
  assert.equal(foreign.get().status, 403);

  const wrongMethod = makeReqRes({ method: 'GET', body: {} });
  await list.handler(wrongMethod.req, wrongMethod.res);
  assert.equal(wrongMethod.get().status, 405);

  const state = makeReqRes({ body: { jobId: 'nope-1' } });
  await byPath(routes, '/api/dsh-pwsh-progress/state').handler(state.req, state.res);
  assert.equal(state.get().payload.unknown, true);
});
