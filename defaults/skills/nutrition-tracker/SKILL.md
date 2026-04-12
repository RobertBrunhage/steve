---
name: Nutrition Tracker
description: Track daily food intake with itemized nutrition logs, barcode lookup, and Open Food Facts search. Use when the user mentions food, meals, calories, macros, protein, barcodes, or wants to log what they ate.
per_user: true
requires:
  bins: [curl, jq, zbarimg]
---

## Nutrition Tracker

Use this skill when the user wants to log food, scan a barcode, track calories/macros, or maintain a daily nutrition file.

## Shared Profile

Always read these first:
- `memory/profile.md`
- `skills/nutrition-tracker/templates/nutrition-log.md`
- today's nutrition log if it already exists: `memory/nutrition/YYYY-MM-DD.md`

If nutrition-relevant fields are missing from the shared profile, ask only for the missing fields you need and update the relevant sections in place. Do not rewrite unrelated sections.

Default nutrition logging preference:
- Keep **one nutrition file per day**.
- The file should contain the full day's food log, not only final totals.

## Daily file location

- Active logs: `memory/nutrition/YYYY-MM-DD.md`
- Archived old-format logs: `memory/nutrition-archive/`

## Daily log format

Follow the template exactly when creating a new daily file.

Each daily file should include:
- Meal categories for the day (`Breakfast`, `Lunch`, `Dinner`, `Snacks / Drinks`)
- Itemized entries for foods eaten under the right meal category
- Quantity for each item
- Barcode when available
- Source for each item (database match, manual label/photo, estimate, etc.)
- Confidence for each item (`high`, `medium`, or `low`)
- Nutrition per item when available

## Text food logging workflow

When the user sends food in text:

1. Parse the message into foods and quantities.
2. If it is a packaged or branded product, use one of the lookup scripts.
3. If the match is unclear, ask a short clarification question instead of guessing.
4. Decide the meal category: `Breakfast`, `Lunch`, `Dinner`, or `Snacks / Drinks`.
5. If the meal category is unclear, ask a short question instead of assuming.
6. If it is a generic or homemade food and no reliable DB match exists, use a clearly labeled manual estimate only if the user provides enough detail.
7. Update today's nutrition log.
8. When totals are needed, run the totals script rather than maintaining a separate totals block manually.
9. Reply with a short confirmation, updated totals, and whether the entry came from a database match, a manual label/photo, or an estimate.

## Barcode workflow

If the user sends a barcode number:
- Run `/data/skills/nutrition-tracker/scripts/lookup-barcode.sh` with args: `["{userName}", "{barcode}"]`

If the user sends a barcode image:
- Use the attached image path from the message context. Attached photos are available in the workspace at `/data/tmp/...`.
- Run `/data/skills/nutrition-tracker/scripts/scan-barcode-image.sh` with args: `["{userName}", "{imagePath}"]`
- If it returns one barcode, run the barcode lookup script with that barcode.
- If it returns multiple barcodes, ask the user which item they meant.
- If no barcode is found, ask for a clearer image or the typed digits.

## Text search workflow

If the user sends a branded product name without a barcode:
- Run `/data/skills/nutrition-tracker/scripts/search-food.sh` with args: `["{userName}", "{query}"]`
- Use the best match only if it is clearly correct.
- If several plausible matches appear, ask the user to choose.

## Source + confidence rules

Every logged item should clearly state both:
- **Source**: `database`, `label/photo`, or `estimate`
- **Confidence**: `high`, `medium`, or `low`

If a barcode is known, include it in the entry as:
- **Barcode**: `digits`

Every logged item should also belong to one meal category:
- `Breakfast`
- `Lunch`
- `Dinner`
- `Snacks / Drinks`

Meal category is the main ordering system.

Use this rule set:

- **High confidence**
  - Barcode match clearly matches the product, or
  - DB match is clearly confirmed by the package photo/name/nutrition, or
  - The package label itself gives the nutrition clearly
  - Action: log it directly and say what source was used

- **Medium confidence**
  - Product/name likely matches but not perfectly, or
  - Some nutrition fields are missing and one source had to fill the gaps
  - Action: log it, say it was cross-checked, and mention the uncertainty briefly

- **Low confidence**
  - Product identity is unclear, or
  - Serving size/quantity is too uncertain, or
  - Nutrition would mostly be a guess
  - Action: ask a short clarification question before logging

Never present an estimate as if it were a confirmed database value.

## Important logging rules

- Read calorie/protein targets from `memory/profile.md` rather than duplicating them in each daily nutrition log.
- Do not store goal, leftover, or app-budget numbers.
- Store the foods actually eaten and enough numeric nutrition data to derive accurate totals.
- Keep calories/macros numeric and easy to scan.
- If a value is estimated, mark it as `estimate` in the item source.
- If quantity is missing, ask before logging when the difference would materially affect totals.
- Keep user-facing replies transparent about whether the number was looked up, read from the label, or estimated.
- If the meal category is unclear, ask where it belongs before logging.
- If a barcode is available from the package or database match, store it in the entry instead of only in notes.
- Do not keep a separate `Notes` section by default; put important clarifications inside the relevant entry only.

## Coaching behavior

- Compare the day's running totals against the user's targets in `memory/profile.md`.
- Keep replies concise.
- Call out protein shortfalls plainly.
- Do not overreact to a single meal; focus on the day.

## Scripts

Use the MCP `run_script` tool only.

### Barcode lookup
- Script: `/data/skills/nutrition-tracker/scripts/lookup-barcode.sh`
- Args: `["{userName}", "{barcode}"]`

Returns JSON with either:
- `status: "ok"` and product nutrition data
- `status: "not_found"`
- `status: "error"`

### Barcode image scan
- Script: `/data/skills/nutrition-tracker/scripts/scan-barcode-image.sh`
- Args: `["{userName}", "{imagePath}"]`

Returns JSON with either:
- `status: "ok"` and one barcode
- `status: "multiple_matches"`
- `status: "not_found"`
- `status: "error"`

### Product search
- Script: `/data/skills/nutrition-tracker/scripts/search-food.sh`
- Args: `["{userName}", "{query}"]`

Returns JSON with either:
- `status: "ok"` and candidate matches
- `status: "no_matches"`
- `status: "error"`

### Daily totals
- Script: `/data/skills/nutrition-tracker/scripts/calculate-totals.sh`
- Args: `["{userName}", "YYYY-MM-DD"]`

Returns JSON with totals derived from the daily nutrition log entries.

## Error handling

- If Open Food Facts has no good match, say so plainly.
- If nutrition data is incomplete, tell the user what is missing.
- If the barcode image is unreadable, ask for a clearer shot.
- If a food cannot be confidently identified, do not guess.
