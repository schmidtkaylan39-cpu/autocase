# Runtime Failure Triage

這份文件專門處理 runtime、doctor、verifier 三種常見故障面。先分清楚是哪一層出問題，再決定要停還是 retry。

配套閱讀：

- 如果你只是要先決定早晨該停還是該續跑，先看 [Morning Triage Checklist](morning-triage-checklist.md)。
- 如果你卡在狀態詞彙或 source-of-truth 邊界，先回 [State Surface Audit](state-surface-audit.md)。

## 第一層判斷：先把失敗分層

### 比較像 runtime 問題

常見訊號：

- `terminal-summary.json` 的 `reasonCode` 指向 runtime unavailable
- `dispatch-results.json` 提到 no automatic runtime、launcher denied、timeout、429、502、503、gateway、DNS、connection
- autonomous session 停在 `blocked`，但 task 本身未必有新的 product defect

先看：

1. `runs/<run-id>/artifacts/autonomous-debug/terminal-summary.json`
2. `runs/<run-id>/handoffs-autonomous/dispatch-results.json`
3. `reports/runtime-doctor.json`

### 比較像 doctor 問題

常見訊號：

- `reports/runtime-doctor.json` 裡 required runtime 缺失或 `ok: false`
- handoff / dispatch 一直退回 `manual`
- 明明任務 ready，卻沒有可用的自動 runtime

先看：

1. `reports/runtime-doctor.json`
2. `reports/runtime-doctor.md`
3. `package.json`

### 比較像 verifier 問題

常見訊號：

- `local-ci` 已被選為 verifier runtime
- dispatch 結果顯示 verifier `failed` 或 `incomplete`
- build / lint / typecheck / test 其中一個 gate 真的沒過

先看：

1. `runs/<run-id>/handoffs-autonomous/dispatch-results.json`
2. `runs/<run-id>/run-state.json`
3. `runs/<run-id>/report.md`

## 哪些 artifact 先看

### runtime 故障

- `terminal-summary.json`
  看 `state` 與 `reasonCode`。
- `dispatch-results.json`
  看 runtime note、launcher note、result path、status。
- `runtime-doctor.json`
  看 required runtime 是否 ready。

### doctor 故障

- `runtime-doctor.json`
  看 `generatedAt` 與各個 check 的 `ok` / `installed`。
- `runtime-doctor.md`
  看人類可讀摘要。
- `package.json`
  特別是 `local-ci` 所依賴的 script 是否存在。

### verifier 故障

- `dispatch-results.json`
  看哪個 verifier task 失敗。
- `run-state.json`
  看 task 最終被寫成 `waiting_retry`、`blocked`、還是 `failed`。
- `report.md`
  看整體 run 是否已進入 `attention_required`。

## `blocked` / `exhausted` / `attention_required` 怎麼判斷

這個 triage 文件只保留故障判斷需要的最短版；完整定義以 [State Surface Audit](state-surface-audit.md) 為準。

- `attention_required`
  是 `run-state.json` 的 run rollup，代表 run 已經需要人工 follow-up。
- `blocked`
  是 autonomous terminal state，通常表示這次 session 不應該盲目重跑。
- `exhausted`
  也是 autonomous terminal state，通常表示 session budget 用完，但 run 不一定失敗。

## runtime 出問題時先排查什麼

### `gpt-runner`

優先排查：

- `runtime-doctor.json` 內 `gpt-runner.ok`
- `codex login status` 是否仍正常
- 是否是 429 / timeout / upstream gateway 類 transient 問題
- launcher shell 是否可用

### `codex`

優先排查：

- `runtime-doctor.json` 內 `codex.ok`
- `codex --help` 與 `codex login status` 是否失效
- launcher 是否因 host permission / process creation 被拒絕
- dispatch note 是否已經把 transient 問題轉成 `waiting_retry`

### `local-ci`

優先排查：

- `runtime-doctor.json` 內 `local-ci.ok`
- `package.json` 是否具備 `build`、`lint`、`typecheck`、`test`、`test:integration`、`test:e2e`
- 是 script 缺失，還是 script 存在但 gate 真正失敗

## doctor 出問題時先排查什麼

- 先確認報告夠新，不要拿舊 doctor 報告判斷今晚或今早的 runtime 狀態。
- required runtime 只看 `gpt-runner`、`codex`、`local-ci`。
- `openclaw`、`cursor` 目前是 optional surface，不是預設 blocked 原因。
- doctor 只保證 readiness，不保證實際任務一定成功。

如果 doctor 不健康，先修 runtime readiness，再談 retry autonomous。

## verifier 出問題時先排查什麼

- 先分清楚是 gate failure 還是 artifact failure。
- 如果是 build / lint / typecheck / test 真失敗，先停，修根因，再重跑 verifier。
- 如果是 result artifact 缺失、內容不合法、或 identity 對不上，先停，查 handoff / result contract，不要直接盲目 retry。
- 如果只是 transient launcher / environment 問題，而且系統已經把 task 放進 `waiting_retry`，可以等 `nextRetryAt` 或在恢復後再 resume。

## 哪些狀況要停

- `run-state.status === "attention_required"`
- `terminalSummary.state === "blocked"`
- `checkpoint.resume.requiresIntervention === true`
- required runtime 在 `runtime-doctor.json` 內不 ready
- verifier 真正的 gate failure
- `artifact_invalid`
- `logic_bug`
- `unknown` 且沒有足夠證據證明只是 transient

## 哪些狀況可以 retry

- `terminalSummary.state === "exhausted"` 且 `resume.requiresIntervention === false`
- `waiting_retry` 還沒到或剛到 `nextRetryAt`
- `rate_limit`
- `timeout`
- `missing_dependency`，而且缺的依賴或 runtime 已補回
- `environment_mismatch`，而且 shell / auth / network / provider 已恢復

## retry 前最後再檢查一次

1. `checkpoint.json` 是否允許 resume
2. `run-state.json` 是否沒有新的 blocked / failed task 被忽略
3. `dispatch-results.json` 是否沒有 artifact-invalid 類訊號
4. `runtime-doctor.json` 內 required runtime 是否又回到 ready

只要這四項有任一項答不出來，就先停，不要急著重跑。
