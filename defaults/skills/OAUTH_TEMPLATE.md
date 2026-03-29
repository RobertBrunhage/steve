# OAuth Skill Template

Use this alongside `skills/TEMPLATE.md` when a skill needs browser-based authorization.

## When To Use

Use this pattern when setup needs one or more of these:

- a developer app with `client_id` / `client_secret`
- a user-facing authorization URL
- a redirect back to Steve at `/callback`
- exchanging an auth code for tokens
- storing access or refresh tokens with `save_to_vault`

## Recommended Script Shape

Keep OAuth flows split into small scripts:

- `setup.sh` — check credentials, refresh existing tokens if possible, otherwise return `needs_auth` with a URL
- `complete-auth.sh` — poll Steve's callback endpoint for the auth code, exchange it for tokens, and return `save_to_vault`
- `fetch.sh` — use stored tokens for normal API reads
- `refresh.sh` — refresh expired tokens when needed

## SKILL.md Frontmatter

Use per-script secret declarations and disable output redaction only for scripts that must intentionally return a usable auth URL.

```yaml
---
name: Example OAuth Skill
description: Sync data from an OAuth-based service
per_user: true
requires:
  bins: [curl, jq]
scripts:
  setup.sh:
    redactOutput: false
    secrets:
      - key: users/{user}/example/app
        fields: [client_id, client_secret]
      - key: users/{user}/example/tokens
        fields: [access_token, refresh_token, expires_at]
  complete-auth.sh:
    secrets:
      - key: users/{user}/example/app
        fields: [client_id, client_secret]
---
```

## Status Contract

Keep setup scripts predictable and machine-readable. Return JSON with a `status` field:

- `needs_credentials` — the user must add app credentials in Steve
- `needs_auth` — return a user-facing auth URL
- `pending_auth` — still waiting for the callback
- `ready` — setup is complete
- `error` — something failed and the message is safe to show

## Callback Contract

Steve's web server stores OAuth callbacks here:

- browser redirect target: `${STEVE_BASE_URL}/callback`
- poll for auth code: `http://localhost:${STEVE_WEB_PORT}/oauth/code?state=<state>`
- clear consumed code: `DELETE http://localhost:${STEVE_WEB_PORT}/oauth/code?state=<state>`

Rules:

- use a stable `state` and keep it consistent between the auth URL and callback polling
- poll the local callback endpoint from `complete-auth.sh`, not the public hostname
- clear the code after success so the flow is one-time
- use `STEVE_BASE_URL` for redirect URLs shown to the user
- use `STEVE_WEB_PORT` for local callback polling inside the container

## Saving Tokens

When token exchange succeeds, return them through `save_to_vault` only:

```json
{
  "status": "ready",
  "save_to_vault": {
    "key": "users/{userName}/example/tokens",
    "value": {
      "access_token": "...",
      "refresh_token": "...",
      "expires_at": "..."
    }
  }
}
```

Do not place raw tokens in any other output field.

## Redaction Guidance

- output redaction is on by default
- use `redactOutput: false` only for scripts that must return a usable authorization URL or similar user-facing value derived from an injected secret
- keep token exchange and normal API scripts on the default redacted behavior unless there is a strong reason not to

## Agent Instructions Pattern

In your skill's `SKILL.md` body, make the auth flow explicit:

1. run `setup.sh`
2. if `needs_credentials`, send the user the instructions and Steve integration URL
3. if `needs_auth`, send the returned URL and then run `complete-auth.sh`
4. if `pending_auth`, ask the user to finish authorization and retry
5. if `ready`, continue with the actual fetch/sync script

## Minimal `setup.sh` Shape

```bash
#!/bin/bash
set -euo pipefail

USERNAME="${1:?Usage: setup.sh <userName>}"
BASE_URL="${STEVE_BASE_URL:?Missing STEVE_BASE_URL}"
CLIENT_ID="${STEVE_CRED_CLIENT_ID:-}"
CLIENT_SECRET="${STEVE_CRED_CLIENT_SECRET:-}"

if [[ -z "$CLIENT_ID" || -z "$CLIENT_SECRET" ]]; then
  echo '{"status":"needs_credentials"}'
  exit 0
fi

AUTH_URL="https://provider.example/authorize?..."
echo "{\"status\":\"needs_auth\",\"url\":\"${AUTH_URL}\"}"
```

## Minimal `complete-auth.sh` Shape

```bash
#!/bin/bash
set -euo pipefail

WEB_PORT="${STEVE_WEB_PORT:-7838}"
STATE="example"
CODE=""

for _ in $(seq 1 10); do
  RESULT=$(curl -sf "http://localhost:${WEB_PORT}/oauth/code?state=${STATE}" 2>/dev/null || true)
  CODE=$(echo "$RESULT" | jq -r '.code // empty')
  [[ -n "$CODE" ]] && break
  sleep 2
done

if [[ -z "$CODE" ]]; then
  echo '{"status":"pending_auth"}'
  exit 0
fi

curl -sf -X DELETE "http://localhost:${WEB_PORT}/oauth/code?state=${STATE}" >/dev/null 2>&1 || true
echo '{"status":"ready","save_to_vault":{"key":"users/{userName}/example/tokens","value":{"access_token":"..."}}}'
```
