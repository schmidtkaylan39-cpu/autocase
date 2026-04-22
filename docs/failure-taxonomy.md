# Failure Taxonomy

本文件說明目前產品如何分類 autonomous / dispatch 失敗訊號，以及哪些分類通常可重試。
這份文件補充 `docs/failure-feedback.md`，但更偏 operator 與 postmortem 視角。

## 這個 taxonomy 目前寫在哪裡

目前有兩個主要落點：

1. `runs/<run-id>/autonomous-summary.json`
   這裡有 `failureTaxonomy.stopCategory`、`categories`、`retryableCategories`
2. `runs/<run-id>/artifacts/failure-feedback/`
   這裡有逐筆 failure artifact、`failure-feedback-index.json`、`generated-test-cases.json`

## 目前產品的分類

### `rate_limit`

典型訊號：

- `rate limit`
- `too many requests`
- `429`

通常處理：

- 可重試
- 保持相同 handoff / prompt inputs
- 做 backoff

### `timeout`

典型訊號：

- `timeout`
- `timed out`
- `ETIMEDOUT`
- `no-progress circuit`
- `stalled`

通常處理：

- 可重試
- 先看 launcher output / dispatch note / checkpoint
- 不要先放大 timeout，先確認是真的執行過慢而不是卡死或無進展

### `missing_dependency`

典型訊號：

- `missing`
- `not found`
- `ENOENT`
- `npm ci`
- `dependency`

通常處理：

- 可重試
- 補齊本地依賴或 runtime
- 之後重跑同一個 task

### `environment_mismatch`

典型訊號：

- `502`
- `503`
- `Bad Gateway`
- `service unavailable`
- `network`
- `dns`
- `connection`
- `runtime is not available`
- `no automatic runtime was available`
- `shell is not available`
- `spawn EPERM`
- `permission denied`
- `launcher process creation was denied`

通常處理：

- 可重試
- 先確認 doctor、shell、權限、網路、上游 provider
- 如果是 transient GPT Runner / launcher permission 問題，通常會看到自動 `retry_task`

### `artifact_invalid`

典型訊號：

- `artifact`
- `schema`
- `invalid json`
- `prompt hash mismatch`
- `idempotency key mismatch`

通常處理：

- 通常不應直接盲目重試
- 先修正 result artifact contract 或 handoff identity 問題

### `verification_failed`

典型訊號：

- `verification`
- `test failed`
- `lint`
- `typecheck`
- `build failed`

通常處理：

- 通常不應直接盲目重試
- 先修 code 或修 gate，再重跑 verifier

### `logic_bug`

典型訊號：

- `logic`
- `state transition`
- `stale`
- `dependency`

通常處理：

- 通常不應直接盲目重試
- 先抓最小 repro
- 補 targeted regression test 再回頭重跑

### `unknown`

典型訊號：

- 上面都對不到

通常處理：

- 先看 `debug-bundle.json`、`checkpoint.json`、`dispatch-results.json`
- 再把最小證據整理進 failure-feedback

## 哪些分類目前會被視為 retryable

目前產品把以下分類當成 retryable：

- `rate_limit`
- `timeout`
- `missing_dependency`
- `environment_mismatch`

其餘分類預設應先查明原因，不建議直接盲目重試。

## stopCategory 和 per-failure category 的差別

### `stopCategory`

這是 autonomous session 為什麼停下來的總體判斷。
它來自 stop reason 與 terminal summary reason code。

常見對應：

- `runtime_unavailable` -> `environment_mismatch`
- `no_progress_circuit` -> `timeout`
- `blocked_tasks` -> `logic_bug`
- `completed` -> `null`

### per-failure category

這是每筆 failed / incomplete / continued dispatch outcome 的分類。
它會被寫進：

- `artifacts/failure-feedback/*.json`
- `failure-feedback-index.json`
- `generated-test-cases.json`

## 目前 failure-feedback 何時會產生

當 autonomous loop 收到以下 dispatch result 時，會生成 failure-feedback：

- `failed`
- `incomplete`
- `continued`

也就是說，`continued` 雖然代表 loop 還能往前推，但只要它來自 blocked artifact + automationDecision，系統仍會把這個事件視為需要學習的 failure signal。

## 你應該先看哪個檔

### 想知道整體為什麼停

先看：

- `autonomous-summary.json`
- `artifacts/autonomous-debug/terminal-summary.json`

### 想知道是哪個 task 出事

先看：

- `artifacts/failure-feedback/failure-feedback-index.json`
- `handoffs*/dispatch-results.json`

### 想知道下一步該怎麼做

先看：

- `artifacts/autonomous-debug/hypothesis-ledger.json`
- `artifacts/failure-feedback/*.json`

## operator 判斷原則

- `environment_mismatch`、`rate_limit`、`timeout` 比較像環境或上游不穩，先查 doctor、shell、網路、provider，再決定是否重試。
- `artifact_invalid`、`verification_failed`、`logic_bug` 比較像產品或流程本身的問題，先查 contract、run-state、task ledger、dispatch sync，再決定是否重跑。
- `unknown` 不要假設能安全重試，先補最小證據。
