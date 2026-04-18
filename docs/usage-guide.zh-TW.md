# AI Factory Starter 使用說明（繁中）

適用版本：`v0.1.2`  
主要定位：`GPT-5.4 / GPT-5.4 Pro`（規劃與審查，manual-first）+ `Codex`（執行）+ `local-ci`（驗證）

---

## 1. 環境需求

- Node.js `>= 22.14.0`
- npm（建議跟 Node 同版）
- Windows 或 Linux（本專案已做跨平台處理）
- 首次使用先安裝依賴：

```bash
npm ci
```

---

## 2. 一分鐘快速開始

### 2.1 初始化工作區

```bash
npx ai-factory-starter init .
```

或在原始碼模式：

```bash
node src/index.mjs init .
```

會建立：

- `AGENTS.md`
- `config/factory.config.json`
- `examples/project-spec.valid.json`
- 相關 prompts/templates 架構

### 2.2 最小工作流（建議）

1. intake（輸入需求）
2. confirm（確認澄清）
3. validate（驗證 spec）
4. plan（生成計畫）
5. run（建立 run）
6. handoff（產生任務交接）
7. dispatch（執行或 dry-run）

---

## 3. CLI 指令速查

```bash
ai-factory-starter init [targetDir]
ai-factory-starter intake <request> [workspaceDir]
ai-factory-starter confirm [workspaceDir]
ai-factory-starter revise [request] [workspaceDir]
ai-factory-starter validate <specPath>
ai-factory-starter plan <specPath> [outputDir]
ai-factory-starter run <specPath> [outputDir] [runId]
ai-factory-starter report <runStatePath>
ai-factory-starter task <runStatePath> <taskId> <status> [note]
ai-factory-starter result <runStatePath> <taskId> <resultPath>
ai-factory-starter retry <runStatePath> <taskId> [reason] [delayMinutes]
ai-factory-starter tick <runStatePath> [doctorReportPath] [outputDir]
ai-factory-starter handoff <runStatePath> [outputDir] [doctorReportPath]
ai-factory-starter dispatch <handoffIndexPath> [dry-run|execute]
ai-factory-starter review-bundle [outputDir] [bundleName] [--no-archive]
ai-factory-starter doctor [outputDir]
```

---

## 4. 常用實戰流程

### 4.1 從需求到執行

```bash
node src/index.mjs intake "請建立一個可自動驗證並發布的流程" .
node src/index.mjs confirm .
node src/index.mjs validate examples/project-spec.valid.json
node src/index.mjs plan examples/project-spec.valid.json runs
node src/index.mjs run examples/project-spec.valid.json runs demo-run
node src/index.mjs handoff runs/demo-run/run-state.json
node src/index.mjs dispatch runs/demo-run/handoffs/index.json dry-run
node src/index.mjs dispatch runs/demo-run/handoffs/index.json execute
```

### 4.2 生成外部審查包（給 GPT/Reviewer）

```bash
npm run selfcheck
node src/index.mjs review-bundle review-bundles external-ai-review-<date>-<commit>-gpt-slim
```

重點：

- bundle 是「source snapshot + evidence」，不是已安裝 runtime image
- reviewer 若要在 `repo/` 內重跑驗證，先 `npm ci`

### 4.3 Windows 發包

```bash
npm run release:win -- --output-dir <your-output-dir>
```

會產出：

- `ai-factory-starter-win-<target>-<commit>.zip`
- `ai-factory-starter-<version>.tgz`
- `release-manifest.json`
- source/git backups

---

## 5. 上線前驗證清單（建議照順序）

```bash
npm run validate:workflows
npm run build
npm run pack:check
npm run lint
npm run typecheck
npm test
npm run selfcheck
```

Windows 發布主機建議另外跑：

```bash
npm run backup:project -- --output-dir reports/release-readiness/backup-smoke
npm run release:win -- --output-dir reports/release-readiness/windows-release-smoke
```

---

## 6. Runtime / Model 路由原則

- 預設主路徑：`GPT-5.4 + Codex`
- planner/reviewer：manual-first（必要時可升級到 `gpt-5.4-pro`）
- executor：`codex`
- verifier：`local-ci`
- `Cursor`/`OpenClaw`：非預設主路徑，需明確 opt-in

---

## 7. 常見問題

### 7.1 為什麼 `plan/run/handoff/dispatch` 被擋住？

通常是 intake 還沒 `confirm`。  
先確認以下檔案狀態：

- `artifacts/clarification/intake-spec.json`
- `artifacts/clarification/intake-summary.md`

### 7.2 為什麼 reviewer 說 bundle 不能直接重跑？

正常行為。bundle 沒附 `node_modules`。  
在 `repo/` 內先跑：

```bash
npm ci
```

### 7.3 如何看目前 runtime 健康度？

```bash
node src/index.mjs doctor
```

---

## 8. 相關文件

- `README.md`
- `docs/release-readiness.md`
- `docs/model-routing.md`
- `docs/runtime-doctor.md`
- `docs/artifact-contract.md`
