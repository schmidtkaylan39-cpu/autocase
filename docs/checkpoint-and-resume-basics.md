# Checkpoint And Resume Basics

本文件說明目前 autonomous run 的 checkpoint 與 resume 機制。

## checkpoint 在哪裡

目前 autonomous checkpoint 固定寫在：

```text
runs/<run-id>/artifacts/autonomous-debug/checkpoint.json
```

同一層還有：

- `terminal-summary.json`
- `hypothesis-ledger.json`
- `debug-bundle.json`

## checkpoint 目前何時會更新

`autonomous` 在下列時機都會持續刷新 checkpoint：

- session 啟動後
- 每輪完成後
- stop reason 形成後
- 正常 halted / completed 結束時
- autonomous loop throw error 時

所以它不是只有最後才寫。

## checkpoint 目前包含什麼

目前主要欄位：

- `schemaVersion`
- `sessionId`
- `resumedFromSessionId`
- `resumeCount`
- `checkpointStatus`
- `runId`
- `runStatePath`
- `startedAt`
- `updatedAt`
- `lastRoundAttempted`
- `roundsCompleted`
- `stopReason`
- `terminalSummary`
- `resume`
- `runSummary`
- `progressDiagnostics`
- `debugEvidence`
- `errorMessage`

## `checkpointStatus` 目前怎麼看

### `active`

autonomous 正在進行，或至少這次 session 還沒形成最終 halt/completed/failure。

### `halted`

最常見的非完成結束狀態。
代表 autonomous 這次 session 停下來了，但不是內部 crash。

常見原因：

- `blocked`
- `exhausted`
- no automatic runtime
- no-progress circuit

### `completed`

run 已完成，對應 terminal state 通常是 `done`。

### `failed`

不是 task fail，而是 autonomous loop 本身 throw error。
這時要看 `errorMessage` 和 `debugEvidence`。

## `resume` 區塊目前怎麼判讀

### `canResume`

- `false` 代表這次 run 已經完成，不需要再跑 autonomous
- `true` 代表理論上可以用同一個 `run-state.json` 接著跑

### `mode`

目前有三種常見值：

- `none`
- `manual`
- `immediate`
- `scheduled`

### `requiresIntervention`

- `true` 代表不要盲目重跑，先人工看 blocked / failed 原因
- `false` 代表可以直接或排程續跑

## terminal state 對應的 resume 行為

### `done`

目前 resume 會是：

- `canResume: false`
- `mode: none`

### `blocked`

目前 resume 會是：

- `canResume: true`
- `mode: manual`
- `requiresIntervention: true`

意思是：同一個 entry point 可以再跑，但不應該直接無腦重跑。
先看為什麼 blocked。

### `exhausted`

目前 resume 會是：

- `canResume: true`
- `mode: immediate` 或 `scheduled`
- `requiresIntervention: false`

判斷方式：

- 如果還有 `waiting_retry`，通常是 `scheduled`
- 否則通常是 `immediate`

## 目前真正的 resume command

目前 resume 並沒有新的專用 CLI。
系統在 checkpoint 裡給的 command 仍然是同一個 autonomous entry point：

```bash
node src/index.mjs autonomous runs/<run-id>/run-state.json
```

如果你昨晚有明確指定 doctor report、handoff output dir、maxRounds，早上續跑時也建議保持一致。

例如：

```bash
node src/index.mjs autonomous runs/<run-id>/run-state.json reports/runtime-doctor.json runs/<run-id>/handoffs-autonomous 200
```

## 什麼情況可以直接 resume

### 可以直接 resume

- `terminalSummary.state === "exhausted"`
- `resume.mode === "immediate"`
- 沒有新的 runtime unavailable 訊號
- 沒有 artifact-invalid 類問題

### 應該等時間到再 resume

- `resume.mode === "scheduled"`
- `waiting_retry` 還沒到 `nextRetryAt`

### 不要直接 resume

- `terminalSummary.state === "blocked"`
- `resume.requiresIntervention === true`
- `checkpointStatus === "failed"`

## blocked 和 exhausted 的實際差別

### blocked

代表 run 已經進入需要人工介入的狀態。
常見是：

- blocked / failed task
- no automatic runtime
- no-progress circuit 後 materialize 成 blocked tasks

### exhausted

代表 autonomous session 的 round budget 先用完了。
run 可能還能繼續，只是這次 session 結束。

## resume 前固定要看哪裡

1. `terminal-summary.json`
2. `checkpoint.json`
3. `run-state.json`
4. `dispatch-results.json`
5. `runtime-doctor.json`

如果是 blocked，再補看：

6. `hypothesis-ledger.json`
7. `failure-feedback-index.json`

## 與 `tick` / `retry` 的關係

目前 resume 不會跳過既有 run-state 機制。

- `retry` 會把 task 放進 `waiting_retry`
- `tick` / `report` / `handoff` refresh 會在時間到後把它打回 `ready`
- `autonomous` 下一次進來時，仍然是走同一套 `doctor -> tick -> dispatch execute`

也就是說，resume 不是繞過狀態機，而是重新進入同一條狀態機。
