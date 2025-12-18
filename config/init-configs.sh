#!/bin/sh
set -e

# PostgresAI Monitoring Config Initializer
# Copies configuration files to mounted volumes

echo "PostgresAI configs v$(cat /VERSION)"
echo "Build: $(cat /BUILD_TS)"
echo ""

# Default target is /target, can be overridden
TARGET_DIR="${TARGET_DIR:-/target}"

if [ ! -d "$TARGET_DIR" ]; then
  echo "Error: Target directory $TARGET_DIR does not exist"
  exit 1
fi

echo "Copying configs to $TARGET_DIR..."

# Copy all configs preserving structure
cp -r /configs/* "$TARGET_DIR/"

echo "Done. Copied:"
find "$TARGET_DIR" -type f | wc -l | xargs echo "  - files:"
find "$TARGET_DIR" -type d | wc -l | xargs echo "  - directories:"

echo ""
echo "Config initialization complete."

