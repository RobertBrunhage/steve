#!/bin/bash
# Withings setup check — returns status instantly, never blocks
# Usage: setup.sh <userName>
set -euo pipefail

USERNAME="${1:?Usage: setup.sh <userName>}"
BASE_URL="${STEVE_BASE_URL:-http://localhost:3000}"

# Step 1: Check client credentials
CLIENT_ID="${STEVE_CRED_CLIENT_ID:-}"
CLIENT_SECRET="${STEVE_CRED_CLIENT_SECRET:-}"

if [[ -z "$CLIENT_ID" || -z "$CLIENT_SECRET" ]]; then
  cat <<EOF
{"status":"needs_credentials","instructions":[
  "Create a Withings developer app at https://developer.withings.com",
  "Set callback URL to: ${BASE_URL}/callback",
  "Open your Steve user page and add client_id and client_secret to the Withings integration"
],"secret_manager":"${BASE_URL}/users/${USERNAME}/integrations/new?integration=withings"}
EOF
  exit 0
fi

# Step 2: Check for valid tokens
ACCESS_TOKEN="${STEVE_CRED_ACCESS_TOKEN:-}"
EXPIRES_AT="${STEVE_CRED_EXPIRES_AT:-0}"
NOW=$(date +%s)

if [[ -n "$ACCESS_TOKEN" && $(( EXPIRES_AT - NOW )) -gt 300 ]]; then
  echo '{"status":"ready","message":"Withings is set up and working."}'
  exit 0
fi

# Step 3: Try refreshing tokens
REFRESH_TOKEN="${STEVE_CRED_REFRESH_TOKEN:-}"
if [[ -n "$REFRESH_TOKEN" ]]; then
  RESPONSE=$(curl -s -X POST "https://wbsapi.withings.net/v2/oauth2" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    --data-urlencode "action=requesttoken" \
    --data-urlencode "grant_type=refresh_token" \
    --data-urlencode "client_id=${CLIENT_ID}" \
    --data-urlencode "client_secret=${CLIENT_SECRET}" \
    --data-urlencode "refresh_token=${REFRESH_TOKEN}")

  STATUS=$(echo "$RESPONSE" | jq -r '.status')
  if [[ "$STATUS" == "0" ]]; then
    NEW_ACCESS=$(echo "$RESPONSE" | jq -r '.body.access_token')
    NEW_REFRESH=$(echo "$RESPONSE" | jq -r '.body.refresh_token')
    NEW_EXPIRES_IN=$(echo "$RESPONSE" | jq -r '.body.expires_in')
    NEW_EXPIRES_AT=$(( $(date +%s) + NEW_EXPIRES_IN ))

    echo "{\"status\":\"ready\",\"message\":\"Withings tokens refreshed. Setup complete.\",\"save_to_vault\":{\"key\":\"users/${USERNAME}/withings/tokens\",\"value\":{\"access_token\":\"${NEW_ACCESS}\",\"refresh_token\":\"${NEW_REFRESH}\",\"expires_at\":\"${NEW_EXPIRES_AT}\"}}}"
    exit 0
  fi
fi

# Step 4: Need OAuth — return URL immediately, don't block
REDIRECT_URI="${BASE_URL}/callback"
ENCODED_REDIRECT=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${REDIRECT_URI}', safe=''))")
AUTH_URL="https://account.withings.com/oauth2_user/authorize2?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${ENCODED_REDIRECT}&scope=user.metrics&state=steve"

echo "{\"status\":\"needs_auth\",\"message\":\"Open this link to authorize Withings\",\"url\":\"${AUTH_URL}\"}"
