# dsh-pwsh-progress

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![dsh-plugin](https://img.shields.io/badge/dsh--plugin-ready-4c8dff)](https://github.com/topics/dsh-plugin)

**对话流实时 pwsh 进度卡片**：为 DeepSeek Harness（DSH）的 `pwsh` 工具调用（尤其 `run_in_background` 后台任务）渲染自定义工具卡片——命令、实时状态、**进度条**、**预计剩余时间（ETA）** 与「停止任务」按钮，全部就地显示在对话流中，无需刷新页面。

```text
┌──────────────────────────────────────────────────────────────┐
│ PWSH  1..25 | ForEach-Object { Write-Output "step $_/25"; … } │
│ ⏳ 运行中 · 已耗时 14.2s                                       │
│ [██████████████░░░░░░░░░░] 56%（14/25）                        │
│ 预计剩余 ~11s                                                 │
│ [停止任务]  输出将随 job_output 出现在对话中                    │
└──────────────────────────────────────────────────────────────┘
```

## 功能

| 能力 | 说明 |
|---|---|
| 实时状态 | 运行中（spinner + 已耗时）/ 停止中 / ✓ 完成 / ⏹ 已停止 / ✗ 失败 |
| **进度条** | 从模型 `job_output` 已读的输出副本解析 `N/M`（如 `443/1212`）与 `NN%`，实时渲染进度条 + 百分比标签 |
| **预计剩余时间** | 输出进度比例估算（准）；无输出进度时同命令历史均值兜底（标注「基于历史」），历史自动学习 |
| 停止任务 | 一键 `jobs.kill`，终态显示 ⏹ 已停止 + 耗时 + 原因 |
| 终态摘要 | ✓ 完成 / ✗ 失败 + 总耗时 + exit detail |
| 前台调用 | 命令 + 完整输出 + 完成/失败徽章（不劣于默认卡片） |
| 优雅降级 | 任务无法跟踪（插件重启后、job 已移除）时显示基础卡片，不抛错 |

## 与 dsh-task-status 的定位差异

GitHub 生态已有 [dsh-task-status](https://github.com/vlln/dsh-task-status)（输入框上方状态条 + 输出 tail）。本插件与其**互补而非重复**：

| 维度 | dsh-task-status | **dsh-pwsh-progress（本插件）** |
|---|---|---|
| 位置 | 输入框上方 dock 状态条（`conversation.input.dock`） | **对话流内工具卡片**（`tool.call.toolview` key=`'pwsh'`），命令卡片就地显示 |
| 进度条 + ETA | ❌ | ✅ 进度条 + 双路 ETA |
| 停止按钮 | ❌ | ✅ |
| 输出 tail | ✅（mirror patch 改写官方读取语义） | ❌（非消费约束下的取舍） |
| 对官方读取的侵入 | ⚠️ patch `tasks.read`（官方行为被改变） | ✅ **零侵入**：只用非消费式 `jobs.get` + 模型已读副本 |
| 覆盖工具 | 所有后台任务（通用） | pwsh 专属（可按同模式扩展） |

理想组合：本插件的卡片 + ETA + 停止，加上 dsh-task-status 的通用性与 tail。

## 安装

```sh
# 方式一：GitHub 源码（推荐，构建产物已提交）
dsh plugin --profile web add "github:sssueason/dsh-pwsh-progress#main"

# 方式二：npm
npm add dsh-pwsh-progress
dsh plugin --profile web add dsh-pwsh-progress

# 方式三：本地开发
dsh plugin --profile web add link:/path/to/dsh-pwsh-progress
```

重启 web（`dsh web`）后生效；可在设置页「插件」面板启用/停用。

## 工作原理

- **宿主半边**（`index.js`）：`tools/execute` 瀑布**旁路登记** pwsh 后台调用（解析 `jobId`、关联 agent，不改 exec、不透传改动）；用**非消费式** `jobs.get(jobId, agent)` 跟踪状态——**绝不调用 `jobs.read`**，输出游标完整留给模型，官方 `job_output` 语义零改动。
- **进度解析**：监听模型的 `job_output` 调用，从**模型已读的输出副本**（`result.value.text`）解析 `N/M` 与 `NN%`（非消费，不碰游标）。
- **ETA 双路**：① 有输出进度 → `已耗时 × (1−pct) / pct`；② 无进度 → 同命令历史均值（命令规范化键匹配，仅 completed 样本，自动学习）。
- **HTTP 路由**（仅回环 + 同源校验）：`POST /api/dsh-pwsh-progress/state`（状态 + 进度 + ETA）、`POST /api/dsh-pwsh-progress/kill`（停止）。
- **浏览器半边**（`lib/client.js`）：注册 `tool.call.toolview` key=`'pwsh'`（官方未占用，additive 不替换任何卡片），700ms 轮询，失败一律降级渲染。

## 适用场景

- 长命令批处理（抓取、构建、测试、数据管线）——输出带 `N/M` 或 `NN%` 进度时效果最佳。
- 需要「盯着对话流就能看到任务还有多久」的等待场景。
- 希望任务可随时手动停止的场景。

## 已知限制

- pwsh 专属（bash 等其他工具可按同一模式扩展 `tool.call.toolview` 的对应 key）。
- 无输出 tail（非消费约束下的设计取舍；输出仍经 `job_output` 完整呈现，两者互补）。
- ETA 首跑无历史时只显示已耗时；进度解析依赖模型实际执行 `job_output` 读取。
- 动态插件（会话级）重启后历史丢失；持久安装（本包形态）历史存活于宿主进程生命周期。

## 开发与测试

```sh
node --test test/smoke.test.mjs   # 纯函数单元测试（进度解析 / 命令规范化 / 标签）
```

纯 JS 零构建；宿主半边无外部依赖，可直接 import 测试。

## 许可

MIT © 2026 dsh-pwsh-progress authors
