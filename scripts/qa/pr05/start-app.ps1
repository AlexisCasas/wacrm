# LOCAL ONLY. (Re)starts the local app for the PR-05 UAT: fake Shalom + fake OCR + Meta simulator. Nothing here reaches Shalom, Meta or production.
#   powershell -File scripts\qa\pr05\start-app.ps1                  kill switch ON  (SHALOM_TRACKING_ENABLED=true)
#   powershell -File scripts\qa\pr05\start-app.ps1 -KillSwitchOff   kill switch OFF (no Shalom query is made; the DB-only alert clock keeps running)
param([switch]$KillSwitchOff)
$ErrorActionPreference = 'Stop'
Set-Location C:\WACRM-LOCAL

Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2

$env:ORDER_OCR_PROVIDER = 'fake'
$env:SHALOM_PROVIDER = 'fake'
$env:SHALOM_FAKE_SCENARIO_FILE = 'C:\WACRM-LOCAL-QA\shalom-scenarios.json'
if ($KillSwitchOff) { Remove-Item Env:SHALOM_TRACKING_ENABLED -ErrorAction SilentlyContinue } else { $env:SHALOM_TRACKING_ENABLED = 'true' }
$env:NODE_OPTIONS = '--require C:/WACRM-LOCAL/scripts/qa/pr04-integrated/meta-sim.cjs'

Start-Process -FilePath 'npm.cmd' -ArgumentList 'run', 'dev' -WorkingDirectory 'C:\WACRM-LOCAL' -RedirectStandardOutput 'C:\WACRM-LOCAL-QA\dev.log' -RedirectStandardError 'C:\WACRM-LOCAL-QA\dev.err.log' -WindowStyle Hidden

# wait until it answers, then touch the nested API routes (the dev watcher only registers brand-new nested routes after a touch)
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Seconds 2
  try { if ((Invoke-WebRequest -Uri 'http://localhost:3000/login' -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200) { break } } catch {}
}
Get-ChildItem -Recurse -Filter route.ts -Path 'C:\WACRM-LOCAL\src\app\api\orders\shalom', 'C:\WACRM-LOCAL\src\app\api\orders\logistics' | ForEach-Object { $_.LastWriteTime = Get-Date }
Start-Sleep -Seconds 3
"App ready on http://localhost:3000  (Shalom kill switch: " + $(if ($KillSwitchOff) { 'OFF' } else { 'ON' }) + ")"
