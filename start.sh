#!/usr/bin/env bash
# Parses SCAN_PATH from .env, generates docker-compose.override.yml, then starts the app.
# Usage: ./start.sh [docker-compose args]
# SCAN_PATH format: C://Users//YourName;D://  (semicolon-separated, // as path separator)
set -euo pipefail

if [ ! -f .env ]; then
  echo "Error: .env not found. Copy .env.example to .env and set SCAN_PATH."
  exit 1
fi

SCAN_PATH=$(grep -E '^SCAN_PATH=' .env | head -1 | cut -d= -f2-)

if [ -z "$SCAN_PATH" ]; then
  echo "Error: SCAN_PATH not set in .env"
  echo "Example: SCAN_PATH=C://Users//YourName;D://"
  exit 1
fi

IFS=';' read -ra PATHS <<< "$SCAN_PATH"

VOLUME_LINES="      - \"./data:/app/data\""
SCAN_DIRS=""
PATH_MAP_VAL=""

for i in "${!PATHS[@]}"; do
  raw="${PATHS[$i]}"
  container="/data/scan$i"
  # C://Users//foo → C:\Users\foo  (collapse // then replace / with \)
  win_path=$(echo "$raw" | sed 's|//|/|g; s|/|\\|g')
  VOLUME_LINES+=$'\n'"      - \"${raw}:${container}:ro\""
  SCAN_DIRS+="${container},"
  PATH_MAP_VAL+="${container}=${win_path},"
done

SCAN_DIRS="${SCAN_DIRS%,}"
PATH_MAP_VAL="${PATH_MAP_VAL%,}"

cat > docker-compose.override.yml << EOF
services:
  file-agent:
    volumes:
${VOLUME_LINES}
    environment:
      - SCAN_DIRS=${SCAN_DIRS}
      - PATH_MAP=${PATH_MAP_VAL}
EOF

echo "Generated docker-compose.override.yml"
docker compose up "$@"
