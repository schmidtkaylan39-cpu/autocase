# Morning Triage Checklist

這份清單給隔夜 autonomous run 的早晨接手者使用。目標不是先猜原因，而是先用最少的 artifact 找出：

- autonomous 昨晚停在哪裡
- 現在是要停下來人工處理，還是可以直接 retry / resume
- 是 runtime 問題、doctor 問題、還是 verifier 問題

配套閱讀：

- 這份文件只負責早晨第一輪判斷。
- runtime / doctor / verifier 的深挖流程以 [Runtime Failure Triage](runtime-failure-triage.md) 為準。
- `attention_required`、`blocked`、`exhausted` 等狀態定義以 [State Surface Audit](state-surface-audit.md) 為準。

## 明早醒來先看哪裡

建議固定照這個順序看：

1. `runs/<run-id>/autonomous-summary.md`
   先看人類可讀摘要，快速抓 terminal state、stop reason、round 數、watchdog 事件。
2. `runs/<run-id>/artifacts/autonomous-debug/terminal-summary.json`
   這是最直接的 terminal-state 判斷來源。先看 `state`、`reasonCode`、`finalRunStatus`。
3. `runs/<run-id>/artifacts/autonomous-debug/checkpoint.json`
   先看 `resume.canResume`、`resume.mode`、`resume.requiresIntervention`。
4. `runs/<run-id>/handoffs-autonomous/dispatch-results.json`
   如果沒有這份，再看 `runs/<run-id>/handoffs/dispatch-results.json`。重點看最後一次 dispatch 到底是 `completed`、`continued`、`incomplete`、`failed`、還是 `skipped`。
5. `runs/<run-id>/run-state.json`
   這是 source of truth。看哪些 task 真正是 `ready`、`waiting_retry`、`blocked`、`failed`、`completed`。
6. `runs/<run-id>/report.md`
   用來快速核對 task ledger 與 next actions，但不要把它當 source of truth。
7. `reports/runtime-doctor.json`
   如果 stop reason 看起來像 runtime unavailable、no automatic runtime、launcher 問題，立刻交叉比對這份。
8. `runs/<run-id>/artifacts/failure-feedback/failure-feedback-index.json`
   已經知道是哪個 task 出事後再看這份，確認 failure category 與 next best recovery step。
9. `runs/<run-id>/artifacts/autonomous-debug/hypothesis-ledger.json`
   如果還是不確定該先查 runtime、artifact、還是 logic，再用這份整理方向。

## 哪些 artifact 先看

- `autonomous-summary.md`
  先回答「昨晚是完成、卡住、還是只是把 round budget 用完」。
- `terminal-summary.json`
  先回答「terminal state 到底是 `done`、`blocked`、還是 `exhausted`」。
- `checkpoint.json`
  先回答「現在是不是可以直接 resume，還是一定要先人工介入」。
- `dispatch-results.json`
  先回答「最後一次真的 dispatch 了什麼、跳過了什麼、哪個 runtime 出錯」。
- `run-state.json`
  先回答「哪些 task 真正 blocked / failed / waiting_retry」。
- `runtime-doctor.json`
  先回答「required runtime 現在是不是 ready」。
- `failure-feedback-index.json`
  先回答「這次 failure 比較像 transient 還是 product / artifact 問題」。

## `blocked` / `exhausted` / `attention_required` 怎麼判斷

這裡只保留早晨判斷需要的最短版，完整定義以 [State Surface Audit](state-surface-audit.md) 為準。

- `attention_required`
  是 `run-state.json` 的 run rollup，代表已經需要人工 follow-up。
- `blocked`
  是 `terminal-summary.json` 的 autonomous terminal state，通常代表先停、先查、不要盲目重跑。
- `exhausted`
  也是 autonomous terminal state，通常代表 session budget 用完，但 run 可能仍可 resume。

早晨實務上只要先回答兩件事：

1. `run-state.json` 的聚合狀態是不是已經 `attention_required`
2. `terminal-summary.json` 的 session stop 分類到底是 `blocked` 還是 `exhausted`

## runtime / doctor / verifier 出問題時先排查什麼

這份清單只保留第一跳；一旦要深查，就直接切到 [Runtime Failure Triage](runtime-failure-triage.md)。

- 看起來像 runtime 問題時：
  先看 `terminal-summary.json.reasonCode`、`dispatch-results.json` 的 runtime note，以及 `reports/runtime-doctor.json`。
- 看起來像 doctor 問題時：
  先確認 doctor 報告夠新，再看 required runtime `gpt-runner`、`codex`、`local-ci` 是否有任一個不 ready。
- 看起來像 verifier 問題時：
  先分清楚是 gate 真失敗，還是 verifier result artifact / identity contract 失敗。

## 哪些狀況要停，哪些狀況可以 retry

### 要停

- `terminalSummary.state === "blocked"`
- `run-state.status === "attention_required"`
- `checkpoint.resume.requiresIntervention === true`
- `dispatch-results.json` 顯示 invalid artifact、identity mismatch、或一直 `skipped`
- verifier 真正跑出 build / lint / typecheck / test failure
- `runtime-doctor.json` 顯示 required runtime 不 ready

### 可以 retry 或 resume

- `terminalSummary.state === "exhausted"`，而且 `resume.mode === "immediate"`
- `resume.mode === "scheduled"`，只是還在等 `waiting_retry` 的 `nextRetryAt`
- failure category 比較像 `rate_limit`、`timeout`、`missing_dependency`、`environment_mismatch`
- launcher / provider 問題已恢復，doctor 重新檢查後 required runtime 又變回 ready

## 早晨 triage 不要做的事

- 不要只看 `report.md` 就判斷 run 已經完成。
- 不要把 `attention_required` 當成 autonomous terminal state。
- 不要把 `blocked` 誤判成 `exhausted`。
- 不要在沒看 `checkpoint.json` 前就直接重跑 autonomous。
- 不要先怪 verifier；先分清楚到底是 runtime、doctor、還是 gate 本身失敗。
