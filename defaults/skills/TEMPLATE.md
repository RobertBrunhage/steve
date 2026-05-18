# Skill Template

Use this template when creating new skills. A skill is a directory inside the current agent's `skills/` folder.

Kellix follows the **Agent Skills** spec from [agentskills.io](https://agentskills.io/specification). All Kellix-specific fields live under `metadata.kellix.*` so skills stay portable across other Agent-Skills clients.

## Directory Structure

```
skill-name/
  SKILL.md              # Required: spec frontmatter + instructions
  scripts/              # Optional: executable scripts the agent can run
    auth.sh             # e.g., OAuth flow helper (see OAUTH_TEMPLATE.md)
    fetch.sh            # e.g., API call wrapper
  assets/               # Optional: file templates, images, schemas
    profile.md          # e.g., a template the agent copies into user files
  references/           # Optional: long reference docs loaded on demand
```

## SKILL.md Frontmatter

```yaml
---
name: skill-name
description: One-line description of what this skill does and when to use it
compatibility: Requires curl and jq    # optional, freeform
metadata:
  kellix:
    per_user: true                     # true if each user needs their own credentials
    scripts:
      fetch.sh:
        secrets:
          - key: users/{user}/weather/app
            fields: [api_key]
---
```

### Fields

Spec fields (portable across all Agent Skills clients):

- **name** (required): lowercase letters, numbers, and hyphens only. Max 64 chars. Must NOT start/end with a hyphen, must NOT contain `--`, and **must match the parent directory name**.
- **description** (required): up to 1024 chars. Be specific about *what* and *when*.
- **compatibility** (optional): freeform string describing environment requirements (e.g. `Requires curl and jq`).
- **license** (optional): license name or filename.
- **metadata** (optional): arbitrary key-value map for client-specific extensions.

Kellix-specific extensions live under `metadata.kellix.*`:

- **metadata.kellix.per_user** (optional): `true` if each user needs their own credentials/tokens.
- **metadata.kellix.scripts** (optional): per-script secret injection and output handling rules.
- **metadata.kellix.scripts.\<name\>.redactOutput** (optional): defaults to redacting injected secrets from script output. Set `redactOutput: false` only when a script must intentionally return a user-facing auth URL or similar derived value.

## SKILL.md Body

Write natural-language instructions for the agent. Include:

1. What this skill does
2. When to activate it
3. Step-by-step workflows using `run_script` for script execution and `{userName}` for the current user
4. What files to read/write and where
5. Error handling guidance
6. Setup instructions for walking the user through first-time auth

Keep SKILL.md under 500 lines. Move long reference material into `references/<topic>.md` and link to it — agents load reference files on demand.

## Scripts

- Scripts are run by the agent via the `run_script` MCP tool.
- Reference them as: `skills/{skill-name}/scripts/script-name.sh`.
- The first argument is always the userName.
- Scripts should output JSON or structured text the agent can interpret.
- Scripts should return meaningful exit codes.
- Keep scripts focused on deterministic tasks (API calls, auth, data fetching).

## Script Manifest In Frontmatter

Use the `metadata.kellix.scripts` block in `SKILL.md` to declare exactly which vault entries a script needs. Kellix injects only the declared fields, which keeps secrets scoped tightly and improves output redaction.

Example:

```yaml
metadata:
  kellix:
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

- Use `{user}` or `{userName}` in vault keys and Kellix substitutes the current user slug.
- If `fields` is omitted, all fields in that vault entry are injected.
- Keep manifests narrow. Only request the secrets a script actually needs.
- Keep the machine-readable manifest in the same `SKILL.md` file as the instructions.
- Output is redacted by default. Only disable redaction for a specific script when the output itself needs to contain a user-facing auth URL or other intentional secret-derived value.

## Assets

If your skill creates user files (logs, profiles, etc.), put templates in `assets/`. The agent reads these before creating files to ensure consistent formatting.

## Credentials

Skills and credentials are per-user by default.

Per-user credentials are stored in the encrypted vault and managed from each user's page in the web UI. When a script runs via `run_script`, Kellix injects only the environment variables declared under `metadata.kellix.scripts.<name>.secrets` in `SKILL.md`.

The app secret key format is `users/{userName}/{skill-name}/app` with a JSON object value. Each field becomes `KELLIX_CRED_{FIELD_NAME_UPPERCASED}`.

Example: vault key `users/robert/weather/app` with value `{"api_key": "abc123"}` becomes `KELLIX_CRED_API_KEY=abc123` in the script's environment.

### Slug consistency — CRITICAL

The skill folder name, the manifest vault key, and the `integration` argument to `get_secret_url` are the SAME slug. Pick one and reuse it exactly. Do NOT list multiple speculative slugs in your manifest hoping one matches — they won't, because the user will pick the slug you tell them to use.

For a skill called `weather`:
- folder: `skills/weather/`
- manifest: `key: users/{user}/weather/app`
- call: `get_secret_url(userName=<user>, integration=weather)`
- vault entry the user creates: `users/<user>/weather/app` with the fields declared in your manifest

### Setup flow

When credentials are missing:
1. Create the skill folder, `SKILL.md` (with `metadata.kellix.scripts.<name>.secrets` declaring `key` and exact `fields`), and the script — BEFORE asking the user.
2. Call `get_secret_url` with the current `userName` AND the matching `integration` slug. The user lands on a pre-filled form.
3. Tell the user the exact field name(s) to use (matching your `fields` list). Don't make them guess.
4. Once they confirm saved, retry the script. Credentials are injected automatically as env vars.

### In scripts

```bash
# Credentials are available as env vars - no need to fetch them
API_KEY="${KELLIX_CRED_API_KEY:?Missing KELLIX_CRED_API_KEY}"
```

### Saving credentials from scripts

If your script produces credentials that need to be stored (e.g., OAuth tokens), include a `save_to_vault` field in the JSON output:

```json
{"status": "ready", "save_to_vault": {"key": "users/{userName}/skill-name/tokens", "value": {"token": "..."}}}
```

Kellix saves it to the vault automatically and **strips it before the AI sees the output**. The AI only receives `{"status": "ready"}`. NEVER output raw credentials in any other field.

## OAuth Integrations

If your skill needs browser authorization, redirects, callback polling, or token exchange, keep this file as the base template and also read `skills/OAUTH_TEMPLATE.md` before implementing the setup flow.

## Example: API Skill with Auth

```yaml
---
name: weather
description: Get current weather and forecasts for any location. Use when the user asks about temperature, conditions, or forecasts.
compatibility: Requires curl and jq
metadata:
  kellix:
    per_user: true
---

## Setup
If the fetch script fails with "Missing KELLIX_CRED":
1. Call `get_secret_url` with the current `userName` to get the user's integrations page
2. Tell the user to add their API key under the Weather integration on their user page
3. Once they confirm, retry

## Usage
Fetch weather:
run_script: skills/weather/scripts/fetch.sh
args: ["{userName}", "{location}"]
```
