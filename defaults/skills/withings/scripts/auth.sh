#!/bin/bash
# Withings OAuth 2.0 authorization flow
# Usage: auth.sh <userName>
# Credentials injected as STEVE_CRED_* env vars by the MCP run_script tool
set -euo pipefail

USERNAME="${1:?Usage: auth.sh <userName>}"

CLIENT_ID="${STEVE_CRED_CLIENT_ID:?Missing STEVE_CRED_CLIENT_ID}"
CLIENT_SECRET="${STEVE_CRED_CLIENT_SECRET:?Missing STEVE_CRED_CLIENT_SECRET}"

# Callback is handled by the Steve web server
HOST_IP="${STEVE_HOST_IP:-localhost}"
CALLBACK_PORT="${STEVE_WEB_PORT:-3000}"
REDIRECT_URI="http://${HOST_IP}:${CALLBACK_PORT}/callback"
ENCODED_REDIRECT=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${REDIRECT_URI}', safe=''))")

# Build authorization URL
AUTH_URL="https://account.withings.com/oauth2_user/authorize2?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${ENCODED_REDIRECT}&scope=user.metrics&state=steve"

echo "Authorize Withings by opening this link: ${AUTH_URL}"

# Poll for the OAuth code (web server captures it at /callback)
CODE=""
for i in $(seq 1 60); do
  RESULT=$(curl -sf "http://localhost:${CALLBACK_PORT}/oauth/code" 2>/dev/null || true)
  if [[ -n "$RESULT" ]]; then
    CODE=$(echo "$RESULT" | jq -r '.code // empty')
    if [[ -n "$CODE" ]]; then
      break
    fi
  fi
  sleep 2
done

if [[ -z "$CODE" ]]; then
  echo '{"error":"timeout","message":"Did not receive authorization code within 2 minutes"}' >&2
  exit 1
fi

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
  echo "$RESPONSE" >&2
  exit 1
fi

ACCESS_TOKEN=$(echo "$RESPONSE" | jq -r '.body.access_token')
REFRESH_TOKEN=$(echo "$RESPONSE" | jq -r '.body.refresh_token')
EXPIRES_IN=$(echo "$RESPONSE" | jq -r '.body.expires_in')
EXPIRES_AT=$(( $(date +%s) + EXPIRES_IN ))

# Output tokens as JSON so the caller can update the vault
echo "{\"success\":true,\"access_token\":\"${ACCESS_TOKEN}\",\"refresh_token\":\"${REFRESH_TOKEN}\",\"expires_at\":${EXPIRES_AT}}"
