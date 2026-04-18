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

$resolvedReleaseZip = (Resolve-Path -LiteralPath $ReleaseZip).Path
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$defaultOutputRoot = Join-Path ([System.IO.Path]::GetTempPath()) "ai-factory-acceptance-$timestamp"
$resolvedOutputRoot = Resolve-DirectoryPath -RequestedPath $OutputRoot -DefaultPath $defaultOutputRoot
$resolvedWorkspaceRoot = Resolve-DirectoryPath -RequestedPath $WorkspaceRoot -DefaultPath (Join-Path $resolvedOutputRoot "workspace")
$extractRoot = Resolve-DirectoryPath -RequestedPath (Join-Path $resolvedOutputRoot "release") -DefaultPath (Join-Path $resolvedOutputRoot "release")
$logsRoot = Resolve-DirectoryPath -RequestedPath (Join-Path $resolvedOutputRoot "logs") -DefaultPath (Join-Path $resolvedOutputRoot "logs")
$reportsRoot = Resolve-DirectoryPath -RequestedPath (Join-Path $resolvedOutputRoot "reports") -DefaultPath (Join-Path $resolvedOutputRoot "reports")

Remove-Item -LiteralPath (Join-Path $extractRoot "*") -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive -LiteralPath $resolvedReleaseZip -DestinationPath $extractRoot -Force

$exePath = Get-ChildItem -LiteralPath $extractRoot -Recurse -Filter "ai-factory-starter.exe" -File |
  Select-Object -ExpandProperty FullName -First 1

if ([string]::IsNullOrWhiteSpace($exePath)) {
  throw "Could not find ai-factory-starter.exe inside $resolvedReleaseZip"
}

$results = New-Object System.Collections.Generic.List[object]
$stepNumber = 0

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

$specPath = Join-Path $resolvedWorkspaceRoot "specs\project-spec.json"
$runsRoot = Join-Path $resolvedWorkspaceRoot "runs"
$runRoot = Join-Path $runsRoot $RunId
$runStatePath = Join-Path $runRoot "run-state.json"
$handoffIndexPath = Join-Path $runRoot "handoffs\index.json"
$dispatchResultsPath = Join-Path $runRoot "handoffs\dispatch-results.json"

Invoke-AcceptanceStep -Step "version" -Arguments @("--version") -WorkingDirectory $resolvedWorkspaceRoot
Invoke-AcceptanceStep -Step "init" -Arguments @("init", $resolvedWorkspaceRoot) -WorkingDirectory $resolvedWorkspaceRoot
Invoke-AcceptanceStep -Step "intake" -Arguments @("intake", "Read local sales.json and write summary.md to artifacts/reports; do not send email and do not call external APIs.", $resolvedWorkspaceRoot) -WorkingDirectory $resolvedWorkspaceRoot
Invoke-AcceptanceStep -Step "confirm" -Arguments @("confirm", $resolvedWorkspaceRoot) -WorkingDirectory $resolvedWorkspaceRoot
Invoke-AcceptanceStep -Step "doctor" -Arguments @("doctor", $reportsRoot) -WorkingDirectory $resolvedWorkspaceRoot
Invoke-AcceptanceStep -Step "validate" -Arguments @("validate", $specPath) -WorkingDirectory $resolvedWorkspaceRoot
Invoke-AcceptanceStep -Step "plan" -Arguments @("plan", $specPath, $runsRoot) -WorkingDirectory $resolvedWorkspaceRoot
Invoke-AcceptanceStep -Step "run" -Arguments @("run", $specPath, $runsRoot, $RunId) -WorkingDirectory $resolvedWorkspaceRoot
Invoke-AcceptanceStep -Step "handoff-planning" -Arguments @("handoff", $runStatePath) -WorkingDirectory $resolvedWorkspaceRoot
Invoke-AcceptanceStep -Step "dispatch-planning-dry-run" -Arguments @("dispatch", $handoffIndexPath, "dry-run") -WorkingDirectory $resolvedWorkspaceRoot

$planningHandoffIndex = Get-Content -LiteralPath $handoffIndexPath -Raw -Encoding utf8 | ConvertFrom-Json
$planningDryRun = Get-Content -LiteralPath $dispatchResultsPath -Raw -Encoding utf8 | ConvertFrom-Json
$planningRuntimeIds = @($planningHandoffIndex.descriptors | ForEach-Object { $_.runtime.id })
$planningHasAutomatedRuntime = $false

foreach ($runtimeId in $planningRuntimeIds) {
  if ($runtimeId -in @("gpt-runner", "codex", "local-ci", "openclaw")) {
    $planningHasAutomatedRuntime = $true
    break
  }
}

if ($planningHasAutomatedRuntime) {
  if ($planningDryRun.summary.wouldExecute -lt 1) {
    throw "Expected planning dry-run to include at least one executable task."
  }
} else {
  if ($planningDryRun.summary.wouldSkip -lt 1) {
    throw "Expected planning dry-run to skip at least one manual task."
  }
}

Invoke-AcceptanceStep -Step "planning-complete" -Arguments @("task", $runStatePath, "planning-brief", "completed", "acceptance planner complete") -WorkingDirectory $resolvedWorkspaceRoot
Invoke-AcceptanceStep -Step "tick" -Arguments @("tick", $runStatePath) -WorkingDirectory $resolvedWorkspaceRoot
Invoke-AcceptanceStep -Step "dispatch-implementation-dry-run" -Arguments @("dispatch", $handoffIndexPath, "dry-run") -WorkingDirectory $resolvedWorkspaceRoot

$implementationHandoffIndex = Get-Content -LiteralPath $handoffIndexPath -Raw -Encoding utf8 | ConvertFrom-Json
$implementationDryRun = Get-Content -LiteralPath $dispatchResultsPath -Raw -Encoding utf8 | ConvertFrom-Json
$implementationRuntimeIds = @($implementationHandoffIndex.descriptors | ForEach-Object { $_.runtime.id })
$hasAutomatedRuntime = $false

foreach ($runtimeId in $implementationRuntimeIds) {
  if ($runtimeId -in @("gpt-runner", "codex", "local-ci", "openclaw")) {
    $hasAutomatedRuntime = $true
    break
  }
}

if ($implementationHandoffIndex.readyTaskCount -lt 1) {
  throw "Expected at least one ready implementation task after planning completion."
}

if ($hasAutomatedRuntime) {
  if ($implementationDryRun.summary.wouldExecute -lt 1) {
    throw "Expected implementation dry-run to include at least one executable task."
  }
} else {
  if ($implementationDryRun.summary.wouldSkip -lt $implementationHandoffIndex.readyTaskCount) {
    throw "Expected manual fallback dry-run to skip all ready implementation tasks."
  }
}

$requiredPaths = @(
  (Join-Path $resolvedWorkspaceRoot "AGENTS.md"),
  (Join-Path $resolvedWorkspaceRoot "config\factory.config.json"),
  $specPath,
  (Join-Path $runRoot "report.md"),
  $runStatePath,
  $handoffIndexPath,
  $dispatchResultsPath,
  (Join-Path $reportsRoot "runtime-doctor.json"),
  (Join-Path $reportsRoot "runtime-doctor.md")
)

foreach ($requiredPath in $requiredPaths) {
  if (!(Test-Path -LiteralPath $requiredPath)) {
    throw "Expected artifact is missing: $requiredPath"
  }
}

$summary = [ordered]@{
  generatedAt = (Get-Date).ToString("o")
  releaseZip = $resolvedReleaseZip
  exePath = $exePath
  outputRoot = $resolvedOutputRoot
  workspaceRoot = $resolvedWorkspaceRoot
  runId = $RunId
  planningDryRun = @{
    wouldSkip = $planningDryRun.summary.wouldSkip
    wouldExecute = $planningDryRun.summary.wouldExecute
    runtimeIds = $planningRuntimeIds
    automatedRuntimeAvailable = $planningHasAutomatedRuntime
  }
  implementationDryRun = @{
    wouldSkip = $implementationDryRun.summary.wouldSkip
    wouldExecute = $implementationDryRun.summary.wouldExecute
    runtimeIds = $implementationRuntimeIds
    automatedRuntimeAvailable = $hasAutomatedRuntime
  }
  artifacts = @{
    reportsRoot = $reportsRoot
    runRoot = $runRoot
    handoffIndexPath = $handoffIndexPath
    dispatchResultsPath = $dispatchResultsPath
    doctorJsonPath = (Join-Path $reportsRoot "runtime-doctor.json")
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
  "- Planning dry-run: wouldSkip=$($summary.planningDryRun.wouldSkip), wouldExecute=$($summary.planningDryRun.wouldExecute)",
  "- Implementation dry-run: wouldSkip=$($summary.implementationDryRun.wouldSkip), wouldExecute=$($summary.implementationDryRun.wouldExecute)",
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
