#!/bin/bash
# Refresh Withings access token using the stored refresh token
# Usage: refresh-token.sh <userName>
set -euo pipefail

USERNAME="${1:?Usage: refresh-token.sh <userName>}"
CRED_SCRIPT="/Users/robertbrunhage/projects/steve/scripts/credential.sh"

CREDS=$("$CRED_SCRIPT" get "$USERNAME" "withings")
CLIENT_ID=$(echo "$CREDS" | jq -r '.client_id')
CLIENT_SECRET=$(echo "$CREDS" | jq -r '.client_secret')

TOKENS=$("$CRED_SCRIPT" get "$USERNAME" "withings-tokens")
REFRESH_TOKEN=$(echo "$TOKENS" | jq -r '.refresh_token')

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

"$CRED_SCRIPT" set "$USERNAME" "withings-tokens" \
  "{\"access_token\":\"${ACCESS_TOKEN}\",\"refresh_token\":\"${NEW_REFRESH_TOKEN}\",\"expires_at\":${EXPIRES_AT}}"

echo '{"success":true,"message":"Token refreshed."}'
