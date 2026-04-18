# AI Factory 面板使用說明（繁中）

這個面板是給一般使用者操作的，不需要先會寫程式。

## 1. 啟動面板

在專案根目錄開 PowerShell，執行：

```bash
node src/index.mjs panel .
```

開瀏覽器進入：

```text
http://127.0.0.1:4310
```

如果 `4310` 被占用，可改成：

```bash
node src/index.mjs panel . 4320
```

## 2. 最簡單流程（推薦）

面板上只要做三件事：

1. 確認「工作區路徑」
2. 輸入「需求內容」
3. 按「一鍵開始（推薦）」

一鍵開始會自動依序做：

1. 初始化 `init`
2. 需求澄清 `intake`
3. 需求確認 `confirm`
4. 建立 Run `run`
5. 全自動執行 `autonomous`

## 3. 怎麼看有沒有成功

看「目前狀態」：

- 需求狀態：`已確認`
- 執行狀態：`已完成`
- 阻塞任務：`0`
- 失敗任務：`0`

再看「操作紀錄」最後一行是否顯示：

- `一鍵開始完成`

## 4. 在面板直接看 GPT 發問內容

按「查看 GPT 發問內容」按鈕。

面板會顯示：

- 使用的 runtime/model（例如 `gpt-runner`、`gpt-5.4`）
- provider / session id / endpoint / cf-ray（如果有）
- 擷取到的 prompt 內容（從 `dispatch-results.json`）

## 5. 主要產物位置

假設工作區是 `C:\\demo`，會有：

- `C:\\demo\\runs\\<run-id>\\run-state.json`
- `C:\\demo\\runs\\<run-id>\\report.md`
- `C:\\demo\\runs\\<run-id>\\autonomous-summary.json`
- `C:\\demo\\runs\\<run-id>\\autonomous-summary.md`
- `C:\\demo\\runs\\<run-id>\\handoffs\\dispatch-results.json`

## 6. 常見狀況

- 顯示「等待確認」或「確認失敗」  
  需求可能太模糊，請把輸入/輸出/限制寫更明確後再重試。
- 顯示「失敗任務 > 0」  
  先按「重新整理狀態」，再看操作紀錄中的錯誤訊息。
- 想手動一步一步跑  
  展開「進階操作（選用）」再按對應按鈕。

## 7. 關閉面板

回到啟動面板的終端視窗，按：

```text
Ctrl + C
```
