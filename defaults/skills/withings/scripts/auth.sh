#!/bin/bash
# Withings OAuth 2.0 authorization flow
# Usage: auth.sh <userName>
set -euo pipefail

USERNAME="${1:?Usage: auth.sh <userName>}"
CRED_SCRIPT="/Users/robertbrunhage/projects/steve/scripts/credential.sh"

# Get client credentials
CREDS=$("$CRED_SCRIPT" get "$USERNAME" "withings")
CLIENT_ID=$(echo "$CREDS" | jq -r '.client_id')
CLIENT_SECRET=$(echo "$CREDS" | jq -r '.client_secret')
REDIRECT_URI="http://localhost:8765/callback"

# Build authorization URL
AUTH_URL="https://account.withings.com/oauth2_user/authorize2?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}&scope=user.metrics&state=steve"

echo "Opening browser for Withings authorization..."
open "$AUTH_URL"

# Start local server to capture the callback and extract the code
CODE=$(python3 - <<'PYEOF'
import http.server, urllib.parse, sys

class Handler(http.server.BaseHTTPRequestHandler):
    code = None
    def do_GET(self):
        params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        Handler.code = params.get('code', [''])[0]
        self.send_response(200)
        self.send_header('Content-type', 'text/html')
        self.end_headers()
        self.wfile.write(b'<html><body style="font-family:sans-serif;padding:40px"><h2>Done! Return to Steve.</h2><p>You can close this tab.</p></body></html>')
    def log_message(self, *args):
        pass

server = http.server.HTTPServer(('localhost', 8765), Handler)
server.handle_request()
print(Handler.code)
PYEOF
)

if [[ -z "$CODE" ]]; then
  echo '{"error":"no_code","message":"Did not receive authorization code"}' >&2
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

"$CRED_SCRIPT" set "$USERNAME" "withings-tokens" \
  "{\"access_token\":\"${ACCESS_TOKEN}\",\"refresh_token\":\"${REFRESH_TOKEN}\",\"expires_at\":${EXPIRES_AT}}"

echo '{"success":true,"message":"Authorization complete. Tokens saved."}'
