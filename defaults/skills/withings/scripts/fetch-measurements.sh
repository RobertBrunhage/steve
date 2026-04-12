#!/bin/bash
# Fetch body measurements from Withings API
# Usage: fetch-measurements.sh <userName> [startDate]
# If startDate (YYYY-MM-DD) is provided, returns all daily weight/body comp entries from that date onward.
# Otherwise returns the latest measurement group only.
# Credentials injected as KELLIX_CRED_* env vars by the MCP run_script tool
set -euo pipefail

USERNAME="${1:?Usage: fetch-measurements.sh <userName> [startDate]}"
START_DATE="${2:-}"

ACCESS_TOKEN="${KELLIX_CRED_ACCESS_TOKEN:?Missing KELLIX_CRED_ACCESS_TOKEN}"
EXPIRES_AT="${KELLIX_CRED_EXPIRES_AT:-0}"
NOW=$(date +%s)

# Check token expiry (with 5 min buffer)
if [[ $(( EXPIRES_AT - NOW )) -lt 300 ]]; then
  echo '{"error":"token_expired"}'
  exit 0
fi

# Fetch measurements from last 30 days
# meastype: 1=weight, 6=fat%, 8=fat mass, 76=muscle mass, 77=hydration, 88=bone mass
LASTUPDATE=$(( NOW - 2592000 ))  # 30 days ago

RESPONSE=$(curl -s -X GET "https://wbsapi.withings.net/measure" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -G \
  --data-urlencode "action=getmeas" \
  --data-urlencode "category=1" \
  --data-urlencode "lastupdate=${LASTUPDATE}")

STATUS=$(echo "$RESPONSE" | jq -r '.status')
if [[ "$STATUS" == "401" ]]; then
  echo '{"error":"token_expired"}'
  exit 0
fi

if [[ "$STATUS" != "0" ]]; then
  echo '{"error":"api_error","status":'$STATUS',"message":'$(echo "$RESPONSE" | jq -r '.error // "Unknown error"' | jq -R '.')'}'
  exit 1
fi

MEASUREGRPS=$(echo "$RESPONSE" | jq '.body.measuregrps')
GRPCOUNT=$(echo "$MEASUREGRPS" | jq 'length')

if [[ "$GRPCOUNT" == "0" ]]; then
  echo '{"error":"no_measurements"}'
  exit 0
fi

if [[ -n "$START_DATE" ]]; then
  START_TS=$(date -d "$START_DATE 00:00:00" +%s)
  echo "$MEASUREGRPS" | jq --argjson start_ts "$START_TS" '
    sort_by(.date)
    | map(select(.date >= $start_ts))
    | map(
        {
          date: (.date | todate | split("T")[0])
        }
        + (reduce .measures[] as $m ({};
                . + if $m.type == 1 then
                  {weight_kg: ((($m.value * pow(10; $m.unit)) * 100 | round) / 100)}
                elif $m.type == 6 then
                  {fat_ratio: ((($m.value * pow(10; $m.unit)) * 100 | round) / 100)}
                elif $m.type == 8 then
                  {fat_mass_kg: ((($m.value * pow(10; $m.unit)) * 100 | round) / 100)}
                elif $m.type == 76 then
                  {muscle_mass_kg: ((($m.value * pow(10; $m.unit)) * 100 | round) / 100)}
                elif $m.type == 77 then
                  {water_kg: ((($m.value * pow(10; $m.unit)) * 100 | round) / 100)}
                elif $m.type == 88 then
                  {bone_mass_kg: ((($m.value * pow(10; $m.unit)) * 100 | round) / 100)}
                else
                  {}
                end))
      )
  '
  exit 0
fi

# Get the most recent measurement group
LATEST=$(echo "$MEASUREGRPS" | jq 'sort_by(.date) | last')
DATE=$(echo "$LATEST" | jq -r '.date | todate | split("T")[0]')

# Parse each measure type from the group
# Values are stored as: value * 10^unit (e.g., value=825, unit=-1 => 82.5 kg)
parse_measure() {
  local meastype=$1
  echo "$LATEST" | jq -r --argjson t "$meastype" \
    '.measures[] | select(.type == $t) | (.value * pow(10; .unit)) | . * 100 | round | . / 100' \
    2>/dev/null | head -1
}

WEIGHT=$(parse_measure 1)
FAT_RATIO=$(parse_measure 6)
FAT_MASS=$(parse_measure 8)
MUSCLE=$(parse_measure 76)
WATER=$(parse_measure 77)
BONE=$(parse_measure 88)

# Build output JSON with only fields that have values
OUTPUT="{\"date\":\"${DATE}\""
[[ -n "$WEIGHT" ]]    && OUTPUT+=",\"weight_kg\":${WEIGHT}"
[[ -n "$FAT_RATIO" ]] && OUTPUT+=",\"fat_ratio\":${FAT_RATIO}"
[[ -n "$FAT_MASS" ]]  && OUTPUT+=",\"fat_mass_kg\":${FAT_MASS}"
[[ -n "$MUSCLE" ]]    && OUTPUT+=",\"muscle_mass_kg\":${MUSCLE}"
[[ -n "$WATER" ]]     && OUTPUT+=",\"water_kg\":${WATER}"
[[ -n "$BONE" ]]      && OUTPUT+=",\"bone_mass_kg\":${BONE}"
OUTPUT+="}"

echo "$OUTPUT"
