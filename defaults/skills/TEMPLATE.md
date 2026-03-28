# Skill Template

Use this template when creating new skills. A skill is a directory inside `skills/`.

## Directory Structure

```
skill-name/
  SKILL.md              # Required: frontmatter + instructions
  skill.json            # Optional but recommended: script secret/capability manifest
  scripts/              # Optional: executable scripts the agent can run
    auth.sh             # e.g., OAuth flow helper
    fetch.sh            # e.g., API call wrapper
  templates/            # Optional: file templates for consistent data formats
    some-file.md        # Template the agent copies when creating user files
```

## SKILL.md Frontmatter

```yaml
---
name: Skill Name
description: One-line description of what this skill does and when to use it
per_user: true                    # true if each user needs their own credentials
requires:
  bins: [curl, jq]               # CLI tools that must be installed
---
```

### Fields

- **name** (required): Display name
- **description** (required): What the skill does. Be specific, this helps decide when to use it.
- **per_user** (optional): Set to `true` if each user needs their own credentials/tokens.
- **requires.bins** (optional): CLI binaries that must exist on PATH.

## SKILL.md Body

Write natural-language instructions for the agent. Include:

1. What this skill does
2. When to activate it
3. Step-by-step workflows using `run_script` tool for script execution and `{userName}` for the current user
4. What files to read/write and where
5. Error handling guidance
6. Setup instructions for walking the user through first-time auth

## Scripts

- Scripts are run by the agent via the `run_script` MCP tool
- Reference them as: `skills/{skill-name}/scripts/script-name.sh`
- The first argument is always the userName
- Scripts should output JSON or structured text the agent can interpret
- Scripts should return meaningful exit codes
- Keep scripts focused on deterministic tasks (API calls, auth, data fetching)

## skill.json

Use `skill.json` to declare exactly which vault entries a script needs. Steve injects only the declared fields, which keeps secrets scoped tightly and improves output redaction.

Example:

```json
{
  "scripts": {
    "fetch.sh": {
      "secrets": [
        {
          "key": "{user}/weather",
          "fields": ["api_key"]
        }
      ]
    },
    "refresh.sh": {
      "secrets": [
        {
          "key": "{user}/weather",
          "fields": ["client_id", "client_secret"]
        },
        {
          "key": "{user}/weather-tokens",
          "fields": ["refresh_token"]
        }
      ]
    }
  }
}
```

### Rules

- Use `{user}` or `{userName}` in vault keys and Steve substitutes the current user slug.
- If `fields` is omitted, all fields in that vault entry are injected.
- Keep manifests narrow. Only request the secrets a script actually needs.
- New skills that need credentials should create `skill.json` alongside `SKILL.md`.

## Templates

If your skill creates user files (logs, profiles, etc.), add templates in a `templates/` directory. The agent reads these before creating files to ensure consistent formatting across users.

## Credentials

Skills are global. Credentials are per-user.

Per-user credentials are stored in the encrypted vault, managed through the secret manager web UI. When a script runs via `run_script`, Steve injects only the environment variables declared in `skill.json`.

The vault key format is `{userName}/{skill-name}` with a JSON object value. Each field becomes `STEVE_CRED_{FIELD_NAME_UPPERCASED}`.

Example: vault key `Robert/weather` with value `{"api_key": "abc123"}` becomes `STEVE_CRED_API_KEY=abc123` in the script's environment.

### Setup flow

When credentials are missing:
1. Call `get_secret_url` to get the secret manager link
2. Tell the user to open it and add their credentials under `{userName}/{skill-name}`
3. Once confirmed, run the skill's scripts normally (credentials are injected automatically)

### In scripts

```bash
# Credentials are available as env vars - no need to fetch them
API_KEY="${STEVE_CRED_API_KEY:?Missing STEVE_CRED_API_KEY}"
```

### Saving credentials from scripts

If your script produces credentials that need to be stored (e.g., OAuth tokens), include a `save_to_vault` field in the JSON output:

```json
{"status": "ready", "save_to_vault": {"key": "{userName}/skill-name", "value": {"token": "..."}}}
```

Steve saves it to the vault automatically and **strips it before the AI sees the output**. The AI only receives `{"status": "ready"}`. NEVER output raw credentials in any other field.

## Example: API Skill with Auth

```yaml
---
name: Weather
description: Get current weather and forecasts for any location
per_user: true
requires:
  bins: [curl, jq]
---

## Setup
If the fetch script fails with "Missing STEVE_CRED":
1. Call `get_secret_url` to get the link
2. Tell the user to add their API key under `{userName}/weather` with field `api_key`
3. Once they confirm, retry

## Usage
Fetch weather:
run_script: skills/weather/scripts/fetch.sh
args: ["{userName}", "{location}"]
```
