# Skill Template

Use this template when creating new skills. A skill is a directory inside `data/skills/`.

## Directory Structure

```
skill-name/
  SKILL.md              # Required: frontmatter + instructions
  scripts/              # Optional: executable scripts the agent can run
    auth.sh             # e.g., OAuth flow helper
    fetch.sh            # e.g., API call wrapper
  references/           # Optional: extra docs the agent can read for context
    api-docs.md
```

## SKILL.md Frontmatter

```yaml
---
name: Skill Name
description: One-line description of what this skill does and when to use it
per_user: true                    # true if each user needs their own credentials
requires:
  bins: [curl, jq]               # CLI tools that must be installed
  env: [SOME_API_KEY]            # Env vars that must be set (for global keys only)
---
```

### Fields

- **name** (required): Display name
- **description** (required): What the skill does. Be specific - this helps decide when to use it.
- **per_user** (optional): Set to `true` if each user needs their own credentials/tokens.
- **requires.bins** (optional): CLI binaries that must exist on PATH.
- **requires.env** (optional): Environment variables that must be set (use sparingly - prefer per-user credentials).

## SKILL.md Body

Write natural-language instructions for the agent. Include:

1. What this skill does
2. When to activate it
3. Step-by-step workflows using `{baseDir}` for script paths and `{userName}` for the current user
4. What files to read/write and where
5. Error handling guidance
6. Setup instructions - how to walk the user through first-time auth conversationally

## Scripts

- Scripts are run by the agent via Bash tool
- Reference them with `{baseDir}/scripts/script-name.sh`
- Scripts should output JSON or structured text the agent can interpret
- Scripts should return meaningful exit codes
- Keep scripts focused on deterministic tasks (API calls, auth, data fetching)

## Credentials

Skills are global. Credentials are per-user.

Per-user credentials are stored in the macOS Keychain (encrypted), not in plain files.

Use the credential helper in skill instructions:
- **Check**: `scripts/credential.sh has "{userName}" "{skill-name}"`
- **Read**: `scripts/credential.sh get "{userName}" "{skill-name}"` (outputs JSON)
- **Save**: `scripts/credential.sh set "{userName}" "{skill-name}" '{"key":"value"}'`

The skill instructions should:
1. Check if credentials exist with `has`
2. If missing, walk the user through setup via conversation
3. Save with `set` after the user provides them
4. Read with `get` when running API calls

## Example: API Skill with Auth

```yaml
---
name: Weather
description: Get current weather and forecasts for any location
per_user: true
requires:
  bins: [curl, jq]
---

## Weather Skill

### First-Time Setup
Check for credentials: `scripts/credential.sh has "{userName}" "weather"`
If missing, ask the user: "I need a weather API key. Go to weatherapi.com, create a free account, and paste me the API key."
Save with: `scripts/credential.sh set "{userName}" "weather" '{"api_key":"the-key"}'`

### Usage
Read credentials: `CREDS=$(scripts/credential.sh get "{userName}" "weather")`
Then run: `bash {baseDir}/scripts/fetch.sh "$CREDS" "{location}"`
```
