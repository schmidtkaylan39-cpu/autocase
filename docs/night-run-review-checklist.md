# Night Run Review Checklist

這份清單用在晚上準備交給 autonomous 前，以及睡前最後一次巡檢時。目標是先判斷今晚這個 run 適不適合 unattended 持續跑，而不是把已知的 blocked run 放著繼續燒 round。

配套閱讀：

- 睡前入口看這份。
- 早晨接手改看 [Morning Triage Checklist](morning-triage-checklist.md)。
- runtime / doctor / verifier 的深挖流程以 [Runtime Failure Triage](runtime-failure-triage.md) 為準。
- 狀態定義以 [State Surface Audit](state-surface-audit.md) 為準。

## 睡前先看哪裡

1. `runs/<run-id>/run-state.json`
   確認目前不是已經 `attention_required`，而且沒有關鍵 task 卡在 `blocked` / `failed`。
2. `runs/<run-id>/report.md`
   快速確認還有實際可前進的工作，不是只剩 stale summary。
3. `reports/runtime-doctor.json`
   required runtime `gpt-runner`、`codex`、`local-ci` 應該都要是 ready。
4. `runs/<run-id>/handoffs-autonomous/dispatch-results.json`
   如果這份已經存在，先看最近幾次是否大量 `skipped`、`failed`、或 `continued`。
5. `runs/<run-id>/artifacts/autonomous-debug/checkpoint.json`
   如果前面已經跑過 autonomous，先確認目前 `resume.mode` 與 `requiresIntervention`。

## 睡前最少要確認的 artifact

- `run-state.json`
  確認 source of truth 內沒有已知的 blocked / failed 爆點被忽略。
- `report.md`
  確認 next actions 與 run-state 大致一致。
- `runtime-doctor.json`
  確認 required runtime 有最新的 readiness 結果。
- `dispatch-results.json`
  確認最近不是一直在 skip 同一批 ready tasks。
- `checkpoint.json`
  確認上一次停下來不是 manual intervention 類型。

## 睡前怎麼判斷 `blocked` / `exhausted` / `attention_required`

這裡只保留睡前決策需要的最短版，完整定義以 [State Surface Audit](state-surface-audit.md) 為準。

- `attention_required`
  是 run 層級 rollup；如果睡前已經是這個狀態，先停，不要直接交給 unattended loop。
- `blocked`
  是最近一次 autonomous session 的 stop 分類；如果已經 `blocked`，通常今晚先解原因比再跑一次更重要。
- `exhausted`
  代表上一輪 session 用完 round budget，但如果 `checkpoint.resume.mode` 是 `immediate` 或 `"scheduled"`，通常仍可規劃續跑。

## runtime / doctor / verifier 出問題時先排查什麼

這裡只保留睡前判斷入口；若已經落入 runtime / doctor / verifier 深查，改按 [Runtime Failure Triage](runtime-failure-triage.md) 的順序查。

- runtime 先查：
  `runtime-doctor.json` 是否 ready、`dispatch-results.json` 是否已有 runtime unavailable 類訊號、`checkpoint.json` 是否要求 intervention。
- doctor 先查：
  報告是不是睡前剛產生，以及 `gpt-runner`、`codex`、`local-ci` 是否有任一項不 ready。
- verifier 先查：
  最近一次 verifier dispatch 是 gate 真失敗，還是 artifact / identity contract 失敗；前者今晚先停。

## 哪些狀況今晚要停

- `run-state.status === "attention_required"`
- `checkpoint.resume.requiresIntervention === true`
- 最近一次 terminal state 是 `blocked`
- `dispatch-results.json` 顯示 no automatic runtime、artifact invalid、identity mismatch、或 ready tasks 全被 skip
- `runtime-doctor.json` 顯示 required runtime 不 ready
- verifier 已經出現真實 gate failure
- 最近幾輪都在同一個 task chain 上 no progress

## 哪些狀況今晚可以 retry

- 最近一次 terminal state 是 `exhausted`
- `checkpoint.resume.mode === "immediate"`
- `checkpoint.resume.mode === "scheduled"`，只是等 `waiting_retry` 的 `nextRetryAt`
- failure category 比較像 `rate_limit`、`timeout`、`missing_dependency`、`environment_mismatch`
- transient provider / launcher 問題已恢復，而且 doctor 已重新確認 ready

## 晚上交跑前的最低標準

- intake / validate / run 建立流程已完成
- `run-id`、doctor report path、handoff output dir、`maxRounds` 都有明確值
- shell 或 CI 會保留 stdout / stderr
- 你知道明早第一個要看的 artifact 是 `autonomous-summary.md`，不是只看 panel 或只看 `report.md`

## 睡前不要做的事

- 不要把舊的 `runtime-doctor.json` 當成今晚的 readiness 證明。
- 不要在已經 `attention_required` 的 run 上盲目加大 `maxRounds`。
- 不要把「可以 scheduled retry」和「應該人工處理」混成同一類。
- 不要因為 panel 看起來還活著，就跳過 `checkpoint.json` 與 `dispatch-results.json`。
