#!/bin/bash
set -euo pipefail

USERNAME="${1:?Usage: calculate-totals.sh <userName> <date>}"
DATE="${2:?Usage: calculate-totals.sh <userName> <date>}"

if [[ -f "/data/memory/nutrition/${DATE}.md" ]]; then
  FILE="/data/memory/nutrition/${DATE}.md"
elif [[ -f "memory/nutrition/${DATE}.md" ]]; then
  FILE="memory/nutrition/${DATE}.md"
else
  echo '{"status":"error","message":"Nutrition log not found."}'
  exit 0
fi

jq -Rn --rawfile file "$FILE" '
  def has_nutrition:
    (.calories != null) or (.protein != null) or (.carbohydrates != null) or (.fat != null) or (.fiber != null);

  def finalize_current:
    if .current == null then .
    elif (.current | has_nutrition) then
      .entries += [.current] | .current = null
    else
      .current = null
    end;

  def to_num:
    if . == null then null
    else
      gsub("[[:space:]]"; "")
      | if . == "unknown" or . == "" then null else sub("g$";"") | tonumber? end
    end;

  def parse_entries:
    ($file | split("\n")) as $lines
    | reduce $lines[] as $line (
        {entries: [], current: null};
        if ($line | startswith("### ")) then
          (finalize_current | .current = {})
        elif ($line | startswith("- Calories: ")) then
          .current.calories = ($line | sub("^- Calories: "; "") | tonumber?)
        elif ($line | startswith("- Protein: ")) then
          .current.protein = ($line | sub("^- Protein: "; "") | to_num)
        elif ($line | startswith("- Carbohydrates: ")) then
          .current.carbohydrates = ($line | sub("^- Carbohydrates: "; "") | to_num)
        elif ($line | startswith("- Fat: ")) then
          .current.fat = ($line | sub("^- Fat: "; "") | to_num)
        elif ($line | startswith("- Fiber: ")) then
          (.current.fiber = ($line | sub("^- Fiber: "; "") | to_num))
          | (.entries += [.current])
        else
          .
        end
      )
    | finalize_current
    | .entries;

  (parse_entries) as $entries
  | {
      status: "ok",
      date: $DATE,
      entry_count: ($entries | length),
      totals: {
        calories: ($entries | map(.calories // 0) | add),
        protein_g: ($entries | map(.protein // 0) | add),
        carbohydrates_g: ($entries | map(.carbohydrates // 0) | add),
        fat_g: ($entries | map(.fat // 0) | add),
        fiber_g: (if ($entries | any(.fiber == null)) then null else ($entries | map(.fiber // 0) | add) end)
      }
    }
'
