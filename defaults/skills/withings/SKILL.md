---
name: Withings
description: Sync weight and body composition data from the user's Withings scale. Use when the user mentions weight, scale, body fat, or Withings.
per_user: true
requires:
  bins: [curl, jq]
---

## Setup

If fetch-measurements.sh fails with "Missing STEVE_CRED":

1. Call `get_secret_manager_url` to get the secret manager link
2. Tell the user to:
   - Create a Withings developer app at https://developer.withings.com
   - Set the callback URL to the same host as the secret manager, port 3000: `http://<host-ip>:3000/callback`
   - Add `client_id` and `client_secret` in the secret manager under `{userName}/withings`
3. Wait for the user to confirm they've added the credentials

Once credentials are saved, run the auth flow:
```
run_script: skills/withings/scripts/auth.sh
args: ["{userName}"]
```

The script outputs a message with an authorization URL. Send that URL to the user via Telegram. They tap it, approve on Withings, and the script automatically captures the callback and returns the tokens.

Save the returned tokens (access_token, refresh_token, expires_at) to the vault under `{userName}/withings-tokens` using the vault set endpoint or secret manager.

## Usage

Fetch the latest measurements:
```
run_script: skills/withings/scripts/fetch-measurements.sh
args: ["{userName}"]
```

If result is `{"error":"token_expired"}`, refresh first:
```
run_script: skills/withings/scripts/refresh-token.sh
args: ["{userName}"]
```
Then save the new tokens to `{userName}/withings-tokens` and retry the fetch.

## Output

The fetch script returns JSON with available fields: date, weight_kg, fat_ratio, fat_free_mass_kg, muscle_mass_kg, bone_mass_kg. Only fields the scale measured are included.

Compare with previous data and call out changes.

## Error handling

- **token_expired**: Run refresh-token.sh, save new tokens, retry fetch
- **Refresh also fails**: Delete `{userName}/withings-tokens` from the vault and run auth.sh again
- **No recent measurements**: Tell the user no measurements found in the last 30 days
