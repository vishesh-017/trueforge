$env:OUTBOUND_URL_ALLOWED_HOSTS = '["127.0.0.1","localhost"]'
if (-not $env:PORT) { $env:PORT = "8790" }
Write-Host "TrueForge will allow the Forgehand editor tools on 127.0.0.1 and localhost."
npx --yes @truefoundry/trueforge@latest
