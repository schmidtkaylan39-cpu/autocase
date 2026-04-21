# Panel Quick Start（繁中）

這個面板是給一般操作者使用的，不需要先懂程式。

## 1. 啟動面板

在專案根目錄開啟 PowerShell，執行：

```bash
node src/index.mjs panel .
```

瀏覽器開啟：

```text
http://127.0.0.1:4310
```

如果 `4310` 被占用，可以改成：

```bash
node src/index.mjs panel . 4320
```

## 2. 建議操作流程

面板上的推薦流程不是「直接按一下就立刻執行」，而是安全的一鍵流程：

1. 確認「工作區路徑」正確
2. 保留或修改已提供的結構化需求模板
3. 按「一鍵開始（推薦）」
4. 先看系統整理出的起點 / 終點 / 成功指標 / 非範圍
5. 輸入確認語句，讓流程繼續執行

面板會依序做：

1. `intake-preview`
2. 人工確認
3. `confirm`
4. `run`
5. `autonomous`

## 3. 預設需求模板長什麼樣子

首頁文字框預設會放一份可直接分析的結構化模板，格式像這樣：

```text
Start: ...
End point: ...
Success criteria: ...
Input source: ...
Out of scope: ...
```

如果你貼的是自由文字，系統可能會先要求你補清楚起點、終點、成功指標或輸入來源。

## 4. 怎麼看是否完成

先看「目前狀態」：

- 最新 run 的狀態是否為 `completed`
- blocked / failed / waiting_retry 是否為 `0`

再看「操作紀錄」最後幾行，現在的完成訊息會是這類文字：

- `Quick start completed`
- 或 log 內含 `"finalStatus": "completed"`

## 5. 在面板直接看 GPT 發問內容

按「查看 GPT 發問內容」按鈕後，面板會顯示：

- 使用到的 runtime / model
- provider / session id / endpoint / cf-ray（如果有）
- 擷取到的 prompt 內容

## 6. 主要產物位置

假設工作區是 `C:\demo`，常見產物在：

- `C:\demo\runs\<run-id>\run-state.json`
- `C:\demo\runs\<run-id>\report.md`
- `C:\demo\runs\<run-id>\autonomous-summary.json`
- `C:\demo\runs\<run-id>\autonomous-summary.md`
- `C:\demo\runs\<run-id>\handoffs\dispatch-results.json`

## 7. 常見情況

- 如果顯示需要先補資訊
  代表需求還不夠清楚，請把起點 / 終點 / 成功指標 / 輸入來源補完整後再試一次。
- 如果顯示 waiting_retry
  代表系統在等下一次自動重試，可以先按「重新整理狀態」或使用 `Resume now`。
- 如果顯示 failed 或 blocked
  先看 `run-state.json`、`autonomous-summary.json` 和操作紀錄的最新錯誤。

## 8. 關閉面板

回到啟動面板的終端視窗，按：

```text
Ctrl + C
```
