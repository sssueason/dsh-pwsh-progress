# Changelog

## 0.1.0 (2026-08-26)

- 首版发布：对话流实时 pwsh 进度卡片（`tool.call.toolview` key=`'pwsh'`，官方未占用、注册为 additive）。
- 实时状态：运行中（spinner + 已耗时）/ 停止中 / ✓ 完成 / ⏹ 已停止 / ✗ 失败 + 总耗时 + exit detail。
- **进度条**：从模型 `job_output` 已读的输出副本解析 `N/M` 与 `NN%`（非消费式，不碰输出游标）。
- **预计剩余时间（ETA）**：输出进度比例估算优先；无进度时同命令历史均值兜底（标注「基于历史」），历史自动学习（仅 completed 样本）。
- 「停止任务」按钮（`jobs.kill`）。
- 前台 pwsh 调用：命令 + 完整输出 + 完成/失败徽章（不劣于默认卡片）。
- 降级：任务无法跟踪（插件重启后、job 已移除）时显示基础卡片，不抛错。
- 宿主半边：`tools/execute` 瀑布旁路登记（不改 exec、不透传改动）+ 非消费式 `jobs.get` 跟踪 + 回环/同源 HTTP 路由 `/api/dsh-pwsh-progress/{state,kill}`。
- 浏览器半边：注册 `tool.call.toolview` key=`'pwsh'` 卡片，700ms 轮询，失败一律降级渲染。
