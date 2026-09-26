/**
 * dsh-pwsh-progress — 宿主侧。
 *
 * tools/execute 旁路登记所有后台任务（返回 {kind:'background', jobId} 的调用），
 * 用非消费式 jobs.get 跟踪状态（绝不调用 jobs.read，模型 job_output 不受影响）；
 * 从模型 job_output 已读输出解析 N/M、NN% 进度并估算 ETA（历史均值兜底）。
 * 路由（仅回环 + 同源）：POST /api/dsh-pwsh-progress/{state,list,kill}
 *
 * 与内核 jobs 服务的契约（2026-09-26 对齐，见 test/host.test.mjs 的回归）：
 *   · `jobs.get(id, caller)` / `jobs.kill(id, caller, reason)` 的 `caller` 是 **SessionId 字符串**
 *     （`exec.agent?.id`），不是 Agent 对象 —— 传错就会被归属栅栏判成别人的任务；
 *   · 任务事件走 **`jobs.events.subscribe(filter, listener)`**（`{}` = 全部所有者）；
 *     老内核的 `jobs.onJobsChanged` 作为兜底保留；
 *   · 投影里的 `progress` 是内核新增的一等进度行（生产者 `updateProgress` 发布），可当标签兜底。
 *
 * ★ 注册顺序契约：**可见面（路由 / 系统提示）先注册，可选观察者最后注册**，且观察者失败要降级不抛 ——
 *   否则一次 API 漂移就会让整个插件在 UI 上静默消失（2026-09-26 真实事故）。
 */

/** 稳定 cordis 插件名。 */
export const name = 'pwsh-progress';

/** 服务依赖：Web 路由表 + 系统提示公告 + timer（ctx.setInterval 探测）。jobs 经 ctx.get 按需读取。 */
export const inject = ['systemPrompt', 'timer'];

/** 公告小节顺序（工具引导带内）。 */
const SECTION_ORDER = 215;

/** 模型可见公告。 */
export const PWSH_PROGRESS_GUIDANCE = '本机已安装 dsh-pwsh-progress 插件（对话流实时任务进度）：pwsh/bash 等后台任务（run_in_background）会在对话流与每轮回复尾部显示实时进度（进度条/预计剩余时间/停止按钮），输出仍通过 job_output 读取，两者互补。';

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
  // 登记表：jobId -> { jobId, agent, callId, command, last, progress, rate, lastPct, lastProgressAt, learned }。
  const byJob = new Map();
  // 历史学习：命令规范化键 -> { count, sumMs }（仅统计 completed）。
  const history = new Map();

  /** 工具调用的展示标签：command > description > label > 工具名。 */
  const labelOf = (exec) => {
    const a = exec.arguments;
    if (a !== null && typeof a === 'object') {
      if (typeof a.command === 'string' && a.command.length > 0) return a.command;
      if (typeof a.description === 'string' && a.description.length > 0) return a.description;
      if (typeof a.label === 'string' && a.label.length > 0) return a.label;
    }
    return exec.name;
  };

  /** 非消费式快照：jobs.get 不动输出游标，模型 job_output 完全不受影响。 */
  const snapshotOf = (jobId) => {
    const entry = byJob.get(jobId);
    if (entry === undefined) return null;
    try {
      /* 2026-09-26 修：caller 必须是 **SessionId 字符串**。内核 `jobs.get(id, caller)` 用它做归属栅栏
         （dsh-jobs-local 的 assertAccess：`job.owner.id !== caller` ⇒ 抛 "belongs to another session"），
         旧代码传的是 Agent 对象 ⇒ 每个有主任务都被判成"别人的任务"，卡片只能显示 gone。 */
      const snap = jobs.get(jobId, entry.agentId);
      entry.last = {
        status: snap.status,
        detail: typeof snap.detail === 'string' ? snap.detail : null,
        startedAt: typeof snap.startedAt === 'number' ? snap.startedAt : null,
        finishedAt: typeof snap.finishedAt === 'number' ? snap.finishedAt : null,
        label: snap.label,
        /* 内核新增的一等进度行（生产者经 handle.updateProgress 发布；pwsh 工具不发布，workflow/subagent 会）。
           取不到就保持 null，仍走"解析 job_output 输出"的老路。 */
        progress: typeof snap.progress === 'string' ? snap.progress : null,
      };
      // 仅 completed 记历史
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

  /** 当前进度：最新解析值 + 两次读取间按速率平滑外推。 */
  const currentPct = (entry, now) => {
    const base = pctOf(entry.progress);
    if (entry.rate > 0 && entry.lastPct !== null && entry.lastProgressAt !== null &&
        entry.last !== null && entry.last.status === 'running') {
      const projected = entry.lastPct + entry.rate * (now - entry.lastProgressAt);
      if (projected > base) return Math.min(projected, 0.99);
    }
    return base;
  };

  /** 计算 ETA：输出进度优先，历史均值兜底。 */
  const computeEta = (entry, now) => {
    if (entry === undefined || entry.last === null || entry.last.startedAt === null) return { etaMs: null, basis: null };
    const elapsed = now - entry.last.startedAt;
    const pct = currentPct(entry, now);
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

  /** 单任务标量投影（纯 JSON）。 */
  const stateOf = (entry, now) => {
    const snap = entry.last;
    if (snap === null) return null;
    const eta = computeEta(entry, now);
    const pct = currentPct(entry, now);
    return {
      jobId: entry.jobId,
      status: snap.status,
      detail: snap.detail,
      startedAt: snap.startedAt,
      finishedAt: snap.finishedAt,
      command: entry.command,
      elapsedMs: snap.finishedAt !== null ? snap.finishedAt - snap.startedAt
        : (snap.startedAt !== null ? now - snap.startedAt : null),
      progressPct: pct,
      /* 输出里解析不到百分比时，退到内核给的生产者进度行（纯文本，前端显示不确定进度条 + 这行字）。 */
      progressLabel: progressLabel(entry.progress) ?? (snap.progress !== null && snap.progress !== undefined ? snap.progress : null),
      etaMs: eta.etaMs,
      etaBasis: eta.basis,
    };
  };

  // 旁路观察：任何工具的后台结果登记 + job_output 输出解析进度。
  ctx.on('tools/execute', async (exec, next) => {
    if (jobs === undefined) return next();
    const isJobOutput = exec.name === 'job_output' &&
      exec.arguments !== null && typeof exec.arguments === 'object' &&
      typeof exec.arguments.job_id === 'string';
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
          if (parsed !== null) {
            const now = Date.now();
            const newPct = pctOf(parsed);
            if (entry.lastPct !== null && entry.lastProgressAt !== null && newPct > entry.lastPct) {
              const dt = now - entry.lastProgressAt;
              if (dt > 500) entry.rate = (newPct - entry.lastPct) / dt;
            }
            entry.progress = parsed;
            entry.lastPct = newPct;
            entry.lastProgressAt = now;
          }
        }
        return result;
      } catch (err) {
        throw err;
      }
    }
    // 通用登记：任何工具返回 background jobId 即跟踪（pwsh/bash/subagent/…）。
    try {
      const result = await next();
      if (!result.isError && result.value !== null && typeof result.value === 'object' &&
          result.value.kind === 'background' && typeof result.value.jobId === 'string') {
        const jobId = result.value.jobId;
        if (!byJob.has(jobId)) {
          byJob.set(jobId, {
            jobId,
            /* 归属栅栏用的 **SessionId 字符串**（不是 Agent 对象）——见 snapshotOf 里的注释。 */
            agentId: exec.agent?.id,
            callId: exec.callId,
            command: labelOf(exec),
            last: null,
            progress: null,
            rate: 0,
            lastPct: null,
            lastProgressAt: null,
            learned: false,
          });
          snapshotOf(jobId);
        }
      }
      return result;
    } catch (err) {
      throw err;
    }
  });

  /* 任务事件：内核 2026-09 起把 `jobs.onJobsChanged` 换成了事件流 `jobs.events.subscribe(filter, listener)`
     （@deepseek-ai/dsh-jobs：filter 可为 {} / {owner} / {owners:'scope'}；事件类型
     registered / progress / stopping / settled / removed / output）。两条都试，向后兼容。
     ★ 这里只定义、**不注册** —— 观察者属可选能力，它失败绝不能连坐路由与系统提示（调用点在文件末尾）。 */
  const observeJobs = () => {
    if (jobs === undefined) return;
    const refresh = () => { for (const jobId of byJob.keys()) snapshotOf(jobId); };
    if (jobs.events !== undefined && typeof jobs.events.subscribe === 'function') {
      ctx.effect(() => jobs.events.subscribe({}, refresh), 'pwsh-progress: jobs observer (events.subscribe)');
      return;
    }
    if (typeof jobs.onJobsChanged === 'function') {
      ctx.effect(() => jobs.onJobsChanged(refresh), 'pwsh-progress: jobs observer (onJobsChanged)');
    }
  };

  /** POST /state {jobId} → 单个任务状态 + 进度 + ETA。 */
  const registerRoutes = (webServer) => {
    ctx.effect(() => webServer.register({
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
      writeJson(res, 200, stateOf(byJob.get(jobId), Date.now()));
    },
  }), 'pwsh-progress: state route');

  /** POST /list {} → 全部已登记任务（活跃优先）。 */
  ctx.effect(() => webServer.register({
    path: '/api/dsh-pwsh-progress/list',
    async handler(req, res) {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { error: 'forbidden' });
        return;
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { error: `method not allowed: ${req.method}` });
        return;
      }
      const now = Date.now();
      const out = [];
      for (const [jobId, entry] of byJob) {
        entry.jobId = jobId;
        snapshotOf(jobId);
        const s = stateOf(entry, now);
        if (s !== null) out.push(s);
      }
      const rank = (status) => status === 'running' ? 0 : status === 'stopping' ? 1 : 2;
      out.sort((a, b) => rank(a.status) - rank(b.status) || (b.startedAt || 0) - (a.startedAt || 0));
      writeJson(res, 200, { jobs: out });
    },
  }), 'pwsh-progress: list route');

  /** POST /kill {jobId} → 请求停止。 */
  ctx.effect(() => webServer.register({
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
        const outcome = jobs.kill(jobId, entry.agentId, 'stopped from progress card');
        writeJson(res, 200, { outcome });
      } catch (err) {
        writeJson(res, 200, { error: String(err && err.message ? err.message : err) });
      }
    },
  }), 'pwsh-progress: kill route');
  };

  // webServer 可选：无 webServer 的 profile（tui/CLI）不挂起，路由探测注册（最多 30s）
  let ws = ctx.get('webServer')
  if (ws !== undefined) {
    registerRoutes(ws)
  } else {
    let tries = 0
    const probe = ctx.setInterval(() => {
      ws = ctx.get('webServer')
      if (ws !== undefined) {
        registerRoutes(ws)
        probe()
      } else if (++tries >= 15) {
        probe()
      }
    }, 2000)
  }

  ctx.systemPrompt.section({
    name: 'tool:pwsh-progress',
    order: SECTION_ORDER,
    text: PWSH_PROGRESS_GUIDANCE,
  });

  /* ★ 顺序契约（2026-09-26 修 —— 这次事故的教训就写在这里）：**可见面先注册，可选观察者最后注册**。
     原顺序是「观察者 → 路由 → 公告」，而观察者里那行 `jobs.onJobsChanged(...)` 在新内核上直接 TypeError
     ⇒ apply() 中途抛出 ⇒ 路由与系统提示公告**一起没注册**：插件在 UI 上彻底消失，且一行日志都没有
     （症状正是"进度条不见了"，却被误当成"pwsh 工具的问题"）。
     现在观察者失败只降级成"少一次实时推送"，前端本来就有 0.7–1s 轮询，功能不受影响。 */
  try {
    observeJobs();
  } catch (err) {
    const msg = `pwsh-progress: jobs 观察者注册失败（进度卡片仍可用，前端仍按轮询刷新）：${String(err && err.message ? err.message : err)}`;
    if (ctx.logger !== undefined && typeof ctx.logger.warn === 'function') ctx.logger.warn(msg);
    else console.warn(msg);
  }
}

// 测试出口：纯函数导出（对生产无副作用；模块无外部依赖，可直接 import）。
export { cmdKeyOf, parseProgress, pctOf, progressLabel };
