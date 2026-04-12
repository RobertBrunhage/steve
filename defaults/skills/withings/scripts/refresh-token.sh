#!/bin/bash
# Refresh Withings access token using the stored refresh token
# Usage: refresh-token.sh <userName>
# Credentials injected as KELLIX_CRED_* env vars by the MCP run_script tool
set -euo pipefail

USERNAME="${1:?Usage: refresh-token.sh <userName>}"

CLIENT_ID="${KELLIX_CRED_CLIENT_ID:?Missing KELLIX_CRED_CLIENT_ID}"
CLIENT_SECRET="${KELLIX_CRED_CLIENT_SECRET:?Missing KELLIX_CRED_CLIENT_SECRET}"
REFRESH_TOKEN="${KELLIX_CRED_REFRESH_TOKEN:?Missing KELLIX_CRED_REFRESH_TOKEN}"

RESPONSE=$(curl -s -X POST "https://wbsapi.withings.net/v2/oauth2" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "action=requesttoken" \
  --data-urlencode "grant_type=refresh_token" \
  --data-urlencode "client_id=${CLIENT_ID}" \
  --data-urlencode "client_secret=${CLIENT_SECRET}" \
  --data-urlencode "refresh_token=${REFRESH_TOKEN}")

STATUS=$(echo "$RESPONSE" | jq -r '.status')
if [[ "$STATUS" != "0" ]]; then
  echo '{"error":"refresh_failed","raw":'$(echo "$RESPONSE" | jq -c '.')'}'
  exit 1
fi

ACCESS_TOKEN=$(echo "$RESPONSE" | jq -r '.body.access_token')
NEW_REFRESH_TOKEN=$(echo "$RESPONSE" | jq -r '.body.refresh_token')
EXPIRES_IN=$(echo "$RESPONSE" | jq -r '.body.expires_in')
EXPIRES_AT=$(( $(date +%s) + EXPIRES_IN ))

# Output new tokens as JSON so the caller can update the vault
echo "{\"success\":true,\"access_token\":\"${ACCESS_TOKEN}\",\"refresh_token\":\"${NEW_REFRESH_TOKEN}\",\"expires_at\":${EXPIRES_AT}}"
