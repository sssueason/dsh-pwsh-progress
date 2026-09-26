# Changelog

## 0.2.4 (2026-09-26)

**修：内核 jobs 服务 API 漂移导致插件在 UI 上静默消失（"进度条不见了"）**

根因（对着 dsh 内核源码逐条核过）：
- `jobs.onJobsChanged` **已被删除**，换成事件流 `jobs.events.subscribe(filter, listener)`
  ⇒ 旧代码 `ctx.effect(() => jobs.onJobsChanged(...))` 直接 TypeError；
- 而该调用原在 `apply()` 的**中段**，抛出后**路由与系统提示公告一起没注册**（UI 上彻底消失，且零日志）；
- `jobs.get(id, caller)` / `jobs.kill(id, caller)` 的 `caller` 是 **SessionId 字符串**（内核用它做归属栅栏），
  旧代码传 Agent 对象 ⇒ 即使注册成功，每个任务也会被判成"别人的任务"、卡片只能显示 `gone`；
- 投影新增一等 `progress` 行（生产者 `updateProgress` 发布，pwsh 工具不发布、workflow/subagent 会）。

改动：
- 观察者改用 `jobs.events.subscribe({}, …)`，**保留 `onJobsChanged` 作为老内核兜底**；
- `jobs.get/kill` 的 caller 改为 `exec.agent?.id`（字符串）；
- 新增 **注册顺序契约**：可见面（路由 / 系统提示）先注册，可选观察者**最后**注册且失败只降级（不再连坐）；
- 新增 `progressLabel` 对投影 `progress` 的兜底（无百分比时显示该行文本 + 不确定进度条）。

测试：新增 `test/host.test.mjs`（8 条，最小 cordis 桩），锁住"新 API 下可见面必须全部注册 / caller 必须是
SessionId / 事件订阅走新 API / 老内核兼容 / 路由栅栏"；并做故障注入验证（关掉新 API 分支 ⇒ 立刻红）。
`npm test` 现跑 smoke（9）+ host（8）= 17 条。

## 0.2.1 (2026-08-26)

- 进度平滑：两次 `job_output` 之间按速率外推进度与 ETA（不再跳变）
- 无进度数据时显示不确定进度条（流动动画）

## 0.2.0 (2026-08-26)

- 通用化：登记所有工具的后台任务（pwsh / bash / subagent / …），不再限 pwsh
- 新增 `conversation.chat.turnTail` 常驻活跃任务条：每轮回复尾部显示运行中任务（命令 + 进度条 + % + ETA + 停止），无任务不占空间
- 新增 `/api/dsh-pwsh-progress/list` 路由（活跃优先排序）

## 0.1.0 (2026-08-26)

- pwsh 进度卡片（`tool.call.toolview` key=`'pwsh'`）：实时状态 / 进度条 / ETA / 停止按钮 / 终态
- 非消费式跟踪：`jobs.get` 只读，模型 `job_output` 不受影响
- ETA 双路：输出进度比例估算 + 同命令历史均值兜底
- 回环/同源路由：`/state`、`/kill`
