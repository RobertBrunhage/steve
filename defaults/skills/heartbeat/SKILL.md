---
name: Heartbeat
description: Periodic background check that runs a checklist silently. Only messages the user if something needs attention.
per_user: true
---

## How It Works

The heartbeat fires periodically during active hours. When it fires, you receive a `HEARTBEAT:` prefixed message. Read the user's `HEARTBEAT.md` file and go through each item on the checklist.

For each item:
- Check if it needs attention (read relevant files, check dates, etc.)
- If something needs action, message the user about it
- If nothing needs attention, do NOT message the user at all

If no items need attention, respond with exactly `HEARTBEAT_OK` via `send_message`. This signals that the heartbeat completed with nothing to report. The system will suppress this message.

## HEARTBEAT.md Format

The user's `HEARTBEAT.md` is a simple checklist:

```markdown
- Check if any training is scheduled today and hasn't been logged
- Check if nutrition hasn't been logged by 8pm
- Check Withings for new measurements
```

Each line is a task to evaluate. Use your judgment and the user's data to determine if action is needed.

## Key Rules

- Do NOT send "all clear" or "nothing to report" messages. Silence means everything is fine.
- Only message the user when something genuinely needs their attention.
- Keep messages short and actionable.
- The heartbeat should feel invisible when things are on track.
