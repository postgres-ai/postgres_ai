#!/bin/bash
# Record demo screencast for README
#
# Prerequisites:
#   brew install asciinema agg
#
# Recording (headless mode):
#   DEMO_DB_URL="postgresql://postgres@host:5432/db" asciinema rec assets/demo.cast -c "scripts/demo.sh"
#
# Convert to GIF:
#   agg --cols 100 --rows 30 --speed 1.5 --font-size 16 assets/demo.cast assets/demo.gif
#
# Tips:
#   - Use --cols/--rows to control terminal size
#   - Use --speed to speed up (1.5x is good)
#   - Keep GIF under 1MB for fast loading

set -e

if [ -z "$DEMO_DB_URL" ]; then
    echo "Error: DEMO_DB_URL is required"
    echo "Usage: DEMO_DB_URL='postgresql://...' $0"
    exit 1
fi

echo "Recording demo..."
asciinema rec assets/demo.cast -c "scripts/demo.sh"

echo "Converting to GIF..."
agg --cols 100 --rows 30 --speed 1.5 --font-size 16 assets/demo.cast assets/demo.gif

echo "Done! Check assets/demo.gif"
ls -lh assets/demo.gif
