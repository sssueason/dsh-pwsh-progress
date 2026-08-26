# dsh-pwsh-progress

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Live progress UI for background jobs in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): status, elapsed time, progress bar, ETA and a Stop button, rendered inline in the chat — no page refresh.

```text
┌──────────────────────────────────────────────────────────┐
│ PWSH  1..25 | ForEach-Object { Write-Output "step $_/25" } │
│ ⏳ running · elapsed 14.2s                                 │
│ [██████████████░░░░░░░░] 56% (14/25)                      │
│ ~11s remaining                                           │
│ [Stop]                                                   │
└──────────────────────────────────────────────────────────┘
```

## Features

- Live status: running / stopping / done / stopped / failed, with elapsed time and exit code
- Progress bar: parses `N/M` and `NN%` from the output the model already read via `job_output`
- ETA: ratio-based estimate from progress; per-command history average as fallback (labelled "based on history")
- Stop button: one-click `jobs.kill`
- Generic: background jobs from any tool (pwsh / bash / subagent / …) show in an active-jobs bar after each turn; pwsh additionally gets an inline progress card

## Install

```sh
dsh plugin --profile web add "github:sssueason/dsh-pwsh-progress#main"
```

Or from npm (once published): `npm add dsh-pwsh-progress && dsh plugin --profile web add dsh-pwsh-progress`. Restart `dsh web` to take effect.

## How it works

- Host side: `tools/execute` passively registers every call that returns a background jobId, tracked via non-consumptive `jobs.get` — `jobs.read` is never called, so model `job_output` is unaffected; progress is parsed from the output copy the model already read
- Routes (loopback + same-origin only): `POST /api/dsh-pwsh-progress/{state,list,kill}`
- Browser side: `tool.call.toolview` (pwsh card) + `conversation.chat.turnTail` (active-jobs bar), polling, graceful degradation

## Limitations

- The pwsh card replaces the shipped card for that key (Slot semantics); other tools get the bar only
- No output tail (output still arrives via `job_output`)
- History estimates live in the host process; lost on restart

## Test

```sh
node --test test/smoke.test.mjs
```

MIT © 2026 dsh-pwsh-progress authors
