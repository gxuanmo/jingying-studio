$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

$engineCommand = "Set-Location '$repoRoot\\engine'; python -m uvicorn app.main:app --reload"
$webCommand = "Set-Location '$repoRoot\\web'; `$env:NEXT_PUBLIC_ENGINE_URL='http://127.0.0.1:8000'; npm run dev"

Start-Process powershell -ArgumentList "-NoExit", "-Command", $engineCommand
Start-Process powershell -ArgumentList "-NoExit", "-Command", $webCommand

