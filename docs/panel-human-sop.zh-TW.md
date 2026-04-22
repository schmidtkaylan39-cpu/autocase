# Panel 人類實戰 SOP（繁中）

這份文件是給不懂程式的人直接照著操作的版本。

目標：
- 用瀏覽器打開 AI Factory 中文操作面板
- 用一鍵流程完成一次本地任務
- 確認任務真的完成，而不是只看到畫面在跑

## 1. 先開面板

在專案根目錄開 PowerShell，執行：

```bash
node src/index.mjs panel .
```

打開瀏覽器後，進入：

```text
http://127.0.0.1:4310
```

如果畫面有打開，就代表面板正常。

但要注意：

- 畫面有打開，只代表面板服務已啟動，不代表已完成可交給人員的最小 smoke。
- 只有在 agent 先完成一次最小 live panel smoke 後，才請人測試面板或 UI。
- 最小 smoke 至少要確認：面板可開啟、可跑一次真實一鍵流程、狀態區與操作紀錄有更新。

## 2. 看三個地方

進入面板後，先看：

1. `工作區路徑`
2. `需求內容`
3. `一鍵開始（推薦）`

正常情況下：
- 工作區路徑應該是你現在要操作的資料夾
- 需求內容可以直接貼你想做的事情
- 一鍵開始按鈕可以按

## 3. 需求怎麼寫

建議直接用這個格式：

```text
Start: 目前有哪些本地檔案、資料或前提。
End point: 最後要交付什麼結果。
Success criteria: 怎樣才算成功。
Input source: 會用到哪些本地檔案。
Out of scope: 明確不要做哪些事。
```

範例：

```text
Start: Local workspace contains data/brief.txt and data/details.txt, and artifacts/generated is writable.
End point: Create artifacts/generated/summary.md from both local files.
Success criteria: summary.md exists; includes both tokens; contains a heading named Combined Notes; includes a short Chinese summary.
Input source: data/brief.txt; data/details.txt.
Out of scope: do not modify input files; do not call external APIs; do not send email.
```

## 4. 一鍵實戰流程

照這個順序做：

1. 確認 `工作區路徑` 正確
2. 貼上需求內容
3. 按 `一鍵開始（推薦）`
4. 系統會先跳出起點 / 終點 / 成功指標 / 非範圍確認
5. 如果內容正確，輸入畫面要求的確認字串
6. 讓系統自動繼續跑

你不需要手動跑 `confirm`、`run`、`autonomous`。
面板會自己往下做。

## 5. 怎樣算成功

看右邊狀態區和下方操作紀錄。

成功時要同時看到：

- `需求狀態：已確認`
- `執行狀態：已完成`
- 操作紀錄出現 `Quick start completed`

如果是這次 summary 範例任務，還要確認輸出檔真的存在：

```text
artifacts/generated/summary.md

上面這些條件只代表這次流程有跑通，不代表版本已經 `ready for human` 或 `可實戰`。
只有 `release-ready` gate 通過後，才可以宣稱 `ready for human`、`可實戰` 或等同說法。
在那之前，請只寫成：

- `最小 live panel smoke 已通過`
- `面板可操作`
- `可繼續內部驗證`
```

## 6. 人類只看哪幾個檔案

如果你只想確認「有沒有真的做完」，看這幾個就夠了：

- `runs/<run-id>/run-state.json`
- `runs/<run-id>/autonomous-summary.json`
- `runs/<run-id>/report.md`

最簡單的判斷：

- `run-state.json` 的 `status` 要是 `completed`
- `autonomous-summary.json` 的 `finalStatus` 要是 `completed`

## 7. 常見狀況

### 狀況 A：畫面一直停在確認前

代表需求文字不夠清楚，通常是少了這些：

- Start
- End point
- Success criteria
- Input source
- Out of scope

做法：
- 把需求改成上面的結構化格式
- 再按一次 `一鍵開始`

### 狀況 B：顯示等待重試

代表系統遇到暫時性問題，但還在自動處理。

先做法：
- 等一下
- 按 `重新整理狀態`

### 狀況 C：顯示失敗或需要人工處理

先看：

- `run-state.json`
- `autonomous-summary.json`
- 面板下方 `操作紀錄`

不要先猜原因，先看最新狀態檔。

## 8. 最推薦的人類操作方式

如果你完全不懂程式，就照這套做：

1. 打開面板
2. 確認工作區
3. 貼結構化需求
4. 按 `一鍵開始（推薦）`
5. 輸入確認字串
6. 等到右邊變成 `已完成`
7. 再確認輸出檔存在

## 9. 關閉面板

回到啟動面板的 PowerShell 視窗，按：

```text
Ctrl + C
```

## 10. 一句話版

人類實戰最短流程：

`開面板 -> 貼結構化需求 -> 按一鍵開始 -> 輸入確認字串 -> 等到已完成 -> 檢查輸出檔`
