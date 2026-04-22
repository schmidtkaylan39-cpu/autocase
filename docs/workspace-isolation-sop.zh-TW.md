# 工作區隔離 SOP（避免多對話 / 多 worktree 混線）

這份 SOP 用來避免以下問題：

- 在同一個工作目錄同時跑多條任務
- 多個對話同時寫同一個 worktree
- 把其他任務留下的 `tmp/`、`reports/`、瀏覽器 profile、驗證產物混進本次提交
- 在 detached `HEAD` 或不明 branch 上直接開工，之後很難整合

## 0. 最短規則

先記四句就夠：

1. 一條任務線，只給一個 branch。
2. 一個會寫檔的對話，只給一個 worktree。
3. 長時間驗證和開發編修，預設分 worktree。
4. detached `HEAD` 只拿來看基線，不拿來直接做正式修改。

## 1. 黃金規則

最安全的做法：

1. 整合 branch 只做收斂、驗證、整合，不做多線實驗
2. 新任務先開新 branch
3. 只要是平行開工、長時間 smoke、或多對話協作，就另外開新 worktree
4. 同一個 worktree 同一時間只允許一個「會寫檔 / stage / commit」的對話

## 2. 任務模式選擇

### 模式 A：小改動、單線工作

適用情況：

- 只改少量檔案
- 不需要多個對話同時動手
- 不需要長時間平行 smoke

操作規則：

1. 從乾淨 branch 開新 branch
2. 在同一個 worktree 完成修改
3. 做完後再回整合線收斂

### 模式 B：平行驗證、但不改碼

適用情況：

- 同時跑 `acceptance:live`、`browser smoke`、`release:win`、`burnin`
- 多個對話只做 read-only 或只產生外部產物

操作規則：

1. 可以共用同一個 repo，但每條驗證一定要使用獨立輸出路徑
2. 不要讓兩個對話同時做 `git add`、`git commit`、`git checkout`、`git reset`
3. `selfcheck` 不要和其他會覆寫共用 `reports/` 產物的命令同時跑

### 模式 C：平行開發或高風險任務

適用情況：

- 多個對話會同時改碼
- 同時跑多條功能線
- 任務會產生大量 `tmp/`、瀏覽器 profile、截圖、release 產物
- 任務會碰到共享 hotspot，例如 `src/lib/commands.mjs`、`src/lib/dispatch.mjs`

操作規則：

1. 先開新 branch
2. 再開新 worktree
3. 每條線各自完成後，再回整合線做 merge 或 cherry-pick

## 3. 多對話 / 多 worktree 正確操作方式

正確映射方式：

- 一個對話 = 一個明確任務目標
- 一個任務目標 = 一個 branch
- 一個 branch 的實際寫入 = 一個 worktree owner

可以平行的情況：

- 對話 A 改 docs lane，對話 B 跑 soak lane，而且兩者在不同 worktree
- 對話 A 跑 read-only 檢查，對話 B 在另一個 worktree 寫碼

不可以平行的情況：

- 兩個對話同時在同一個 worktree 寫同一組 hotspot 檔案
- 一個對話正在 `git add` / `commit`，另一個對話在同一 worktree 產生新的驗證產物
- 兩個對話共用同一個 `reports/` 或同一個 acceptance output root

## 4. 建議 branch / worktree 開法

如果你是從整合線分出新工作，建議流程：

```bash
git switch feat/24h-hardening-reconcile
git worktree add ..\\hardening-docs -b feat/24h-hardening-docs feat/24h-hardening-reconcile
git worktree add ..\\hardening-fi-control-plane -b feat/24h-hardening-fi-control-plane feat/24h-hardening-reconcile
git worktree add ..\\hardening-soak -b feat/24h-hardening-soak feat/24h-hardening-reconcile
```

命名原則：

- worktree 名稱帶 lane 名
- branch 名稱帶 lane 名
- 不要讓 branch / worktree 名稱跟任務內容脫鉤

## 5. 哪些東西一定不能共用

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

## 6. 這個 repo 的平行驗證規則

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

## 7. 新任務開始前的檢查

每次開始新任務前，先做這五步：

1. `git status --short`
2. 確認目前 branch，不要忽略 detached `HEAD`
3. 確認這次任務是改碼、改 docs、還是只做驗證
4. 確認有沒有其他對話也會碰同一組 hotspot
5. 決定是否需要新 worktree

只要符合以下任一條，就不要直接在當前 worktree 開工：

- `git status --short` 已經很髒，而且你不確定哪些檔案屬於本次任務
- 目前是 detached `HEAD`
- 這次任務會和另一條線同時改碼
- 這次任務會產生大量驗證輸出
- 你打算開多個對話一起跑

## 8. 提交前檢查

提交前一定確認：

1. 只 stage 本次任務需要的檔案
2. 不把未知未追蹤檔直接混進 commit
3. `tmp/`、截圖、瀏覽器 profile、外部測試資料不進 commit
4. 若看到與本次主線無關的未追蹤功能檔，先停下來分類，不要硬塞進同一個 commit
5. 如果同一 branch 還有別的 worktree 正在跑長時間驗證，先確認輸出沒有互相覆寫

## 9. 發現疑似混線時怎麼做

如果你懷疑「這可能是別的任務資料」，立刻改做以下步驟：

1. 暫停新的 `git add` / `commit`
2. 先看 `git status --short`
3. 再看 `git ls-files --others --exclude-standard`
4. 把檔案分成三類：
   - 本次任務的原始碼
   - 驗證或暫存產物
   - 來源不明、可能屬於其他任務的內容
5. 來源不明的內容，先不要混進本次提交

## 10. 給人類操作者的最短版本

如果你只記得住一句話，請記這句：

`一條任務一個 branch；一個寫手一個 worktree；長跑驗證另外開；detached HEAD 不直接開工。`
