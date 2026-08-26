# dsh-pwsh-progress

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![dsh-plugin](https://img.shields.io/badge/dsh--plugin-ready-4c8dff)](https://github.com/topics/dsh-plugin)

**Live pwsh progress cards in the conversation flow** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): custom tool cards for `pwsh` calls (especially `run_in_background` jobs) showing the command, live status, a **progress bar**, **estimated time remaining (ETA)** and a **Stop** button — rendered inline in the chat, no page refresh needed.

```text
┌──────────────────────────────────────────────────────────────┐
│ PWSH  1..25 | ForEach-Object { Write-Output "step $_/25"; … } │
│ ⏳ running · elapsed 14.2s                                     │
│ [██████████████░░░░░░░░░░] 56% (14/25)                        │
│ ~11s remaining                                               │
│ [Stop]  Output appears via job_output                        │
└──────────────────────────────────────────────────────────────┘
```

## Features

| Capability | Description |
|---|---|
| Live status | running (spinner + elapsed) / stopping / ✓ done / ⏹ stopped / ✗ failed |
| **Progress bar** | parses `N/M` (e.g. `443/1212`) and `NN%` from the output copy the model already read via `job_output`; renders bar + percentage label live |
| **ETA** | ratio-based estimate from output progress (accurate); falls back to per-command history average (labelled “based on history”), auto-learned |
| Stop | one-click `jobs.kill`; terminal card shows ⏹ stopped + duration + reason |
| Terminal summary | ✓ done / ✗ failed + total duration + exit detail |
| Foreground calls | command + full output + done/failed badge (never worse than the default card) |
| Graceful degradation | untrackable jobs (after plugin restart / job removed) render a basic card, never throw |

## Positioning vs dsh-task-status

[dsh-task-status](https://github.com/vlln/dsh-task-status) already exists in the ecosystem (a dock status bar above the input + output tail). This plugin is **complementary, not a duplicate**:

| Dimension | dsh-task-status | **dsh-pwsh-progress (this plugin)** |
|---|---|---|
| Placement | dock status bar above the input (`conversation.input.dock`) | **inline tool card in the chat** (`tool.call.toolview` key=`'pwsh'`), tied to the call itself |
| Progress bar + ETA | ❌ | ✅ progress bar + dual-path ETA |
| Stop button | ❌ | ✅ |
| Output tail | ✅ (mirror patch rewrites the official read semantics) | ❌ (deliberate trade-off of the non-consumptive design) |
| Intrusion into official reads | ⚠️ patches `tasks.read` (official behavior changed) | ✅ **zero intrusion**: non-consumptive `jobs.get` + model-read copies only |
| Tool coverage | all background tasks (generic) | pwsh-specific (extensible to other tools on the same pattern) |

Ideal combo: this plugin's inline card + ETA + stop, plus dsh-task-status's generic coverage and tail.

## Install

```sh
# Option 1: GitHub source (recommended; build artifacts are committed)
dsh plugin --profile web add "github:sssueason/dsh-pwsh-progress#main"

# Option 2: npm
npm add dsh-pwsh-progress
dsh plugin --profile web add dsh-pwsh-progress

# Option 3: local development
dsh plugin --profile web add link:/path/to/dsh-pwsh-progress
```

Restart web (`dsh web`) to take effect; enable/disable it in the Plugins panel on the settings page.

## How it works

- **Host half** (`index.js`): a `tools/execute` waterfall **passively registers** pwsh background calls (parses the returned `jobId`, correlates the agent; never mutates `exec`, never alters results). State is tracked with **non-consumptive** `jobs.get(jobId, agent)` — `jobs.read` is **never** called, so the output cursor stays untouched and the official `job_output` semantics are unchanged.
- **Progress parsing**: listens to the model's `job_output` calls and parses `N/M` / `NN%` from the **output copy the model already read** (`result.value.text`) — non-consumptive, no cursor contention.
- **Dual-path ETA**: ① with output progress → `elapsed × (1−pct) / pct`; ② without → per-command history average (normalized command key, completed samples only, auto-learned).
- **HTTP routes** (loopback + same-origin only): `POST /api/dsh-pwsh-progress/state` (status + progress + ETA), `POST /api/dsh-pwsh-progress/kill` (stop).
- **Browser half** (`lib/client.js`): registers `tool.call.toolview` key=`'pwsh'` (unclaimed by the shipped composition — additive, replaces nothing), polls every 700ms, degrades on any failure.

## Use cases

- Long batch commands (scraping, builds, tests, data pipelines) whose output carries `N/M` or `NN%` progress.
- Waiting scenarios where you want to see "how much longer" right in the conversation.
- Tasks you may want to stop manually at any time.

## Known limitations

- pwsh-specific (other tools like `bash` can be added on the same pattern via their `tool.call.toolview` key).
- No output tail (deliberate trade-off of the non-consumptive design; output is still fully available via `job_output`).
- ETA without history on the first run shows elapsed time only; progress parsing requires the model to actually call `job_output`.
- History lives in the host process (lost on restart for session-level dynamic plugins; persists for this installable bundle form).

## Development & testing

```sh
node --test test/smoke.test.mjs   # pure-function unit tests (progress parsing / key normalization / labels)
```

Pure JS, zero build; the host half has no external dependencies and can be imported directly.

## License

MIT © 2026 dsh-pwsh-progress authors
