---
name: Withings
description: Sync weight and body composition data from the user's Withings scale. Use when the user mentions weight, scale, body fat, Withings, or wants to set up their scale.
per_user: true
requires:
  bins: [curl, jq]
scripts:
  setup.sh:
    redactOutput: false
    secrets:
      - key: users/{user}/withings/app
        fields: [client_id, client_secret]
      - key: users/{user}/withings/tokens
        fields: [access_token, refresh_token, expires_at]
  complete-auth.sh:
    secrets:
      - key: users/{user}/withings/app
        fields: [client_id, client_secret]
  fetch-measurements.sh:
    secrets:
      - key: users/{user}/withings/tokens
        fields: [access_token, expires_at]
  refresh-token.sh:
    secrets:
      - key: users/{user}/withings/app
        fields: [client_id, client_secret]
      - key: users/{user}/withings/tokens
        fields: [refresh_token]
---

## Setup & Sync

IMPORTANT: Always use the MCP `run_script` tool to run scripts. NEVER run them directly with bash/shell. The `run_script` tool injects the exact credentials declared in this skill's frontmatter automatically.

Always start by calling the MCP tool `run_script` with script path and the user's name as the first argument:

- **script**: the absolute path to the script in your workspace, e.g. `/data/skills/withings/scripts/setup.sh`
- **args**: `["Robert"]` (the user's name)

The setup script returns instantly with JSON containing a `status` field:

- **`needs_credentials`** — User needs to add API keys. Send them the `instructions` and `secret_manager` URL for their user page. Wait for them to confirm, then call setup.sh again.
- **`needs_auth`** — User needs to authorize. Send them the `url` to open. Then immediately call `run_script` with `/data/skills/withings/scripts/complete-auth.sh` to wait for the callback.
- **`ready`** — Withings is fully set up. Proceed to fetch measurements.
- **`error`** — Something went wrong. Show the `message`.

## Fetching Measurements

Once setup returns `ready`, call `run_script` with `/data/skills/withings/scripts/fetch-measurements.sh` and `["{userName}"]`.

Returns JSON with available fields: date, weight_kg, fat_ratio, fat_free_mass_kg, muscle_mass_kg, bone_mass_kg.

If it returns `{"error":"token_expired"}`, call setup.sh again — it refreshes tokens automatically.

## Output

Compare with previous data and call out changes. Only fields the scale measured are included.
