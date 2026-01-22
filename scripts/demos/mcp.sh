#!/bin/bash
# Demo: MCP install
clear
printf "\033[32m$\033[0m npx postgresai mcp install\n\n"
sleep 0.5
echo "2" | npx postgresai mcp install 2>&1
sleep 2
