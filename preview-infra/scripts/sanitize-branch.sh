#!/bin/bash
# scripts/sanitize-branch.sh
# SINGLE SOURCE OF TRUTH for branch name sanitization

set -euo pipefail

BRANCH="${1:?Usage: sanitize-branch.sh <branch-name>}"

# 1. Lowercase
# 2. Replace / and _ with -
# 3. Remove non-alphanumeric except -
# 4. Collapse multiple dashes
# 5. Remove leading/trailing dashes
CLEAN=$(echo "$BRANCH" | tr '[:upper:]' '[:lower:]' | \
  sed 's/[\/\_]/-/g' | \
  sed 's/[^a-z0-9-]//g' | \
  sed 's/--*/-/g' | \
  sed 's/^-//;s/-$//')

# 6. If longer than 50 chars, truncate and append hash for uniqueness
if [ ${#CLEAN} -gt 50 ]; then
  HASH=$(echo -n "$BRANCH" | sha1sum | cut -c1-8)
  CLEAN="${CLEAN:0:50}-${HASH}"
fi

# 7. Final trim to 63 chars (DNS label limit)
echo "${CLEAN:0:63}"
