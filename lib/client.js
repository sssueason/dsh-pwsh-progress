/**
 * dsh-pwsh-progress — 浏览器侧（模块系统以 CJS 工厂加载）。
 *
 * tool.call.toolview key='pwsh' 卡片 + conversation.chat.turnTail 活跃任务条，
 * 轮询 /api/dsh-pwsh-progress/{state,list,kill}，异常降级不报错。
 * 依赖：ctx.slots、ctx.timer；react 由模块系统内核提供。
 */
window.__ModuleLoader__.load({
  id: 'dsh-pwsh-progress',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require('react');

    const STYLE_TEXT = `
.pwshcard{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border:1px solid rgba(128,128,128,.35);border-radius:8px;background:rgba(128,128,128,.06);font-size:12px;line-height:1.45;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;color:inherit;min-width:0}
.pwshcard-head{display:flex;align-items:center;gap:8px;min-width:0}
.pwshcard-name{flex:none;font-size:10.5px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;opacity:.7}
.pwshcard-cmd{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.pwshcard-badge{flex:none;display:inline-flex;align-items:center;gap:5px;border-radius:10px;padding:1px 8px;font-size:11px;font-weight:600;border:1px solid}
.pwshcard-badge-running{border-color:rgba(210,153,34,.6);color:#d29922;background:rgba(210,153,34,.1)}
.pwshcard-badge-ok{border-color:rgba(63,185,80,.6);color:#3fb950;background:rgba(63,185,80,.1)}
.pwshcard-badge-err{border-color:rgba(248,81,73,.6);color:#f85149;background:rgba(248,81,73,.1)}
.pwshcard-badge-muted{border-color:rgba(128,128,128,.45);color:rgba(128,128,128,.85);background:rgba(128,128,128,.08)}
.pwshcard-spin{display:inline-block;width:10px;height:10px;border:2px solid rgba(210,153,34,.3);border-top-color:#d29922;border-radius:50%;animation:pwshcard-rot .8s linear infinite;vertical-align:-1px}
@keyframes pwshcard-rot{to{transform:rotate(360deg)}}
.pwshcard-body{display:flex;flex-direction:column;gap:4px;min-width:0}
.pwshcard-out{max-height:180px;overflow:auto;padding:6px 8px;border-radius:6px;background:rgba(0,0,0,.28);white-space:pre-wrap;word-break:break-word;font-size:11.5px;margin:0}
.pwshcard-meta{opacity:.68;font-size:11px}
.pwshcard-detail{opacity:.8;font-size:11px}
.pwshcard-progress{display:flex;align-items:center;gap:8px;min-width:0}
.pwshcard-bar{flex:1;min-width:0;height:7px;border-radius:4px;background:rgba(128,128,128,.16);overflow:hidden}
.pwshcard-fill{display:block;height:100%;border-radius:4px;background:linear-gradient(90deg,rgba(89,125,255,.75),rgba(63,185,80,.85));transition:width .5s ease}
.pwshcard-fill-indet{display:block;height:100%;width:32%;border-radius:4px;background:linear-gradient(90deg,rgba(89,125,255,.55),rgba(63,185,80,.75));animation:pwshcard-slide 1.4s ease-in-out infinite}
@keyframes pwshcard-slide{0%{transform:translateX(-110%)}100%{transform:translateX(420%)}}
.pwshcard-pct{flex:none;font-size:11px;opacity:.85;white-space:nowrap}
.pwshcard-actions{display:flex;gap:6px;align-items:center}
.pwshcard-btn{background:rgba(248,81,73,.14);border:1px solid rgba(248,81,73,.55);color:#f85149;border-radius:5px;font-size:11px;padding:1px 9px;cursor:pointer}
.pwshcard-btn:hover{background:rgba(248,81,73,.25)}
.pwshcard-btn:disabled{opacity:.45;cursor:default}
.pwshcard-note{opacity:.55;font-size:10.5px}
.pp-tail{display:flex;flex-direction:column;gap:4px;padding:6px 8px;border:1px solid rgba(210,153,34,.4);border-radius:8px;background:rgba(210,153,34,.07);font-size:11.5px;line-height:1.4;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;color:inherit;min-width:0}
.pp-tail-head{font-weight:600;opacity:.8;font-size:10.5px;text-transform:uppercase;letter-spacing:.4px}
.pp-tail-row{display:flex;align-items:center;gap:8px;min-width:0}
.pp-tail-cmd{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.9}
.pp-tail-eta{flex:none;white-space:nowrap;opacity:.75;font-size:11px}
.pp-tail-spin{display:inline-block;width:9px;height:9px;border:2px solid rgba(210,153,34,.3);border-top-color:#d29922;border-radius:50%;animation:pwshcard-rot .8s linear infinite;vertical-align:-1px;flex:none}
`;

    /** 轮询宿主侧（仅回环 + 同源，跨域拒绝由宿主处理）。 */
    async function postJson(path, body) {
      const r = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }

    const fetchState = (jobId) => postJson('/api/dsh-pwsh-progress/state', { jobId });
    const fetchList = () => postJson('/api/dsh-pwsh-progress/list', {});
    const fetchKill = (jobId) => postJson('/api/dsh-pwsh-progress/kill', { jobId });

    const fmtElapsed = (ms) => {
      if (ms === null || ms === undefined || Number.isNaN(ms)) return '—';
      if (ms < 1000) return Math.round(ms) + 'ms';
      return (ms / 1000).toFixed(1) + 's';
    };

    const fmtEta = (ms) => {
      if (ms === null || ms === undefined || Number.isNaN(ms) || ms < 0) return null;
      const s = Math.round(ms / 1000);
      if (s < 60) return s + 's';
      const m = Math.floor(s / 60);
      const r = s % 60;
      if (m < 60) return m + 'm' + (r > 0 ? ' ' + r + 's' : '');
      const h = Math.floor(m / 60);
      return h + 'h ' + (m % 60) + 'm';
    };

    const barOf = (pct, label, flex) => {
      const h = React.createElement;
      return h('div', { className: 'pwshcard-progress', style: flex !== undefined ? { flex } : undefined }, [
        h('div', { className: 'pwshcard-bar' }, [
          pct !== null && pct !== undefined
            ? h('span', { className: 'pwshcard-fill', style: { width: Math.max(2, Math.min(100, pct * 100)) + '%' } })
            : h('span', { className: 'pwshcard-fill-indet' }),
        ]),
        h('span', { className: 'pwshcard-pct' }, label !== null && label !== undefined ? label : '…'),
      ]);
    };

    function PwshCard(props) {
      const block = props.block;
      const timer = props.timer;
      const [state, setState] = React.useState({ kind: 'idle' });
      const [killing, setKilling] = React.useState(false);

      const settled = block !== null && typeof block === 'object' && block.kind === 'tool-result';
      const argsRaw = settled ? (block.call && block.call.argsRaw) : block.argsRaw;
      let args = null;
      if (typeof argsRaw === 'string' && argsRaw.length > 0) {
        try { args = JSON.parse(argsRaw); } catch (err) { args = null; }
      }
      const command = args !== null && typeof args.command === 'string' ? args.command : 'pwsh';
      const isBackground = args !== null && args.run_in_background === true;

      const contentText = settled ? (block.content || []).map((b) => b.type === 'text' && typeof b.text === 'string' ? b.text : '').join('') : '';
      const jobMatch = /pwsh-\d+/.exec(contentText);
      const jobId = jobMatch !== null ? jobMatch[0] : null;

      React.useEffect(() => {
        if (!settled || !isBackground || jobId === null) return undefined;
        let disposed = false;
        let disposer = null;
        const stop = () => { if (disposer !== null) { const d = disposer; disposer = null; d(); } };
        const poll = async () => {
          if (disposed) return;
          let data;
          try {
            data = await fetchState(jobId);
          } catch (err) {
            if (!disposed) { setState({ kind: 'error', message: String(err && err.message ? err.message : err) }); stop(); }
            return;
          }
          if (disposed) return;
          setState({ kind: 'data', data });
          if (data && data.unknown !== true && (data.status === 'completed' || data.status === 'killed' || data.status === 'failed' || data.status === 'gone')) {
            stop();
          }
        };
        disposer = timer.interval(() => { void poll(); }, 700);
        void poll();
        return () => { disposed = true; stop(); };
      }, [settled, isBackground, jobId]);

      const onKill = async () => {
        if (jobId === null) return;
        setKilling(true);
        try {
          await fetchKill(jobId);
        } catch (err) {
          setKilling(false);
        }
      };

      const h = React.createElement;
      const badge = (cls, text) => h('span', { className: 'pwshcard-badge ' + cls }, text);
      const head = h('div', { className: 'pwshcard-head' }, [
        h('span', { className: 'pwshcard-name' }, 'pwsh'),
        h('span', { className: 'pwshcard-cmd', title: command }, command),
      ]);

      if (!settled) {
        return h('div', { className: 'pwshcard' }, [
          head,
          h('div', { className: 'pwshcard-body' }, [
            isBackground
              ? h('span', { className: 'pwshcard-meta' }, [h('span', { className: 'pwshcard-spin' }), ' 已提交后台任务，等待 job id…'])
              : h('span', { className: 'pwshcard-meta' }, [h('span', { className: 'pwshcard-spin' }), ' 执行中…']),
          ]),
        ]);
      }

      if (!isBackground) {
        const errCode = block.isError === true && block.error && block.error.code ? block.error.code : null;
        return h('div', { className: 'pwshcard' }, [
          head,
          h('div', { className: 'pwshcard-body' }, [
            h('pre', { className: 'pwshcard-out' }, contentText),
            h('span', { className: 'pwshcard-meta' }, block.isError === true
              ? badge('pwshcard-badge-err', '✗ 失败' + (errCode !== null ? ' · ' + errCode : ''))
              : badge('pwshcard-badge-ok', '✓ 完成')),
          ]),
        ]);
      }

      const d = state.kind === 'data' ? state.data : null;
      let body;
      if (jobId === null) {
        body = h('span', { className: 'pwshcard-meta' }, '任务已提交（未解析到 job id）');
      } else if (state.kind === 'error') {
        body = h('span', { className: 'pwshcard-meta' }, '状态查询失败：' + state.message);
      } else if (d === null || d.unknown === true) {
        body = h('span', { className: 'pwshcard-meta' }, '任务已提交，当前无法跟踪状态');
      } else if (d.status === 'running' || d.status === 'stopping') {
        const pct = d.progressPct !== null && d.progressPct !== undefined ? d.progressPct : null;
        const etaText = d.etaMs !== null && d.etaMs !== undefined && d.etaMs >= 0 ? fmtEta(d.etaMs) : null;
        body = h('div', { className: 'pwshcard-body' }, [
          h('span', { className: 'pwshcard-meta' }, [
            h('span', { className: 'pwshcard-spin' }),
            ' 运行中 · 已耗时 ' + fmtElapsed(d.elapsedMs),
          ]),
          barOf(pct, d.progressLabel !== null && d.progressLabel !== undefined ? d.progressLabel : null),
          etaText !== null
            ? h('span', { className: 'pwshcard-meta' }, '预计剩余 ~' + etaText + (d.etaBasis === 'history' ? '（基于历史）' : ''))
            : null,
          d.status === 'stopping' ? h('span', { className: 'pwshcard-meta' }, '正在停止…') : null,
          h('div', { className: 'pwshcard-actions' }, [
            h('button', {
              className: 'pwshcard-btn',
              disabled: killing || d.status === 'stopping',
              onClick: onKill,
            }, killing ? '停止中…' : '停止任务'),
            h('span', { className: 'pwshcard-note' }, '输出将随 job_output 出现在对话中'),
          ]),
        ]);
      } else {
        const ok = d.status === 'completed';
        const label = d.status === 'completed' ? '✓ 完成' : d.status === 'killed' ? '⏹ 已停止' : d.status === 'failed' ? '✗ 失败' : d.status === 'gone' ? '任务已结束' : d.status;
        body = h('div', { className: 'pwshcard-body' }, [
          h('span', { className: ok ? 'pwshcard-badge pwshcard-badge-ok' : 'pwshcard-badge pwshcard-badge-err' }, label),
          d.finishedAt !== null && d.startedAt !== null
            ? h('span', { className: 'pwshcard-meta' }, '总耗时 ' + fmtElapsed(d.finishedAt - d.startedAt))
            : null,
          d.detail !== null && d.detail !== ''
            ? h('span', { className: 'pwshcard-detail' }, d.detail)
            : null,
        ]);
      }

      return h('div', { className: 'pwshcard' }, [head, body]);
    }

    /** 对话流常驻：活跃后台任务总览（覆盖所有工具的 run_in_background）。 */
    function ActiveJobsTail(props) {
      const timer = props.timer;
      const [jobs, setJobs] = React.useState(null);
      const [killing, setKilling] = React.useState({});

      React.useEffect(() => {
        let disposed = false;
        let disposer = null;
        const poll = async () => {
          if (disposed) return;
          try {
            const r = await fetchList();
            if (!disposed) setJobs(r && Array.isArray(r.jobs) ? r.jobs : []);
          } catch (err) {
            // 保持上次状态；查询失败不打扰对话
          }
        };
        disposer = timer.interval(() => { void poll(); }, 1000);
        void poll();
        return () => { disposed = true; if (disposer !== null) disposer(); };
      }, []);

      const active = (jobs || []).filter((j) => j.status === 'running' || j.status === 'stopping');
      if (active.length === 0) return null;

      const h = React.createElement;
      const onKill = async (jobId) => {
        setKilling((prev) => ({ ...prev, [jobId]: true }));
        try {
          await fetchKill(jobId);
        } catch (err) {
          setKilling((prev) => { const n = { ...prev }; delete n[jobId]; return n; });
        }
      };
      const rows = active.map((j) => {
        const pct = j.progressPct !== null && j.progressPct !== undefined ? j.progressPct : null;
        const etaText = j.etaMs !== null && j.etaMs !== undefined && j.etaMs >= 0 ? fmtEta(j.etaMs) : null;
        return h('div', { key: j.jobId, className: 'pp-tail-row' }, [
          h('span', { className: 'pp-tail-spin' }),
          h('span', { className: 'pp-tail-cmd', title: j.command }, j.command),
          barOf(pct, j.progressLabel !== null && j.progressLabel !== undefined ? j.progressLabel : null, '0 1 180px'),
          h('span', { className: 'pp-tail-eta' },
            etaText !== null ? '~' + etaText + (j.etaBasis === 'history' ? '（历史）' : '') : fmtElapsed(j.elapsedMs)),
          h('button', {
            className: 'pwshcard-btn',
            disabled: killing[j.jobId] === true || j.status === 'stopping',
            onClick: () => { void onKill(j.jobId); },
          }, killing[j.jobId] === true ? '停止中…' : '停止'),
        ]);
      });
      return h('div', { className: 'pp-tail' }, [
        h('div', { className: 'pp-tail-head' }, '后台任务 · ' + active.length),
        ...rows,
      ]);
    }

    /** 服务依赖：插槽注册 + 定时器。 */
    exports.inject = ['slots', 'timer'];

    /** 挂载：注入样式 + 注册 pwsh 卡片与活跃任务尾条。 */
    exports.apply = function apply(ctx) {
      const timer = ctx.timer;
      const slots = ctx.slots;
      const style = document.createElement('style');
      style.textContent = STYLE_TEXT;
      document.head.appendChild(style);
      ctx.effect(() => () => { style.remove(); }, 'dsh-pwsh-progress: styles');
      slots.inject('tool.call.toolview', () => slots.register(
        { name: 'tool.call.toolview', key: 'pwsh' },
        (props) => React.createElement(PwshCard, { block: props.block, callId: props.callId, timer }),
      ));
      slots.inject('conversation.chat.turnTail', () => slots.register(
        { name: 'conversation.chat.turnTail', select: () => true },
        (props) => React.createElement(ActiveJobsTail, { turn: props.turn, seq: props.seq, timer }),
      ));
    };

    return module.exports;
  },
});
