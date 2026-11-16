#!/usr/bin/env bash
export OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]'
export PORT="${PORT:-8790}"
echo "TrueForge will allow the Forgehand editor tools on 127.0.0.1 and localhost."
exec npx --yes @truefoundry/trueforge@latest
