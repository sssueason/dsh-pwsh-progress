# dsh-pwsh-progress

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

DeepSeek Harness（DSH）对话流实时任务进度插件：为后台任务（`run_in_background`）渲染进度卡片与常驻任务条——状态、耗时、进度条、预计剩余时间、停止按钮，无需刷新页面。

```text
┌──────────────────────────────────────────────────────────┐
│ PWSH  1..25 | ForEach-Object { Write-Output "step $_/25" } │
│ ⏳ 运行中 · 已耗时 14.2s                                    │
│ [██████████████░░░░░░░░] 56%（14/25）                       │
│ 预计剩余 ~11s                                             │
│ [停止任务]                                                │
└──────────────────────────────────────────────────────────┘
```

## 功能

- 实时状态：运行中 / 停止中 / 完成 / 已停止 / 失败，含耗时与 exit code
- 进度条：从模型 `job_output` 已读输出解析 `N/M`、`NN%`
- 预计剩余时间：输出进度估算；无进度时按同命令历史均值（标注「基于历史」）
- 停止按钮：一键 `jobs.kill`
- 通用覆盖：任何工具的后台任务（pwsh / bash / subagent / …）在每轮回复尾部显示活跃任务条；pwsh 另有就地进度卡片

## 安装

```sh
dsh plugin --profile web add "github:sssueason/dsh-pwsh-progress#main"
```

或 npm 发布后：`npm add dsh-pwsh-progress && dsh plugin --profile web add dsh-pwsh-progress`。重启 `dsh web` 生效。

## 原理

- 宿主侧：`tools/execute` 旁路登记所有返回后台 jobId 的调用，用非消费式 `jobs.get` 跟踪状态——不调用 `jobs.read`，模型 `job_output` 不受影响；进度解析自模型已读的输出副本
- 路由（仅回环 + 同源）：`POST /api/dsh-pwsh-progress/{state,list,kill}`
- 浏览器侧：`tool.call.toolview`（pwsh 卡片）+ `conversation.chat.turnTail`（活跃任务条），轮询刷新，失败降级不报错

## 限制

- pwsh 卡片替换官方同名卡片（Slot 语义）；其他工具仅任务条
- 无输出 tail（输出仍经 `job_output` 呈现）
- 历史估算在宿主进程内，重启即失

## 测试

```sh
node --test test/smoke.test.mjs
```

MIT © 2026 dsh-pwsh-progress authors
