# Debug Bundle Guide

本文件專講 autonomous debug bundle。
這裡的「debug bundle」是指 run 目錄下的 JSON debug artifacts，不是 `review-bundle`，也不是 `npm run review:debug:panel` 產生的分享包。

## 目前 debug bundle 在哪裡

每個 autonomous run 的 debug artifacts 目前在：

```text
runs/<run-id>/
  autonomous-summary.json
  autonomous-summary.md
  artifacts/
    autonomous-debug/
      terminal-summary.json
      checkpoint.json
      hypothesis-ledger.json
      debug-bundle.json
```

另外還常常要搭配：

```text
runs/<run-id>/run-state.json
runs/<run-id>/report.md
runs/<run-id>/handoffs/dispatch-results.json
runs/<run-id>/handoffs-autonomous/dispatch-results.json
reports/runtime-doctor.json
runs/<run-id>/artifacts/failure-feedback/
```

## 每個檔案是做什麼的

### `autonomous-summary.json` / `autonomous-summary.md`

整個 autonomous session 的總表。
它會給你：

- final run status
- terminal state
- stop reason
- rounds
- watchdog diagnostics
- failure taxonomy
- progress diagnostics

如果你只想先知道「昨晚到底停在哪」，先看這個。

### `terminal-summary.json`

最精簡的 terminal-state 判斷面。
它會給你：

- `state`: `done / blocked / exhausted`
- `reasonCode`
- `finalRunStatus`
- `stopReason`
- `blockedTaskIds`
- `waitingRetryTaskIds`
- `skippedAutomaticTaskIds`
- `degradedRuntimeActive`
- 最後一次 progress 訊號

如果你只想先判斷「是卡住還是只是輪次用完」，先看這個。

### `checkpoint.json`

這是 resume 的主入口。
它會告訴你：

- 這一輪 session id
- 是否從上個 checkpoint 接續
- checkpoint 目前狀態
- 最後跑到第幾輪
- `resume.canResume`
- `resume.mode`
- `resume.requiresIntervention`
- 下一次建議使用的 command
- debugEvidence 指向哪些輔助檔案

如果你要決定今天早上是「直接重跑 autonomous」還是「先人工介入」，先看這個。

### `hypothesis-ledger.json`

這是 postmortem / triage 的猜測帳本。
它不是 source of truth，而是把 stop reason 與 failure feedback 整理成：

- category
- likelyCause
- nextBestAction
- retryable
- taskIds
- evidence

如果你已經知道 run 停了，但不知道先查 runtime、artifact、還是 logic，先看這個。

### `debug-bundle.json`

這是一個 index / pointer artifact，不是完整調查內容本身。
它會告訴你：

- terminal state
- reason code
- stop reason
- terminal summary path
- checkpoint path
- hypothesis ledger path
- debugEvidence

如果你只看 `debug-bundle.json` 而不去打開它指向的檔案，通常不夠。

## 正確閱讀順序

建議固定照這個順序查：

1. `autonomous-summary.md`
2. `terminal-summary.json`
3. `checkpoint.json`
4. `debug-bundle.json`
5. `hypothesis-ledger.json`
6. `dispatch-results.json`
7. `run-state.json`
8. `report.md`
9. `runtime-doctor.json`
10. `failure-feedback-index.json`

## debug bundle 一定要搭配看的檔案

### 1. `run-state.json`

這是 task ledger 的真實來源。
terminal summary 只會告訴你結果分類，但真正哪些 task 是 `ready`、`waiting_retry`、`blocked`、`completed`，還是要回到這裡看。

### 2. `dispatch-results.json`

這是最近一次 handoff / launcher / result artifact contract 的真實執行證據。
要看：

- `completed / continued / incomplete / failed / skipped`
- note
- artifact summary
- launcher path
- result path

### 3. `runtime-doctor.json`

當 `reasonCode` 是 `runtime_unavailable` 或 stop reason 提到 no automatic runtime 時，這是第一個要交叉比對的檔。

### 4. `failure-feedback-index.json`

當 dispatch 曾經回 `failed / incomplete / continued`，這裡能把錯誤分類與下一步建議拉平。

## 明早先看哪裡

如果你只有 5 分鐘，照下面看：

1. `autonomous-summary.md`
2. `terminal-summary.json`
3. `checkpoint.json`
4. `dispatch-results.json`

如果 5 分鐘內還看不懂，再補：

5. `run-state.json`
6. `runtime-doctor.json`
7. `hypothesis-ledger.json`
8. `failure-feedback-index.json`

## `done / blocked / exhausted` 在 debug bundle 裡的意義

### `done`

- run 已完成
- `resume.canResume` 會是 `false`
- 通常不需要再開 autonomous

### `blocked`

- run 因 blocked / failed task 或 `attention_required` 停下來
- `resume.mode` 目前通常是 `manual`
- 需要先人工檢查

### `exhausted`

- autonomous session 的 budget 用完了
- run 可能還有 `ready / pending / waiting_retry`
- `resume.mode` 可能是 `immediate` 或 `scheduled`

## 與 panel 的關係

目前 panel 會直接讀：

- `terminal-summary.json`
- `checkpoint.json`

它目前不會完整展開整份 `hypothesis-ledger.json` 或 `debug-bundle.json` 內容。
所以如果 panel 只告訴你 blocked / halted，真正的調查仍然要回到 run 目錄看檔案。

## 與其他 bundle / share package 的差別

### autonomous debug bundle

- 在 `runs/<run-id>/artifacts/autonomous-debug/`
- 偏單次 run 的狀態、恢復、排障

### review bundle

- `node src/index.mjs review-bundle`
- 偏外部 reviewer / external AI 審查整個 repo

### GPT debug share package

- `npm run review:debug:panel`
- 偏把 panel / acceptance / repo 上下文打包給外部 GPT

這三者不要混為一談。
