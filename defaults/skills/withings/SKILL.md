---
name: Withings
description: Sync weight and body composition data from the user's Withings scale. Use when the user wants to log measurements from Withings, sync their scale data, or check recent weight/body fat readings.
per_user: true
requires:
  bins: [curl, jq, python3]
---

## Withings Skill

Fetches weight and body composition data from the Withings API and logs it to the user's body-measurements.md file.

### Activation triggers
- "sync from Withings"
- "log my weight from Withings"
- "pull my scale data"
- "what does my scale say"
- Any request to get or sync measurements from Withings

---

### Step 1 - Check credentials

Check for API credentials:
```
/Users/robertbrunhage/projects/steve/scripts/credential.sh has "{userName}" "withings"
```

If missing: walk the user through creating a Withings developer app (already done for Robert - credentials are stored).

---

### Step 2 - Check for OAuth tokens

Check if tokens exist:
```
/Users/robertbrunhage/projects/steve/scripts/credential.sh has "{userName}" "withings-tokens"
```

If tokens are missing, the user needs to authorize. Run the auth flow:
```
bash /Users/robertbrunhage/projects/steve/data/skills/withings/scripts/auth.sh "{userName}"
```

This will:
1. Open the Withings authorization page in the browser
2. Start a local server to capture the OAuth callback
3. Exchange the code for tokens and save them to the Keychain

Tell the user: "Opening Withings in your browser - just approve access and you're done."

---

### Step 3 - Fetch measurements

Run:
```
bash /Users/robertbrunhage/projects/steve/data/skills/withings/scripts/fetch-measurements.sh "{userName}"
```

The script outputs JSON. If it returns `{"error":"token_expired"}`, run the refresh script first:
```
bash /Users/robertbrunhage/projects/steve/data/skills/withings/scripts/refresh-token.sh "{userName}"
```
Then retry the fetch.

---

### Step 4 - Parse and log

The fetch script outputs JSON like:
```json
{
  "date": "2026-03-24",
  "weight_kg": 82.5,
  "fat_ratio": 18.2,
  "muscle_mass_kg": 65.1,
  "bone_mass_kg": 3.2,
  "fat_free_mass_kg": 67.3
}
```

Only fields present in the response should be logged (Withings only returns what the scale measured).

Append this as a new entry to `memory/{userName}/body-measurements.md` using the same format as existing entries.

Then compare with the previous entry and call out any notable changes (weight delta, fat % change, etc.).

---

### Error handling

- **401 / token_expired**: Run refresh-token.sh, then retry
- **Re-auth needed** (refresh also fails): Delete the tokens entry and run auth.sh again
- **No recent measurements**: Tell the user "No measurements found in the last 30 days - have you stepped on the scale recently?"
- **Port 8765 in use**: Tell the user to close whatever is using that port and try again
