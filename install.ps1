# Lead Responder — one-line installer for Windows 10 (1809+) / 11
#   irm https://raw.githubusercontent.com/shayleg-a11y/lead-responder/main/install.ps1 | iex
#   To pre-load the activation key:  $env:LEAD_RESPONDER_KEY="sk-ant-..."; irm ... | iex
$ErrorActionPreference = "Stop"

$RepoUrl = if ($env:LEAD_RESPONDER_REPO) { $env:LEAD_RESPONDER_REPO } else { "https://github.com/shayleg-a11y/lead-responder.git" }
$Branch  = if ($env:LEAD_RESPONDER_BRANCH) { $env:LEAD_RESPONDER_BRANCH } else { "main" }
$HomeDir = Join-Path $env:USERPROFILE ".lead-responder"
$AppDir  = Join-Path $HomeDir "app"
$Port    = if ($env:LEAD_RESPONDER_PORT) { $env:LEAD_RESPONDER_PORT } else { "4747" }
$Log     = Join-Path $HomeDir "app.log"
New-Item -ItemType Directory -Force -Path $HomeDir | Out-Null

function Say($m) { Write-Host "`n$m" -ForegroundColor Cyan }
function Have($c) { return [bool](Get-Command $c -ErrorAction SilentlyContinue) }

Say "Lead Responder installer"

# ---- Node 22.13+ (via winget) ------------------------------------------------
$needNode = $true
if (Have node) {
  $v = (& node -p "process.versions.node")
  $parts = $v.Split("."); $maj = [int]$parts[0]; $min = [int]$parts[1]
  if ($maj -gt 22 -or ($maj -eq 22 -and $min -ge 13)) { $needNode = $false }
}
if ($needNode) {
  if (-not (Have winget)) { throw "winget is required (Windows 10 1809+ / 11). Install 'App Installer' from the Microsoft Store and run again." }
  Say "Installing Node.js LTS"
  winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements --silent | Out-Null
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
}
if (-not (Have git)) {
  Say "Installing Git"
  winget install --id Git.Git -e --accept-package-agreements --accept-source-agreements --silent | Out-Null
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
}
$NodeBin = (Get-Command node).Source
Say "Node: $(& node -v) at $NodeBin"

# ---- code --------------------------------------------------------------------
if (Test-Path (Join-Path $AppDir ".git")) {
  Say "Updating existing install"
  git -C $AppDir fetch --quiet origin $Branch
  git -C $AppDir reset --quiet --hard "origin/$Branch"
} else {
  Say "Downloading Lead Responder"
  if (Test-Path $AppDir) { Remove-Item -Recurse -Force $AppDir }
  git clone --quiet --depth 1 --branch $Branch $RepoUrl $AppDir
}
Set-Location $AppDir
Say "Installing dependencies (downloads a private Chromium, ~150 MB)"
npm install --include=dev --no-audit --no-fund --loglevel=error
Say "Building"
npm run build --silent

# ---- key ---------------------------------------------------------------------
if ($env:LEAD_RESPONDER_KEY) {
  $settingsPath = Join-Path $HomeDir "settings.json"
  $s = @{}
  if (Test-Path $settingsPath) { $s = Get-Content $settingsPath -Raw | ConvertFrom-Json -AsHashtable }
  $s["anthropicApiKey"] = $env:LEAD_RESPONDER_KEY
  $s | ConvertTo-Json -Depth 10 | Set-Content $settingsPath
  Say "Activation key saved"
}

# ---- autostart: Task Scheduler job, runs hidden at logon ---------------------
$TaskName = "LeadResponder"
$runner = Join-Path $HomeDir "run.vbs"
@"
Set sh = CreateObject("WScript.Shell")
sh.Environment("Process")("LEAD_RESPONDER_QUIET") = "1"
sh.Run """$NodeBin"" ""$AppDir\dist\index.js"" start --no-open --port $Port", 0, False
"@ | Set-Content $runner
$action  = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$runner`"" -WorkingDirectory $AppDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "Lead Responder (runs hidden at logon)" | Out-Null
Start-ScheduledTask -TaskName $TaskName
Say "Installed as a logon task ($TaskName)"

# ---- open the setup page -----------------------------------------------------
$url = "http://localhost:$Port"
for ($i = 0; $i -lt 30; $i++) {
  try { Invoke-RestMethod "$url/api/state" -TimeoutSec 2 | Out-Null; break } catch { Start-Sleep 1 }
}
Say "Done. Setup page: $url"
Start-Process $url
Write-Host "Logs: $Log   ·   Start over: node $AppDir\dist\index.js reset"
