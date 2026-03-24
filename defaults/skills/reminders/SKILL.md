---
name: Reminders
description: Create scheduled and one-off reminders that send messages to the user on Telegram
per_user: true
---

## Reminders & Scheduled Messages

You can create reminders that automatically trigger and send messages to the user on Telegram.

### Creating a Reminder

Write a markdown file to the user's reminders directory: `memory/{userName}/reminders/`

Use **cron** for recurring reminders:

```
---
name: Morning workout reminder
cron: "0 7 * * *"
prompt: "Check my training schedule and tell me what workout I should do today. Be motivating."
---
```

Use **at** for one-off reminders (auto-deleted after firing):

```
---
name: Check laundry
at: "2026-03-24T15:30:00"
prompt: "Remind me to check the laundry."
---
```

### Frontmatter Fields

- **name**: Human-readable name
- **cron**: Standard cron expression for recurring reminders (minute hour day-of-month month day-of-week)
- **at**: ISO datetime string for one-off reminders (YYYY-MM-DDTHH:mm:ss)
- **prompt**: What you (Steve) should think about when the reminder fires. You'll go through your normal flow (read files, check context) and send the result.

Use either `cron` OR `at`, not both.

### Cron Examples

- `0 7 * * *` - every day at 7:00 AM
- `0 7 * * 1-5` - weekdays at 7:00 AM
- `0 20 * * 0` - Sundays at 8:00 PM
- `0 9 * * 1` - Mondays at 9:00 AM
- `0 8,20 * * *` - twice daily at 8 AM and 8 PM

### One-Off: Converting Relative Times

When the user says relative times, convert to absolute ISO datetime:
- "in 1 hour" -> current time + 1 hour
- "in 30 minutes" -> current time + 30 minutes
- "tomorrow at 9am" -> next day at 09:00:00
- "tonight at 8" -> today at 20:00:00

### How It Works

- The scheduler checks for new/changed/deleted reminders every 30 seconds.
- When a reminder fires, the prompt goes through the full AI flow - you can read schedule, logs, memories, etc.
- One-off reminders (`at`) are automatically deleted after firing.
- Recurring reminders (`cron`) keep firing on schedule until the file is deleted.
- To delete a reminder, delete the file.
- To list reminders, read the user's reminders directory.
- Use descriptive filenames like `morning-workout.md`, `check-laundry.md`.
