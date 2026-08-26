/**
 * dsh-pwsh-progress — 浏览器半边（模块系统以 CJS 工厂加载）。
 *
 * 为对话流中的 pwsh 工具调用注册自定义卡片（tool.call.toolview
 * key='pwsh'，该 key 官方未占用，注册是 additive）：
 * - 前台调用：命令 + 输出 + 完成/失败徽章；
 * - 后台调用（run_in_background）：命令 + 实时状态（运行中 spinner +
 *   已耗时 / 停止 / 完成 / 失败）+ **进度条**（解析模型 job_output 已读
 *   输出中的 N/M 与百分比）+ **预计剩余时间**（输出进度优先、历史均值
 *   兜底）+「停止任务」按钮，经 POST /api/dsh-pwsh-progress/{state,kill}
 *   轮询宿主半边（非消费式 jobs.get，不影响模型 job_output）。
 * 失败策略：解析/请求异常一律降级渲染基础卡片，不抛错。
 *
 * 依赖：ctx.slots（注册）、ctx.timer（轮询）。react 由模块系统内核提供。
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
.pwshcard-pct{flex:none;font-size:11px;opacity:.85;white-space:nowrap}
.pwshcard-actions{display:flex;gap:6px;align-items:center}
.pwshcard-btn{background:rgba(248,81,73,.14);border:1px solid rgba(248,81,73,.55);color:#f85149;border-radius:5px;font-size:11px;padding:1px 9px;cursor:pointer}
.pwshcard-btn:hover{background:rgba(248,81,73,.25)}
.pwshcard-btn:disabled{opacity:.45;cursor:default}
.pwshcard-note{opacity:.55;font-size:10.5px}
`;

    /** 轮询宿主半边（仅回环 + 同源，跨域拒绝由宿主处理）。 */
    async function fetchState(jobId) {
      const r = await fetch('/api/dsh-pwsh-progress/state', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobId }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }

    async function fetchKill(jobId) {
      const r = await fetch('/api/dsh-pwsh-progress/kill', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobId }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }

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
        const bar = pct !== null
          ? h('div', { className: 'pwshcard-progress' }, [
              h('div', { className: 'pwshcard-bar' }, [
                h('span', { className: 'pwshcard-fill', style: { width: Math.max(2, Math.min(100, pct * 100)) + '%' } }),
              ]),
              h('span', { className: 'pwshcard-pct' }, d.progressLabel !== null && d.progressLabel !== undefined ? d.progressLabel : Math.round(pct * 100) + '%'),
            ])
          : null;
        body = h('div', { className: 'pwshcard-body' }, [
          h('span', { className: 'pwshcard-meta' }, [
            h('span', { className: 'pwshcard-spin' }),
            ' 运行中 · 已耗时 ' + fmtElapsed(d.elapsedMs),
          ]),
          bar,
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

    /** 服务依赖：插槽注册 + 定时器。 */
    exports.inject = ['slots', 'timer'];

    /** 挂载：注入样式 + 注册 pwsh 工具卡片。 */
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
    };

    return module.exports;
  },
});
