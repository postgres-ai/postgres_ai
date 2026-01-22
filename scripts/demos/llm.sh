#!/bin/bash
# Demo: pipe to LLM
clear
printf "\033[32m$\033[0m npx postgresai checkup --json --check-id H002 | llm -s 'summarize'\n\n"
sleep 0.5
PGPASSWORD="$DEMO_DB_PASS" npx postgresai checkup --json --check-id H002 "postgresql://postgres@${DEMO_HOST}/${DEMO_DB:-postgres}" 2>&1 | llm -s 'summarize the top 3 unused indexes by size, be brief'
sleep 2
