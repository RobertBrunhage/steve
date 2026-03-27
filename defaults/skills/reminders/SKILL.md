---
name: Reminders
description: Create scheduled and one-off reminders that send messages to the user on Telegram
per_user: true
---

## Reminders & Scheduled Messages

Use the `manage_jobs` tool to create, list, and delete reminders.

IMPORTANT:
- Always `list` jobs BEFORE adding to see what already exists
- Adding a job with the same `id` replaces the existing one (no duplicates)
- Only create what the user asked for. Do NOT create extra reminders.

### Creating a Recurring Reminder

```
manage_jobs action: "add", userName: "{userName}", job: {
  id: "{userName}-workout-1pm",
  name: "1pm Workout Reminder",
  cron: "0 13 * * 1,2,4,5",
  timezone: "Europe/Stockholm",
  prompt: "Check training schedule and tell me what workout is today."
}
```

### Creating a One-Off Reminder

```
manage_jobs action: "add", userName: "{userName}", job: {
  id: "{userName}-check-laundry",
  name: "Check laundry",
  at: "2026-03-24T15:30:00+01:00",
  prompt: "Remind me to check the laundry."
}
```

One-off reminders are automatically deleted after firing.

### Job Fields

- **id**: Unique identifier (use `{userName}-{descriptive-slug}`)
- **name**: Human-readable name
- **cron**: Cron expression (minute hour day-of-month month day-of-week). Always include `timezone`.
- **at**: ISO 8601 datetime with timezone offset (e.g., `2026-03-24T15:30:00+01:00`). Use `session_status` tool to get the current time and timezone. ALWAYS include the offset.
- **prompt**: What to think about when the reminder fires
- **timezone**: IANA timezone for cron jobs (e.g., `Europe/Stockholm`). Required for cron. Not needed for `at` (use offset in the datetime instead).

Use either `cron` OR `at`, not both.

### One-Off: Converting Relative Times

Use the `session_status` tool to get the current time, then calculate the target time. Always include the timezone offset in the result.

### Managing Reminders

- **List**: `manage_jobs action: "list", userName: "{userName}"`
- **Delete**: `manage_jobs action: "remove", id: "{job-id}"`
- The scheduler picks up changes within 30 seconds
- Reminders fire in isolated sessions (don't pollute the user's conversation)
