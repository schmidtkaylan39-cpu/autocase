# 工作區隔離 SOP（避免 main 混線）

這份 SOP 用來避免以下問題：

- 在同一個 `main` 工作目錄同時跑多條任務
- 把其他任務留下的 `tmp/`、瀏覽器 profile、驗證產物或未完成功能混進本次提交
- 多個對話同時操作同一個 worktree，造成 `git add` / `commit` / 驗證產物互相污染

## 1. 黃金規則

一條任務線，只用一個 branch；平行任務時，優先連工作目錄也分開。

最安全的做法：

1. `main` 只留給穩定整合、發版前驗證、或已確認要收斂的結果
2. 新任務先開新 branch
3. 只要是平行開工、長時間 smoke、或多對話協作，就另外開新工作目錄

## 2. 任務模式選擇

### 模式 A：小改動、單線工作

適用情況：

- 只改少量檔案
- 不需要多個對話同時動手
- 不需要長時間平行 smoke

操作規則：

1. 從乾淨的 `main` 開新 branch
2. 在同一個工作目錄完成修改
3. 做完後再合回 `main`

### 模式 B：平行驗證、但不改碼

適用情況：

- 同時跑 `acceptance:live`、`browser smoke`、`release:win` 之類的驗證
- 多個對話只做 read-only 或只產生外部產物

操作規則：

1. 可以共用同一個 repo，但每條驗證一定要使用獨立輸出路徑
2. 不要讓兩個對話同時做 `git add`、`git commit`、`git checkout`、`git reset`
3. `selfcheck` 不要和其他會覆寫共用 `reports/` 產物的命令同時跑

### 模式 C：平行開發或高風險任務

適用情況：

- 多個對話會同時改碼
- 同時跑多條不同功能線
- 任務會產生大量 `tmp/`、瀏覽器 profile、截圖、release 產物

操作規則：

1. 開新 branch
2. 再開新工作目錄
3. 每條線各自完成後，再回主線做整合

建議命名：

- `New project-main`
- `New project-panel`
- `New project-release`
- `New project-debug`

## 3. 哪些東西一定不能共用

以下內容如果共用同一個工作目錄，最容易混線：

- `tmp/`
- `reports/`
- `release-artifacts/`
- 瀏覽器 profile
- smoke harness 輸出
- 未追蹤截圖或暫存檔

規則：

1. 不把這些目錄當成「可提交原始碼」
2. 不要從它們推測哪條工作線一定屬於哪次任務，除非有明確 commit 或 artifact 證據
3. 對外驗證時一律指定專屬輸出路徑

## 4. 這個 repo 的平行驗證規則

### 可以平行跑的類型

- `acceptance:live`，但要給獨立 `--output-root`
- `acceptance:panel:browser:full`，但要給獨立 `--output-root`
- `release:win`，但要給獨立 `--output-dir`
- `backup:project`，但要給獨立 `--output-dir`
- `burnin`，但要給獨立 `--summary-file`

### 不要和別人同時共用輸出的類型

- `selfcheck`
- 任何會覆寫 `reports/validation-results.json`
- 任何會覆寫 `reports/runtime-doctor.json`
- 任何會直接修改原始碼或 git index 的操作

## 5. 新任務開始前的檢查

每次開始新任務前，先做這四步：

1. `git status --short`
2. 確認目前 branch
3. 確認這次任務是否要改碼，還是只做驗證
4. 若有平行對話，先決定是否要分工作目錄

只要符合以下任一條，就不要直接在當前 `main` 工作目錄開工：

- `git status --short` 已經很髒，而且你不確定哪些檔案屬於本次任務
- 這次任務會和另一條線同時改碼
- 這次任務會產生大量驗證輸出
- 你打算開多個對話一起跑

## 6. 提交前檢查

提交前一定確認：

1. 只 stage 本次任務需要的檔案
2. 不把未知未追蹤檔直接混進 commit
3. `tmp/`、截圖、瀏覽器 profile、外部測試資料不進 commit
4. 若看到與本次主線無關的未追蹤功能檔，先停下來分類，不要硬塞進同一個 commit

## 7. 發現疑似混線時怎麼做

如果你懷疑「這可能是別的任務資料」，立刻改做以下步驟：

1. 暫停新的 `git add` / `commit`
2. 先看 `git status --short`
3. 再看 `git ls-files --others --exclude-standard`
4. 把檔案分成三類：
   - 本次任務的原始碼
   - 驗證或暫存產物
   - 來源不明、可能屬於其他任務的內容
5. 來源不明的內容，先不要混進本次提交

## 8. 給人類操作者的最短版本

如果你只記得住一句話，請記這句：

`小改動用新 branch；多線並行用新 branch + 新資料夾；main 不直接做實驗。`
