# 24h Autonomous Ops Runbook

本文件描述目前產品已經落地的 unattended / overnight 操作方式。
重點是如實反映現在的 CLI、artifact、run-state、dispatch、autonomous 行為，而不是未來理想設計。

## 先記住三件事

1. 這個產品是 artifact-first workflow。
   先看 artifact，再判斷狀態，不要先猜。
2. `autonomous` 是有界迴圈，不是常駐 daemon。
   目前預設 `maxRounds` 是 `20`，到上限就會停。
3. `run-state.status` 和 autonomous `terminal state` 不是同一組欄位。
   `run-state.status` 目前是 `planned / in_progress / completed / attention_required`。
   `terminal state` 目前寫在 `autonomous-summary.json` 與 `artifacts/autonomous-debug/terminal-summary.json`，值是 `done / blocked / exhausted`。

## 目前產品流程

目前操作脊柱是：

1. `intake`
2. `confirm` / `revise`
3. `validate`
4. `plan`
5. `run`
6. `handoff`
7. `dispatch`
8. `autonomous`

其中 `autonomous` 目前實際執行的是反覆的：

1. `doctor`
2. `tick`
3. `dispatch execute`

並在每輪後持續更新：

- `runs/<run-id>/autonomous-summary.json`
- `runs/<run-id>/autonomous-summary.md`
- `runs/<run-id>/artifacts/autonomous-debug/terminal-summary.json`
- `runs/<run-id>/artifacts/autonomous-debug/checkpoint.json`
- `runs/<run-id>/artifacts/autonomous-debug/hypothesis-ledger.json`
- `runs/<run-id>/artifacts/autonomous-debug/debug-bundle.json`

## 24h unattended run 的正確理解

目前產品支援的是「有界、自我記錄、可恢復」的 autonomous loop，不是內建排程器。

這代表：

- 單次 `autonomous` 可以在無人值守下連續跑多輪。
- 跑到 `done`、`blocked`、`exhausted`、或 loop 發生錯誤時，會留下完整 summary / checkpoint / debug artifacts。
- 如果你真的要跨整天反覆續跑，目前做法是用外部排程器或 supervisor 重跑同一個 `run-state.json`。
- 產品本身目前沒有內建 24 小時常駐排程服務。

## 開跑前的最低準備

### 1. 先把 intake gate 關閉

當 workspace 已經有 clarification artifact 時，`plan`、`run`、`handoff`、`dispatch`、`tick` 都會 fail closed，直到 intake 被確認。

最小流程：

```bash
node src/index.mjs intake "<request>" .
node src/index.mjs confirm .
node src/index.mjs validate specs/project-spec.json
node src/index.mjs plan specs/project-spec.json
node src/index.mjs run specs/project-spec.json runs <run-id>
```

### 2. 先做 runtime preflight

`autonomous` 的預設健康路線依賴：

- `gpt-runner`
- `codex`
- `local-ci`

建議先跑：

```bash
node src/index.mjs doctor
```

關鍵檔案：

- `reports/runtime-doctor.json`
- `reports/runtime-doctor.md`

### 3. 明確指定長跑參數

如果你要 overnight / 24h unattended，不要只依賴預設 `maxRounds=20`。

建議顯式指定：

```bash
node src/index.mjs autonomous runs/<run-id>/run-state.json reports/runtime-doctor.json runs/<run-id>/handoffs-autonomous 200
```

說明：

- 第 1 個參數是 `run-state.json`
- 第 2 個參數是 doctor report path
- 第 3 個參數是 handoff output dir
- 第 4 個參數是 `maxRounds`

如果省略第 2、3 個參數，系統會用 workspace 內預設位置。

## 內建保護：watchdog、bounded retry、no-progress

### Watchdog 目前做什麼

目前 watchdog 不是外部監控服務，而是 autonomous loop 內建的診斷與保護資訊。

它目前會處理或記錄：

- autonomous lock 競爭與 stale lock 清理
- descriptor execution lock 的 stale / orphan recovery
- `in_progress` 任務長時間沒有 dispatch outcome note 的恢復
- no-progress circuit 是否被打開
- 最後一次 watchdog event 與 heartbeat

相關資訊會寫進：

- `autonomous-summary.json`
- `artifacts/autonomous-debug/checkpoint.json`
- `artifacts/autonomous-debug/terminal-summary.json`

### Bounded retry 目前有三層

1. dispatch / launcher 內部重試
   例如 `gpt-runner` 遇到 transient upstream failure 會做有限次重試。
2. run-state 的 timed retry
   `waiting_retry -> ready` 由 `tick` / `report` / `handoff` 的 refresh 釋放。
3. autonomous recovery
   blocked / failed reviewer、verifier、executor 可能被 rework 或 replan，而不是直接終止整個 run。

目前預設 retry policy 來自 `config/factory.config.json`：

- implementation: `3`
- review: `2`
- verification: `2`
- replanning: `1`
- hybridSurface maxAttempts: `3`
- hybridSurface retryDelayMinutes: `3`
- hybridSurface unlockAfterMinutes: `30`

### No-progress 目前怎麼算

當一輪結束後同時滿足以下條件，才會累積 no-progress cycle：

- 還有未完成工作
- 沒有新增 completed task
- 沒有新增 ready task
- dispatch 沒有完成任何 task
- 目前只剩 `blocked` / `waiting_retry` / `in_progress` 類型的 active tasks

目前預設 no-progress circuit 會在連續 `2` 輪後打開，可由環境變數 `AI_FACTORY_AUTONOMOUS_NO_PROGRESS_CYCLES` 調整。

一旦打開，系統會把仍在 `ready` / `waiting_retry` / `in_progress` 的目標任務 materialize 成 `blocked`，並寫入 `autonomous-no-progress:*` note。

## 明早先看哪裡

建議固定照這個順序看，最快。

1. `runs/<run-id>/autonomous-summary.md`
   先用人類可讀摘要抓 terminal state、stop reason、round 數、watchdog 事件。
2. `runs/<run-id>/artifacts/autonomous-debug/terminal-summary.json`
   這是最準的 terminal-state 判斷面。
3. `runs/<run-id>/artifacts/autonomous-debug/checkpoint.json`
   看 `resume.canResume`、`resume.mode`、`requiresIntervention`。
4. `runs/<run-id>/handoffs-autonomous/dispatch-results.json`
   如果沒有，就看 `runs/<run-id>/handoffs/dispatch-results.json`。
5. `runs/<run-id>/run-state.json`
   看哪些 task 真正是 `blocked`、`waiting_retry`、`ready`、`completed`。
6. `runs/<run-id>/report.md`
   快速確認 task ledger 與 next actions。
7. `reports/runtime-doctor.json`
   如果 stop reason 看起來像 runtime unavailable，先核對 doctor。
8. `runs/<run-id>/artifacts/failure-feedback/failure-feedback-index.json`
   有 failed / incomplete / continued 時，再看這個分類與下一步建議。

## `done / blocked / exhausted` 現在怎麼判斷

### `done`

目前 autonomous terminal-state 會在以下情況判成 `done`：

- `run-state.status === "completed"`
- 或所有 task 都已完成

### `blocked`

目前 autonomous terminal-state 會在以下情況判成 `blocked`：

- 有任何 `blocked` task
- 有任何 `failed` task
- `run-state.status === "attention_required"`

常見 stop reason：

- `dispatch skipped all ready tasks; no automatic runtime was available`
- `autonomous no-progress circuit opened ...`
- blocked / failed task 需要人工檢查後再續跑

### `exhausted`

目前 autonomous terminal-state 會在以下情況判成 `exhausted`：

- stop reason 明確是 `maximum rounds reached`
- 或 run 還沒完成，但沒有 blocked / failed，仍殘留 `ready / pending / waiting_retry`

`exhausted` 不等於失敗。
它通常代表這次 autonomous session 的 round budget 用完了，但 run 還有後續工作。

## 哪些共享熱點最危險

### `run-state.json`

這是最危險的共享真實來源。
`task`、`result`、`retry`、`tick`、`handoff`、`dispatch`、`autonomous` 都可能更新它。

### `handoffs/index.json` 與 `handoffs*/results/*`

這是 dispatch 的執行入口與 result artifact 匹配面。
每次 handoff 都有自己的 `handoffId`，不要手動重用舊 result artifact。

### `activeHandoffId` / `activeResultPath` / `activeHandoffOutputDir`

這些欄位把 run-state 跟實際 handoff 嘗試綁在一起。
如果它們對不上，`result` 套用與 dispatch sync 會出問題。

### `report.md`

它很方便，但它是衍生 artifact，不是 source of truth。
有衝突時先相信 `run-state.json`、`dispatch-results.json`、`terminal-summary.json`。

### `reports/runtime-doctor.json`

它只保證 readiness，不保證真能成功完成工作。
doctor 綠燈不等於 autonomous 一定跑完。

## 推薦的 unattended 操作節奏

### 睡前

1. 跑 `doctor`
2. 確認 intake 已 confirm
3. 確認 `run-state.json` 與 `report.md` 正常
4. 顯式指定較大的 `maxRounds`
5. 把 stdout/stderr 交給外部 shell log 或 CI log 留存

### 夜間

交給：

```bash
node src/index.mjs autonomous runs/<run-id>/run-state.json reports/runtime-doctor.json runs/<run-id>/handoffs-autonomous <large-max-rounds>
```

### 早上

先看 `autonomous-summary.md`，再照「明早先看哪裡」的順序往下查。

## 目前產品限制

- 目前沒有內建 always-on scheduler
- `watchdog` 是 loop 內診斷與保護，不是獨立服務
- `panel` 目前主要吃 `terminal-summary.json` 與 `checkpoint.json`，不是完整 debug artifact viewer
- `review-bundle` 與 `review:debug:panel` 是另外兩種分享/審查包，不等於 autonomous debug bundle
