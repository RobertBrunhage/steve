#!/bin/bash
# Withings OAuth completion — polls briefly for callback, returns status
# Usage: complete-auth.sh <userName>
# Call this AFTER the user has opened the auth URL
set -euo pipefail

USERNAME="${1:?Usage: complete-auth.sh <userName>}"
BASE_URL="${STEVE_BASE_URL:-http://localhost:7838}"
WEB_PORT="${STEVE_WEB_PORT:-7838}"

CLIENT_ID="${STEVE_CRED_CLIENT_ID:?Missing CLIENT_ID}"
CLIENT_SECRET="${STEVE_CRED_CLIENT_SECRET:?Missing CLIENT_SECRET}"
REDIRECT_URI="${BASE_URL}/callback"

# Poll for a short window then return status (don't block forever)
POLL_SECONDS="${STEVE_AUTH_POLL_SECONDS:-20}"
SLEEP_SECONDS=2
ITERATIONS=$(( POLL_SECONDS / SLEEP_SECONDS ))
if [[ "$ITERATIONS" -lt 1 ]]; then ITERATIONS=1; fi

CODE=""
for i in $(seq 1 "$ITERATIONS"); do
  RESULT=$(curl -sf "http://localhost:${WEB_PORT}/oauth/code?state=steve" 2>/dev/null || true)
  if [[ -n "$RESULT" ]]; then
    CODE=$(echo "$RESULT" | jq -r '.code // empty')
    if [[ -n "$CODE" ]]; then
      break
    fi
  fi
  sleep "$SLEEP_SECONDS"
done

if [[ -z "$CODE" ]]; then
  echo '{"status":"pending_auth","message":"Still waiting for Withings authorization. Open the auth link, complete it, then run complete-auth again."}'
  exit 0
fi

curl -sf -X DELETE "http://localhost:${WEB_PORT}/oauth/code?state=steve" >/dev/null 2>&1 || true

# Exchange code for tokens
RESPONSE=$(curl -s -X POST "https://wbsapi.withings.net/v2/oauth2" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "action=requesttoken" \
  --data-urlencode "grant_type=authorization_code" \
  --data-urlencode "client_id=${CLIENT_ID}" \
  --data-urlencode "client_secret=${CLIENT_SECRET}" \
  --data-urlencode "code=${CODE}" \
  --data-urlencode "redirect_uri=${REDIRECT_URI}")

STATUS=$(echo "$RESPONSE" | jq -r '.status')
if [[ "$STATUS" != "0" ]]; then
  echo "{\"status\":\"error\",\"message\":\"Token exchange failed\",\"raw\":$(echo "$RESPONSE" | jq -c '.')}"
  exit 1
fi

ACCESS_TOKEN=$(echo "$RESPONSE" | jq -r '.body.access_token')
REFRESH_TOKEN=$(echo "$RESPONSE" | jq -r '.body.refresh_token')
EXPIRES_IN=$(echo "$RESPONSE" | jq -r '.body.expires_in')
EXPIRES_AT=$(( $(date +%s) + EXPIRES_IN ))

# Output tokens via save_to_vault convention — Steve strips this before AI sees it
echo "{\"status\":\"ready\",\"message\":\"Withings authorized and tokens saved.\",\"save_to_vault\":{\"key\":\"users/${USERNAME}/withings/tokens\",\"value\":{\"access_token\":\"${ACCESS_TOKEN}\",\"refresh_token\":\"${REFRESH_TOKEN}\",\"expires_at\":\"${EXPIRES_AT}\"}}}"
