# Skill Template

Use this template when creating new skills. A skill is a directory inside the current user's `skills/` folder.

## Directory Structure

```
skill-name/
  SKILL.md              # Required: frontmatter + instructions
  scripts/              # Optional: executable scripts the agent can run
    auth.sh             # e.g., OAuth flow helper (see OAUTH_TEMPLATE.md)
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
scripts:
  fetch.sh:
    secrets:
      - key: users/{user}/weather/app
        fields: [api_key]
---
```

### Fields

- **name** (required): Display name
- **description** (required): What the skill does. Be specific, this helps decide when to use it.
- **per_user** (optional): Set to `true` if each user needs their own credentials/tokens.
- **requires.bins** (optional): CLI binaries that must exist on PATH.
- **scripts** (optional): Per-script secret injection and output handling rules.
- **scripts.<name>.redactOutput** (optional): Defaults to redacting injected secrets from script output. Set `redactOutput: false` only when a script must intentionally return a user-facing auth URL or similar derived value.

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

## Script Manifest In Frontmatter

Use the `scripts` frontmatter block in `SKILL.md` to declare exactly which vault entries a script needs. Steve injects only the declared fields, which keeps secrets scoped tightly and improves output redaction.

Example:

```yaml
scripts:
  fetch.sh:
    secrets:
      - key: users/{user}/weather/app
        fields: [api_key]
  refresh.sh:
    redactOutput: false
    secrets:
      - key: users/{user}/weather/app
        fields: [client_id, client_secret]
      - key: users/{user}/weather/tokens
        fields: [refresh_token]
```

### Rules

- Use `{user}` or `{userName}` in vault keys and Steve substitutes the current user slug.
- If `fields` is omitted, all fields in that vault entry are injected.
- Keep manifests narrow. Only request the secrets a script actually needs.
- Keep the machine-readable manifest in the same `SKILL.md` file as the instructions.
- Output is redacted by default. Only disable redaction for a specific script when the output itself needs to contain a user-facing auth URL or other intentional secret-derived value.

## Templates

If your skill creates user files (logs, profiles, etc.), add templates in a `templates/` directory. The agent reads these before creating files to ensure consistent formatting across users.

## Credentials

Skills and credentials are per-user by default.

Per-user credentials are stored in the encrypted vault and managed from each user's page in the web UI. When a script runs via `run_script`, Steve injects only the environment variables declared in `SKILL.md` frontmatter.

The app secret key format is `users/{userName}/{skill-name}/app` with a JSON object value. Each field becomes `STEVE_CRED_{FIELD_NAME_UPPERCASED}`.

Example: vault key `users/robert/weather/app` with value `{"api_key": "abc123"}` becomes `STEVE_CRED_API_KEY=abc123` in the script's environment.

### Setup flow

When credentials are missing:
1. Call `get_secret_url` with the current `userName` to get the user's integrations page
2. Tell the user to open it and add their credentials on their user page under the `{skill-name}` integration
3. Once confirmed, run the skill's scripts normally (credentials are injected automatically)

### In scripts

```bash
# Credentials are available as env vars - no need to fetch them
API_KEY="${STEVE_CRED_API_KEY:?Missing STEVE_CRED_API_KEY}"
```

### Saving credentials from scripts

If your script produces credentials that need to be stored (e.g., OAuth tokens), include a `save_to_vault` field in the JSON output:

```json
{"status": "ready", "save_to_vault": {"key": "users/{userName}/skill-name/tokens", "value": {"token": "..."}}}
```

Steve saves it to the vault automatically and **strips it before the AI sees the output**. The AI only receives `{"status": "ready"}`. NEVER output raw credentials in any other field.

## OAuth Integrations

If your skill needs browser authorization, redirects, callback polling, or token exchange, keep this file as the base template and also read `skills/OAUTH_TEMPLATE.md` before implementing the setup flow.

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
1. Call `get_secret_url` with the current `userName` to get the user's integrations page
2. Tell the user to add their API key under the Weather integration on their user page
3. Once they confirm, retry

## Usage
Fetch weather:
run_script: skills/weather/scripts/fetch.sh
args: ["{userName}", "{location}"]
```
