#!/bin/bash
set -euo pipefail

USERNAME="${1:?Usage: lookup-barcode.sh <userName> <barcode>}"
BARCODE_RAW="${2:?Usage: lookup-barcode.sh <userName> <barcode>}"
BARCODE="$(printf '%s' "$BARCODE_RAW" | tr -cd '0-9')"

if [[ -z "$BARCODE" ]]; then
  echo '{"status":"error","message":"Barcode must contain digits."}'
  exit 0
fi

URL="https://world.openfoodfacts.org/api/v2/product/${BARCODE}.json?fields=code,product_name,brands,serving_size,nutriments"
if ! RESPONSE="$(curl -fsSL "$URL" 2>/dev/null)"; then
  echo '{"status":"error","message":"Failed to reach Open Food Facts."}'
  exit 0
fi

if ! printf '%s' "$RESPONSE" | jq -e . >/dev/null 2>&1; then
  echo '{"status":"error","message":"Open Food Facts returned invalid JSON."}'
  exit 0
fi

STATUS_CODE="$(printf '%s' "$RESPONSE" | jq -r '.status // empty')"

if [[ "$STATUS_CODE" != "1" ]]; then
  echo "{\"status\":\"not_found\",\"barcode\":\"${BARCODE}\"}"
  exit 0
fi

printf '%s' "$RESPONSE" | jq --arg barcode "$BARCODE" '
  def kcal_from_energy($value):
    if $value == null then null else (($value / 4.184) * 10 | round) / 10 end;

  .product as $p
  | {
      status: "ok",
      barcode: ($p.code // $barcode),
      name: ($p.product_name // "Unknown product"),
      brand: ($p.brands // null),
      serving_size: ($p.serving_size // null),
      per_100g: {
        calories_kcal: ($p.nutriments["energy-kcal_100g"] // kcal_from_energy($p.nutriments["energy_100g"])),
        protein_g: ($p.nutriments["proteins_100g"] // null),
        carbohydrates_g: ($p.nutriments["carbohydrates_100g"] // null),
        fat_g: ($p.nutriments["fat_100g"] // null),
        fiber_g: ($p.nutriments["fiber_100g"] // null)
      },
      per_serving: {
        calories_kcal: ($p.nutriments["energy-kcal_serving"] // kcal_from_energy($p.nutriments["energy_serving"])),
        protein_g: ($p.nutriments["proteins_serving"] // null),
        carbohydrates_g: ($p.nutriments["carbohydrates_serving"] // null),
        fat_g: ($p.nutriments["fat_serving"] // null),
        fiber_g: ($p.nutriments["fiber_serving"] // null)
      }
    }
'
