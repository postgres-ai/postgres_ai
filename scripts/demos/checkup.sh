#!/bin/bash
# Demo: basic checkup
clear
printf "\033[32m$\033[0m npx postgresai checkup postgresql://user@host/db\n\n"
sleep 0.5
PGPASSWORD="$DEMO_DB_PASS" postgresai checkup "postgresql://postgres@${DEMO_HOST}/workloaddb" 2>&1
sleep 2
