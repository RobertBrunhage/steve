#!/bin/bash
set -euo pipefail

USERNAME="${1:?Usage: scan-barcode-image.sh <userName> <imagePath>}"
IMAGE_INPUT="${2:?Usage: scan-barcode-image.sh <userName> <imagePath>}"
IMAGE_PATH="${IMAGE_INPUT#file://}"

if [[ "$IMAGE_PATH" == tmp/* ]]; then
  IMAGE_PATH="/data/${IMAGE_PATH}"
fi

if [[ ! -f "$IMAGE_PATH" ]]; then
  echo '{"status":"error","message":"Image file not found."}'
  exit 0
fi

if ! command -v zbarimg >/dev/null 2>&1; then
  echo '{"status":"error","message":"Barcode scanner dependency is not installed."}'
  exit 0
fi

RAW_OUTPUT="$(zbarimg --quiet --raw --nodisplay "$IMAGE_PATH" 2>/dev/null || true)"

declare -A SEEN=()
BARCODES=()
while IFS= read -r line; do
  cleaned="$(printf '%s' "$line" | tr -cd '0-9')"
  if [[ -z "$cleaned" ]]; then
    continue
  fi
  if [[ -z "${SEEN[$cleaned]:-}" ]]; then
    SEEN[$cleaned]=1
    BARCODES+=("$cleaned")
  fi
done <<< "$RAW_OUTPUT"

if [[ ${#BARCODES[@]} -eq 0 ]]; then
  echo '{"status":"not_found"}'
  exit 0
fi

if [[ ${#BARCODES[@]} -eq 1 ]]; then
  printf '{"status":"ok","barcode":"%s"}\n' "${BARCODES[0]}"
  exit 0
fi

printf '{"status":"multiple_matches","barcodes":['
for i in "${!BARCODES[@]}"; do
  if [[ "$i" -gt 0 ]]; then
    printf ','
  fi
  printf '"%s"' "${BARCODES[$i]}"
done
printf ']}\n'
