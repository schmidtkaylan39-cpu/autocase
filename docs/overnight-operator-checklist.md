# Overnight Operator Checklist

本清單給值班或隔夜 operator 用。
假設你只操作目前產品已經存在的 CLI 與 artifact。

## 睡前檢查

- intake 已經 `confirm`，不是卡在 clarification gate。
- spec 已經 `validate` 通過。
- run 已建立，且 `runs/<run-id>/run-state.json` 存在。
- `node src/index.mjs doctor` 已跑過，`reports/runtime-doctor.json` 是新的。
- 你知道今晚要看的 `run-id`。
- 你有明確指定 `maxRounds`，不要只靠預設 `20`。
- 你知道 handoff output dir 在哪裡，建議固定用 `runs/<run-id>/handoffs-autonomous`。
- shell / CI / terminal 會保留 stdout/stderr。

## 建議開跑命令

```bash
node src/index.mjs autonomous runs/<run-id>/run-state.json reports/runtime-doctor.json runs/<run-id>/handoffs-autonomous 200
```

## 若想先做 30 秒 sanity check

- 先看 `runs/<run-id>/report.md` 有沒有明顯異常。
- 先看 `runs/<run-id>/run-state.json` 是否至少有一個可推進 task。
- 先看 `reports/runtime-doctor.json` 的 `gpt-runner`、`codex`、`local-ci` 是否 `ok: true`。

## 明早第一眼順序

1. `runs/<run-id>/autonomous-summary.md`
2. `runs/<run-id>/artifacts/autonomous-debug/terminal-summary.json`
3. `runs/<run-id>/artifacts/autonomous-debug/checkpoint.json`
4. `runs/<run-id>/handoffs-autonomous/dispatch-results.json`
5. `runs/<run-id>/run-state.json`
6. `runs/<run-id>/report.md`
7. `reports/runtime-doctor.json`
8. `runs/<run-id>/artifacts/failure-feedback/failure-feedback-index.json`

## 看到 terminal state 後怎麼做

### `done`

- 確認 `run-state.status` 是 `completed`
- 收尾看 `report.md`
- 再看 dispatch / verification evidence 是否完整

### `blocked`

- 先不要直接重跑 autonomous
- 先看 `checkpoint.json` 的 `resume.requiresIntervention`
- 先看 `terminal-summary.json` 的 `reasonCode`
- 再看 `dispatch-results.json`、`run-state.json`、`runtime-doctor.json`

### `exhausted`

- 先看 `checkpoint.json` 的 `resume.mode`
- 如果是 `immediate`，通常可以直接續跑同一個 command
- 如果是 `scheduled`，先看 `nextRetryAt`

## blocked 的常見早晨判斷

- `runtime_unavailable`
  先查 doctor、shell、權限、上游 provider。
- `no_progress_circuit`
  先查哪個 task 卡在 `in_progress` / `waiting_retry` / `blocked`。
- `blocked_tasks`
  先看被卡住的 feature chain 是否已被 rework / replan。

## 今晚最危險的共享熱點

- `run-state.json`
  這是 source of truth。
- `handoffs*/index.json`
  這是 dispatch 的入口。
- `handoffs*/results/*.result.json`
  這是 attempt-specific result artifact，不要混用舊檔。
- `activeHandoffId` / `activeResultPath`
  這些欄位對不上時，result apply 會出問題。
- `report.md`
  好讀，但只是衍生檔，不是最終真相。

## 如果昨晚其實沒有動

先檢查這四件事：

1. `terminal-summary.json` 裡是不是 `blocked`
2. `checkpoint.json` 裡是不是 `mode: manual`
3. `dispatch-results.json` 是否全部 `skipped`
4. `runtime-doctor.json` 是否缺少 `gpt-runner`、`codex`、或 `local-ci`

## 如果昨晚有動但最後停在 no-progress

先檢查：

1. `terminal-summary.json`
2. `checkpoint.json`
3. `run-state.json` 的 `blocked` / `waiting_retry` / `in_progress`
4. `dispatch-results.json`
5. `hypothesis-ledger.json`

## 不要做的事

- 不要只看 `report.md` 就判斷 run 已經完成。
- 不要把 `blocked` 誤判成 `exhausted`。
- 不要手動複用前一次 handoff 的 result artifact。
- 不要在還沒看 `checkpoint.json` 前就直接重跑。
