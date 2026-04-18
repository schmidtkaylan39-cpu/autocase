# AI Factory 面板快啟（繁中）

這個面板是給人類操作的本機瀏覽器介面，底層仍然走同一套 CLI 與 artifact contract。

## 1. 開啟面板

在 repo 根目錄執行：

```bash
node src/index.mjs panel .
```

預設網址：

```text
http://127.0.0.1:4310
```

如果 `4310` 已被占用，可以換埠號：

```bash
node src/index.mjs panel . 4320
```

## 2. 最小操作流程（按鈕順序）

1. `套用工作區`
2. `初始化 init`
3. `1. Intake`
4. `2. Confirm`
5. `3. 建立 Run`
6. `4. Autonomous`

完成後可在面板右側看到最新 run 狀態與任務統計。

## 3. 輸出檔案在哪裡

以 `workspace = C:\demo` 為例：

- run state: `C:\demo\runs\<run-id>\run-state.json`
- run report: `C:\demo\runs\<run-id>\report.md`
- autonomous summary:
  - `C:\demo\runs\<run-id>\autonomous-summary.json`
  - `C:\demo\runs\<run-id>\autonomous-summary.md`
- dispatch results: `C:\demo\runs\<run-id>\handoffs\dispatch-results.json`

## 4. 常見情況

- `intake` 之後 `confirm` 失敗：
  代表澄清條件不足，先修正需求後再按 `intake` / `confirm`。
- `autonomous` 跑完仍非 `completed`：
  打開 run report 檢查 `blocked` / `failed` task，再用 `handoff + dispatch` 或 `autonomous` 續跑。
- 看不到 run：
  先按一次 `重新整理狀態`。

## 5. 關閉面板

回到終端按：

```text
Ctrl + C
```
