/**
 * dsh-pwsh-progress — 对话流实时 pwsh 进度卡片（宿主半边）。
 *
 * 为 pwsh 工具（尤其 run_in_background 后台任务）提供实时进度数据：
 * 1. tools/execute 旁路登记：仅观察 pwsh 后台调用与 job_output 读取，
 *    不改 exec、不透传改动；后台调用解析返回的 jobId 并登记；
 * 2. 非消费式跟踪：jobs.get(jobId, agent) 只读 JobSnapshot（status/detail/
 *    startedAt/finishedAt），绝不调用 jobs.read —— 输出游标留给模型
 *    job_output，模型读取行为完全不受影响；
 * 3. 进度与 ETA：
 *    - 从模型 job_output 已读的输出副本（result.value.text，非消费）解析
 *      `N/M` 与 `NN%` 进度 → 实时进度条 + 按比例估算预计剩余时间；
 *    - 无输出进度时用历史均值兜底（命令规范化键 → completed 时长样本）；
 * 4. HTTP 路由（仅回环 + 同源）供浏览器半边轮询：
 *    POST /api/dsh-pwsh-progress/state {jobId} -> 标量状态 + 进度 + ETA
 *    POST /api/dsh-pwsh-progress/kill  {jobId} -> 请求停止
 *
 * 浏览器半边（exports "./client"）注入 tool.call.toolview key='pwsh'
 * 渲染进度卡片。本文件与动态插件 pwsh-1 的宿主逻辑同源。
 */

/** 稳定 cordis 插件名。 */
export const name = 'pwsh-progress';

/** 服务依赖：Web 路由表 + 系统提示公告。jobs 经 ctx.get 按需读取。 */
export const inject = ['webServer', 'systemPrompt'];

/** 公告小节顺序（工具引导带内）。 */
const SECTION_ORDER = 215;

/** 模型可见公告。 */
export const PWSH_PROGRESS_GUIDANCE = '本机已安装 dsh-pwsh-progress 插件（对话流实时 pwsh 进度卡片）：pwsh 后台任务（run_in_background）会在对话流中显示实时进度卡片（状态/进度条/预计剩余时间/停止按钮），输出仍通过 job_output 读取，两者互补。';

/** 回环 + 同源信任栅栏（只读状态 + 停止请求，仍按 dsh-ssh/dsh-cot 同款收紧）。 */
function isLoopbackRequest(request) {
  const address = request.socket.remoteAddress;
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false;
  const host = request.headers.host;
  if (typeof host !== 'string') return false;
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    return false;
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false;
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

/** 单条 JSON 响应。 */
function writeJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' });
  res.end(JSON.stringify(body));
}

/** 读取小 JSON 请求体。 */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk;
    size += buffer.length;
    if (size > 65536) {
      throw new Error('request body too large');
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw new Error('invalid JSON body');
  }
}

/** 命令规范化键：小写、数字归一、空白折叠、截断。 */
function cmdKeyOf(command) {
  return String(command || '').toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 80);
}

/**
 * 从文本解析进度：优先 `N/M`（逐行从后往前），其次 `NN%`。
 * @returns {{ kind: 'ratio', current: number, total: number } | { kind: 'percent', pct: number } | null}
 */
function parseProgress(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.length === 0) continue;
    const ratio = /(\d+)\s*\/\s*(\d+)/.exec(line);
    if (ratio !== null) {
      const current = Number(ratio[1]);
      const total = Number(ratio[2]);
      if (total > 0 && current >= 0 && current <= total) {
        return { kind: 'ratio', current, total };
      }
    }
    const percent = /(\d+(?:\.\d+)?)\s*%/.exec(line);
    if (percent !== null) {
      const pct = Number(percent[1]);
      if (pct >= 0 && pct <= 100) {
        return { kind: 'percent', pct: pct / 100 };
      }
    }
  }
  return null;
}

/** 进度 → 0..1 比例。 */
function pctOf(progress) {
  if (progress === null) return null;
  if (progress.kind === 'ratio') return progress.current / progress.total;
  return progress.pct;
}

/** 进度 → 展示标签。 */
function progressLabel(progress) {
  if (progress === null) return null;
  if (progress.kind === 'ratio') return Math.round(progress.current / progress.total * 100) + '%（' + progress.current + '/' + progress.total + '）';
  return Math.round(progress.pct * 100) + '%';
}

/**
 * 挂载：事件旁路登记 + jobs 跟踪 + HTTP 路由 + 系统提示公告。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文（webServer/systemPrompt 已注入）。
 */
export function apply(ctx) {
  const jobs = ctx.get('jobs');
  // 登记表：jobId -> { agent, callId, command, last, progress, learned }；callId -> 调用元信息。
  const byCall = new Map();
  const byJob = new Map();
  // 历史学习：命令规范化键 -> { count, sumMs }（仅统计 completed）。
  const history = new Map();

  /** 非消费式快照：jobs.get 不动输出游标，模型 job_output 完全不受影响。 */
  const snapshotOf = (jobId) => {
    const entry = byJob.get(jobId);
    if (entry === undefined) return null;
    try {
      const snap = jobs.get(jobId, entry.agent);
      entry.last = {
        status: snap.status,
        detail: typeof snap.detail === 'string' ? snap.detail : null,
        startedAt: typeof snap.startedAt === 'number' ? snap.startedAt : null,
        finishedAt: typeof snap.finishedAt === 'number' ? snap.finishedAt : null,
        label: snap.label,
      };
      // 完成时记录历史（仅 completed，避免被 kill/fail 时长污染）。
      if (snap.status === 'completed' && entry.learned !== true &&
          entry.last.startedAt !== null && entry.last.finishedAt !== null) {
        entry.learned = true;
        const key = cmdKeyOf(entry.command);
        const duration = entry.last.finishedAt - entry.last.startedAt;
        if (duration > 0) {
          const rec = history.get(key);
          if (rec !== undefined) { rec.count += 1; rec.sumMs += duration; } else { history.set(key, { count: 1, sumMs: duration }); }
        }
      }
    } catch {
      entry.last = { status: 'gone', detail: null, startedAt: null, finishedAt: null, label: null };
    }
    return entry.last;
  };

  /** 计算 ETA：输出进度优先，历史均值兜底。 */
  const computeEta = (entry, now) => {
    if (entry === undefined || entry.last === null || entry.last.startedAt === null) return { etaMs: null, basis: null };
    const elapsed = now - entry.last.startedAt;
    const pct = pctOf(entry.progress);
    if (pct !== null && pct > 0.001 && pct < 0.999) {
      const remaining = elapsed * (1 - pct) / pct;
      return { etaMs: Math.round(remaining), basis: 'progress' };
    }
    const rec = history.get(cmdKeyOf(entry.command));
    if (rec !== undefined && rec.count > 0) {
      const avg = rec.sumMs / rec.count;
      const remaining = avg - elapsed;
      if (remaining > 0) return { etaMs: Math.round(remaining), basis: 'history' };
    }
    return { etaMs: null, basis: null };
  };

  // 旁路观察：pwsh 后台调用登记 + job_output 输出解析进度。
  ctx.on('tools/execute', async (exec, next) => {
    const isBackgroundPwsh =
      exec.name === 'pwsh' &&
      exec.arguments !== null && typeof exec.arguments === 'object' &&
      exec.arguments.run_in_background === true;
    const isJobOutput = exec.name === 'job_output' &&
      exec.arguments !== null && typeof exec.arguments === 'object' &&
      typeof exec.arguments.job_id === 'string';
    if (jobs === undefined) return next();
    if (isBackgroundPwsh) {
      const callId = exec.callId;
      const command = typeof exec.arguments.command === 'string' ? exec.arguments.command : '';
      byCall.set(callId, { command, startedAt: Date.now(), status: 'starting', jobId: null });
      try {
        const result = await next();
        if (!result.isError && result.value !== null && typeof result.value === 'object' &&
            result.value.kind === 'background' && typeof result.value.jobId === 'string') {
          const jobId = result.value.jobId;
          const rec = byCall.get(callId);
          if (rec !== undefined) { rec.jobId = jobId; rec.status = 'tracking'; }
          byJob.set(jobId, { agent: exec.agent, callId, command, last: null, progress: null, learned: false });
          snapshotOf(jobId);
        } else {
          const rec = byCall.get(callId);
          if (rec !== undefined) rec.status = 'untrackable';
        }
        return result;
      } catch (err) {
        const rec = byCall.get(callId);
        if (rec !== undefined) rec.status = 'failed';
        throw err;
      }
    }
    if (isJobOutput) {
      const jobId = exec.arguments.job_id;
      const entry = byJob.get(jobId);
      if (entry === undefined) return next();
      try {
        const result = await next();
        // 从模型已读的输出副本解析进度（非消费：不碰 jobs 游标）。
        if (!result.isError && result.value !== null && typeof result.value === 'object' &&
            typeof result.value.text === 'string') {
          const parsed = parseProgress(result.value.text);
          if (parsed !== null) entry.progress = parsed;
        }
        return result;
      } catch (err) {
        throw err;
      }
    }
    return next();
  });

  if (jobs !== undefined) {
    ctx.effect(() => jobs.onJobsChanged(() => {
      for (const jobId of byJob.keys()) snapshotOf(jobId);
    }), 'pwsh-progress: jobs observer');
  }

  ctx.effect(() => ctx.webServer.register({
    path: '/api/dsh-pwsh-progress/state',
    async handler(req, res) {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { error: 'forbidden' });
        return;
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { error: `method not allowed: ${req.method}` });
        return;
      }
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        writeJson(res, 400, { error: String(err && err.message ? err.message : err) });
        return;
      }
      const jobId = typeof body.jobId === 'string' ? body.jobId : null;
      if (jobId === null) {
        writeJson(res, 400, { error: 'jobId required' });
        return;
      }
      const snap = snapshotOf(jobId);
      if (snap === null) {
        writeJson(res, 200, { unknown: true });
        return;
      }
      const entry = byJob.get(jobId);
      const now = Date.now();
      const eta = computeEta(entry, now);
      const pct = entry !== undefined ? pctOf(entry.progress) : null;
      writeJson(res, 200, {
        jobId,
        status: snap.status,
        detail: snap.detail,
        startedAt: snap.startedAt,
        finishedAt: snap.finishedAt,
        command: entry !== undefined ? entry.command : null,
        elapsedMs: snap.finishedAt !== null ? snap.finishedAt - snap.startedAt
          : (snap.startedAt !== null ? now - snap.startedAt : null),
        progressPct: pct,
        progressLabel: entry !== undefined ? progressLabel(entry.progress) : null,
        etaMs: eta.etaMs,
        etaBasis: eta.basis,
      });
    },
  }), 'pwsh-progress: state route');

  ctx.effect(() => ctx.webServer.register({
    path: '/api/dsh-pwsh-progress/kill',
    async handler(req, res) {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { error: 'forbidden' });
        return;
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { error: `method not allowed: ${req.method}` });
        return;
      }
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        writeJson(res, 400, { error: String(err && err.message ? err.message : err) });
        return;
      }
      const jobId = typeof body.jobId === 'string' ? body.jobId : null;
      if (jobId === null) {
        writeJson(res, 400, { error: 'jobId required' });
        return;
      }
      const entry = byJob.get(jobId);
      if (entry === undefined || jobs === undefined) {
        writeJson(res, 200, { unknown: true });
        return;
      }
      try {
        const outcome = jobs.kill(jobId, entry.agent);
        writeJson(res, 200, { outcome });
      } catch (err) {
        writeJson(res, 200, { error: String(err && err.message ? err.message : err) });
      }
    },
  }), 'pwsh-progress: kill route');

  ctx.systemPrompt.section({
    name: 'tool:pwsh-progress',
    order: SECTION_ORDER,
    text: PWSH_PROGRESS_GUIDANCE,
  });
}

// 测试出口：纯函数导出（对生产无副作用；模块无外部依赖，可直接 import）。
export { cmdKeyOf, parseProgress, pctOf, progressLabel };
