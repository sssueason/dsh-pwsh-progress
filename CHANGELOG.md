# Changelog

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
