#!/bin/bash
set -euo pipefail

USERNAME="${1:?Usage: search-food.sh <userName> <query>}"
QUERY="${2:?Usage: search-food.sh <userName> <query>}"
ENCODED_QUERY="$(jq -rn --arg q "$QUERY" '$q|@uri')"

URL="https://world.openfoodfacts.org/cgi/search.pl?search_terms=${ENCODED_QUERY}&search_simple=1&action=process&json=1&page_size=8&fields=code,product_name,brands,serving_size,nutriments"
if ! RESPONSE="$(curl -fsSL "$URL" 2>/dev/null)"; then
  echo '{"status":"error","message":"Failed to reach Open Food Facts."}'
  exit 0
fi

if ! printf '%s' "$RESPONSE" | jq -e . >/dev/null 2>&1; then
  echo '{"status":"error","message":"Open Food Facts returned invalid JSON."}'
  exit 0
fi

MATCH_COUNT="$(printf '%s' "$RESPONSE" | jq '[.products[]? | select((.product_name // "") != "") | select((.code // "") != "")] | length')"

if [[ "$MATCH_COUNT" == "0" ]]; then
  echo '{"status":"no_matches"}'
  exit 0
fi

printf '%s' "$RESPONSE" | jq '
  def kcal_from_energy($value):
    if $value == null then null else (($value / 4.184) * 10 | round) / 10 end;

  {
    status: "ok",
    matches: [
      .products[]?
      | select((.product_name // "") != "")
      | select((.code // "") != "")
      | {
          barcode: .code,
          name: .product_name,
          brand: (.brands // null),
          serving_size: (.serving_size // null),
          per_100g: {
            calories_kcal: (.nutriments["energy-kcal_100g"] // kcal_from_energy(.nutriments["energy_100g"])),
            protein_g: (.nutriments["proteins_100g"] // null),
            carbohydrates_g: (.nutriments["carbohydrates_100g"] // null),
            fat_g: (.nutriments["fat_100g"] // null),
            fiber_g: (.nutriments["fiber_100g"] // null)
          }
        }
    ][0:5]
  }
'
