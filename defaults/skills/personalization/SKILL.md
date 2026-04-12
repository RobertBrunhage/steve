---
name: Personalization
description: Manage the user's shared profile, onboarding details, goals, targets, and communication preferences. Use when the user wants to set up or update their profile, goals, preferences, or personal defaults.
per_user: true
---

## Personalization

This skill owns the shared `memory/profile.md` file.

Use it when the user wants to:
- set up their profile
- update personal details
- change goals or target dates
- change calorie or protein targets
- update communication preferences
- define how Kellix should track their data

Always read these first:
- `memory/profile.md` if it exists
- `skills/personalization/templates/profile.md`

## Purpose

`memory/profile.md` is the shared source of truth for Kellix's understanding of the user.

Keep it focused on stable information:
- personal details
- goals and target dates
- training defaults
- nutrition targets
- tracking preferences
- communication preferences

Do not log daily events here.

## Onboarding

If the profile is missing or mostly blank, fill it in gradually.

Do not interrogate the user with a giant questionnaire unless they explicitly ask for a full setup. Ask only for the missing fields needed to move forward.

Prioritize these fields first:
- Name
- Goal
- Training setup
- Nutrition targets
- Communication preferences

## Updating The Profile

- Preserve the existing template structure.
- Update only the sections relevant to the current conversation.
- Do not remove unrelated information.
- Keep the profile easy to scan.
- If a preference changes, overwrite the old value clearly instead of keeping both.

## Communication Preferences

The `## Preferences` section affects how Kellix talks.

Capture things like:
- concise vs detailed replies
- emoji preference
- supportive vs direct tone
- anything else the user explicitly wants Kellix to remember about how to communicate

## File Template

When creating or rebuilding `memory/profile.md`, ALWAYS read `skills/personalization/templates/profile.md` first and follow its structure.

## File Ownership

- `memory/profile.md` - Shared user profile and preferences

Other skills may read `memory/profile.md` and update the fields relevant to their domain, but this skill owns the overall structure.
