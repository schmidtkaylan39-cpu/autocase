[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ReleaseZip,
  [string]$OutputRoot,
  [string]$WorkspaceRoot,
  [string]$RunId = "acceptance-run"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-DirectoryPath {
  param(
    [string]$RequestedPath,
    [string]$DefaultPath
  )

  $targetPath = if ([string]::IsNullOrWhiteSpace($RequestedPath)) {
    $DefaultPath
  } else {
    $RequestedPath
  }

  New-Item -ItemType Directory -Force -Path $targetPath | Out-Null
  return (Resolve-Path -LiteralPath $targetPath).Path
}

function Read-TextFile {
  param([string]$Path)

  if (!(Test-Path -LiteralPath $Path)) {
    return ""
  }

  return Get-Content -LiteralPath $Path -Raw -Encoding utf8
}

function Format-CommandArgument {
  param([string]$Value)

  if ($null -eq $Value) {
    return '""'
  }

  if ($Value -notmatch '[\s"]') {
    return $Value
  }

  return '"' + ($Value -replace '"', '\"') + '"'
}

function Write-Utf8File {
  param(
    [string]$Path,
    [string]$Content
  )

  $directory = Split-Path -Parent $Path
  if ($directory) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
  }

  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

function New-FakeCodexFixture {
  param([string]$BinRoot)

  $resolvedBinRoot = Resolve-DirectoryPath -RequestedPath $BinRoot -DefaultPath $BinRoot
  $nodeScriptPath = Join-Path $resolvedBinRoot "fake-codex.mjs"
  $commandPath = Join-Path $resolvedBinRoot "codex.cmd"

  $nodeScript = @'
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);

if (args.includes("--help")) {
  console.log("fake codex help");
  process.exit(0);
}

if (args[0] === "login" && args[1] === "status") {
  console.log("Authenticated as fake-codex");
  process.exit(0);
}

let promptText = "";
for await (const chunk of process.stdin) {
  promptText += chunk;
}

const resultPath = promptText.match(/Write a JSON file to this exact path when you finish: (.+)$/m)?.[1]?.trim();
const runId = promptText.match(/^- runId: (.+)$/m)?.[1]?.trim();
const taskId = promptText.match(/^- taskId: (.+)$/m)?.[1]?.trim();
const handoffId = promptText.match(/^- handoffId: (.+)$/m)?.[1]?.trim();

if (!resultPath || !runId || !taskId || !handoffId) {
  console.error("fake codex could not parse the prompt contract");
  process.exit(1);
}

await mkdir(path.dirname(resultPath), { recursive: true });
await writeFile(
  resultPath,
  JSON.stringify(
    {
      runId,
      taskId,
      handoffId,
      status: "completed",
      summary: `fake codex completed ${taskId}`,
      changedFiles: [],
      verification: ["fake acceptance codex"],
      notes: ["simulated packaged autonomous acceptance execution"]
    },
    null,
    2
  ),
  "utf8"
);
'@

  $command = @'
@echo off
node "%~dp0fake-codex.mjs" %*
'@

  Write-Utf8File -Path $nodeScriptPath -Content $nodeScript
  Write-Utf8File -Path $commandPath -Content $command

  return $resolvedBinRoot
}

function Write-FixturePackageJson {
  param([string]$WorkspacePath)

  $packageJsonPath = Join-Path $WorkspacePath "package.json"
  $packageJson = @'
{
  "name": "ai-factory-acceptance-fixture",
  "private": true,
  "version": "1.0.0",
  "scripts": {
    "build": "node -e \"console.log('build ok')\"",
    "lint": "node -e \"console.log('lint ok')\"",
    "typecheck": "node -e \"console.log('typecheck ok')\"",
    "test": "node -e \"console.log('test ok')\"",
    "test:integration": "node -e \"console.log('integration ok')\"",
    "test:e2e": "node -e \"console.log('fixture e2e ok')\""
  }
}
'@

  Write-Utf8File -Path $packageJsonPath -Content $packageJson
  return $packageJsonPath
}

$resolvedReleaseZip = (Resolve-Path -LiteralPath $ReleaseZip).Path
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$defaultOutputRoot = Join-Path ([System.IO.Path]::GetTempPath()) "ai-factory-acceptance-$timestamp"
$resolvedOutputRoot = Resolve-DirectoryPath -RequestedPath $OutputRoot -DefaultPath $defaultOutputRoot
$resolvedWorkspaceRoot = Resolve-DirectoryPath -RequestedPath $WorkspaceRoot -DefaultPath (Join-Path $resolvedOutputRoot "workspace")
$extractRoot = Resolve-DirectoryPath -RequestedPath (Join-Path $resolvedOutputRoot "release") -DefaultPath (Join-Path $resolvedOutputRoot "release")
$logsRoot = Resolve-DirectoryPath -RequestedPath (Join-Path $resolvedOutputRoot "logs") -DefaultPath (Join-Path $resolvedOutputRoot "logs")
$reportsRoot = Resolve-DirectoryPath -RequestedPath (Join-Path $resolvedOutputRoot "reports") -DefaultPath (Join-Path $resolvedOutputRoot "reports")
$fixtureBinRoot = Resolve-DirectoryPath -RequestedPath (Join-Path $resolvedOutputRoot "fake-bin") -DefaultPath (Join-Path $resolvedOutputRoot "fake-bin")

Remove-Item -LiteralPath (Join-Path $extractRoot "*") -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive -LiteralPath $resolvedReleaseZip -DestinationPath $extractRoot -Force

$exePath = Get-ChildItem -LiteralPath $extractRoot -Recurse -Filter "ai-factory-starter.exe" -File |
  Select-Object -ExpandProperty FullName -First 1

if ([string]::IsNullOrWhiteSpace($exePath)) {
  throw "Could not find ai-factory-starter.exe inside $resolvedReleaseZip"
}

$results = New-Object System.Collections.Generic.List[object]
$stepNumber = 0
$originalPath = $env:PATH

function Invoke-AcceptanceStep {
  param(
    [string]$Step,
    [string[]]$Arguments,
    [string]$WorkingDirectory
  )

  $script:stepNumber += 1
  $safeStep = ($Step -replace "[^A-Za-z0-9_-]", "-").ToLowerInvariant()
  $stdoutPath = Join-Path $logsRoot ("{0:D2}-{1}.stdout.log" -f $script:stepNumber, $safeStep)
  $stderrPath = Join-Path $logsRoot ("{0:D2}-{1}.stderr.log" -f $script:stepNumber, $safeStep)
  $argumentString = ($Arguments | ForEach-Object { Format-CommandArgument -Value $_ }) -join " "

  $process = Start-Process `
    -FilePath $exePath `
    -ArgumentList $argumentString `
    -WorkingDirectory $WorkingDirectory `
    -Wait `
    -NoNewWindow `
    -PassThru `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath

  $stdoutText = Read-TextFile -Path $stdoutPath
  $stderrText = Read-TextFile -Path $stderrPath

  $results.Add([ordered]@{
      step = $Step
      command = @($exePath) + $Arguments
      workingDirectory = $WorkingDirectory
      exitCode = $process.ExitCode
      stdoutPath = $stdoutPath
      stderrPath = $stderrPath
    }) | Out-Null

  if ($stdoutText.Trim().Length -gt 0) {
    Write-Host $stdoutText.TrimEnd()
  }

  if ($process.ExitCode -ne 0) {
    if ($stderrText.Trim().Length -gt 0) {
      Write-Error $stderrText.TrimEnd()
    }

    throw "Acceptance step failed: $Step"
  }
}

try {
  $env:PATH = "$(New-FakeCodexFixture -BinRoot $fixtureBinRoot);$originalPath"
  $packageJsonPath = $null
  $specPath = Join-Path $resolvedWorkspaceRoot "specs\project-spec.json"
  $runsRoot = Join-Path $resolvedWorkspaceRoot "runs"
  $runRoot = Join-Path $runsRoot $RunId
  $runStatePath = Join-Path $runRoot "run-state.json"
  $autonomousSummaryPath = Join-Path $runRoot "autonomous-summary.json"
  $handoffIndexPath = Join-Path $runRoot "handoffs-autonomous\index.json"
  $dispatchResultsPath = Join-Path $runRoot "handoffs-autonomous\dispatch-results.json"

  Invoke-AcceptanceStep -Step "version" -Arguments @("--version") -WorkingDirectory $resolvedWorkspaceRoot
  Invoke-AcceptanceStep -Step "init" -Arguments @("init", $resolvedWorkspaceRoot) -WorkingDirectory $resolvedWorkspaceRoot
  $packageJsonPath = Write-FixturePackageJson -WorkspacePath $resolvedWorkspaceRoot
  Invoke-AcceptanceStep -Step "intake" -Arguments @("intake", "Read local sales.json and write summary.md to artifacts/reports; do not send email and do not call external APIs.", $resolvedWorkspaceRoot) -WorkingDirectory $resolvedWorkspaceRoot
  Invoke-AcceptanceStep -Step "confirm" -Arguments @("confirm", $resolvedWorkspaceRoot) -WorkingDirectory $resolvedWorkspaceRoot
  Invoke-AcceptanceStep -Step "doctor" -Arguments @("doctor", $reportsRoot) -WorkingDirectory $resolvedWorkspaceRoot
  Invoke-AcceptanceStep -Step "validate" -Arguments @("validate", $specPath) -WorkingDirectory $resolvedWorkspaceRoot
  Invoke-AcceptanceStep -Step "plan" -Arguments @("plan", $specPath, $runsRoot) -WorkingDirectory $resolvedWorkspaceRoot
  Invoke-AcceptanceStep -Step "run" -Arguments @("run", $specPath, $runsRoot, $RunId) -WorkingDirectory $resolvedWorkspaceRoot
  Invoke-AcceptanceStep -Step "autonomous" -Arguments @("autonomous", $runStatePath) -WorkingDirectory $resolvedWorkspaceRoot

  $autonomousSummary = Get-Content -LiteralPath $autonomousSummaryPath -Raw -Encoding utf8 | ConvertFrom-Json
  $doctorJsonPath = $autonomousSummary.doctorReportPath
  $doctorSummary = Get-Content -LiteralPath $doctorJsonPath -Raw -Encoding utf8 | ConvertFrom-Json
  $runState = Get-Content -LiteralPath $runStatePath -Raw -Encoding utf8 | ConvertFrom-Json
  $dispatchResults = Get-Content -LiteralPath $dispatchResultsPath -Raw -Encoding utf8 | ConvertFrom-Json

  if ($runState.status -ne "completed") {
    throw "Expected autonomous acceptance run to complete, but status was $($runState.status)."
  }

  if ($autonomousSummary.finalStatus -ne "completed") {
    throw "Expected autonomous summary finalStatus=completed, but got $($autonomousSummary.finalStatus)."
  }

  $requiredPaths = @(
    (Join-Path $resolvedWorkspaceRoot "AGENTS.md"),
    (Join-Path $resolvedWorkspaceRoot "config\factory.config.json"),
    $packageJsonPath,
    $specPath,
    (Join-Path $runRoot "report.md"),
    $runStatePath,
    $autonomousSummaryPath,
    $handoffIndexPath,
    $dispatchResultsPath,
    $doctorJsonPath,
    (Join-Path $reportsRoot "runtime-doctor.md")
  )

  foreach ($requiredPath in $requiredPaths) {
    if (!(Test-Path -LiteralPath $requiredPath)) {
      throw "Expected artifact is missing: $requiredPath"
    }
  }

  $requiredRuntimeStatuses = @{}
  foreach ($check in $doctorSummary.checks) {
    if ($check.requiredByDefaultRoute) {
      $requiredRuntimeStatuses[$check.id] = $check.ok
    }
  }

  $summary = [ordered]@{
    generatedAt = (Get-Date).ToString("o")
    releaseZip = $resolvedReleaseZip
    exePath = $exePath
    outputRoot = $resolvedOutputRoot
    workspaceRoot = $resolvedWorkspaceRoot
    runId = $RunId
    autonomous = @{
      finalStatus = $autonomousSummary.finalStatus
      stopReason = $autonomousSummary.stopReason
      rounds = $autonomousSummary.rounds.Count
      doctorReportPath = $doctorJsonPath
      requiredRuntimeStatuses = $requiredRuntimeStatuses
      finalDispatchCompleted = $dispatchResults.summary.completed
    }
    artifacts = @{
      reportsRoot = $reportsRoot
      runRoot = $runRoot
      autonomousSummaryPath = $autonomousSummaryPath
      handoffIndexPath = $handoffIndexPath
      dispatchResultsPath = $dispatchResultsPath
      doctorJsonPath = $doctorJsonPath
    }
    steps = $results
  }

  $summaryJsonPath = Join-Path $resolvedOutputRoot "acceptance-summary.json"
  $summaryMarkdownPath = Join-Path $resolvedOutputRoot "acceptance-summary.md"

  $summary | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $summaryJsonPath -Encoding utf8

  $markdown = @(
    "# First Acceptance Smoke Summary",
    "",
    "- Generated at: $($summary.generatedAt)",
    "- Release ZIP: $resolvedReleaseZip",
    "- EXE: $exePath",
    "- Workspace: $resolvedWorkspaceRoot",
    "- Run ID: $RunId",
    "- Autonomous final status: $($summary.autonomous.finalStatus)",
    "- Autonomous stop reason: $($summary.autonomous.stopReason)",
    "- Autonomous rounds: $($summary.autonomous.rounds)",
    "",
    "## Artifacts",
    "- acceptance-summary.json",
    "- logs/",
    "- workspace/",
    "- reports/"
  ) -join "`r`n"

  $markdown | Set-Content -LiteralPath $summaryMarkdownPath -Encoding utf8

  Write-Host "Acceptance smoke passed."
  Write-Host "Summary JSON: $summaryJsonPath"
  Write-Host "Summary Markdown: $summaryMarkdownPath"
}
finally {
  $env:PATH = $originalPath
}
