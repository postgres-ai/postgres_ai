#!/bin/bash

# Demo: postgresai full workflow
# Requires DEMO_DB_URL env var

type_it() {
    for ((i=0; i<${#1}; i++)); do
        printf "%s" "${1:$i:1}"
        sleep 0.02
    done
}

clear
printf "\033[1;36m# postgresai — AI-native PostgreSQL observability\033[0m\n\n"
sleep 1

# 1. Run checkup
printf "\033[32m$\033[0m "
type_it "npx postgresai checkup postgresql://user@host/db"
printf "\n\n"
sleep 0.3

postgresai checkup "$DEMO_DB_URL" 2>&1

sleep 2

# 2. Show issues
printf "\n\033[1;36m# Issues created from findings:\033[0m\n\n"
sleep 0.5

printf "\033[32m$\033[0m "
type_it "npx postgresai issues list"
printf "\n\n"
sleep 0.3

postgresai issues list 2>&1 | head -20

sleep 2

# 3. Pipe to LLM
printf "\n\033[1;36m# Pipe JSON to any LLM:\033[0m\n\n"
sleep 0.5

printf "\033[32m$\033[0m "
type_it "npx postgresai checkup --json --check-id H002 | llm -s 'summarize top 3 issues'"
printf "\n\n"
sleep 0.3

# Run real LLM command
postgresai checkup --json --check-id H002 "$DEMO_DB_URL" 2>&1 | llm -s 'summarize the top 3 unused indexes by size, be brief'

sleep 2

# 4. Claude Code plugin teaser
printf "\n\033[1;36m# Or use Claude Code plugin:\033[0m\n\n"
sleep 0.5

printf "\033[32m$\033[0m "
type_it "claude /pgai:checkup postgresql://user@host/db"
printf "\n\n"
sleep 1

printf "\033[90m# Runs health check and analyzes results in your IDE\033[0m\n"
sleep 2
