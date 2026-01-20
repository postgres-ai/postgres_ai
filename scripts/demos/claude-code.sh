#!/bin/bash
# Demo: Claude Code plugin - installation and Issues workflow
clear

# Show installation commands
printf "\033[1;36m# Install plugin:\033[0m\n\n"
printf "\033[32m$\033[0m claude plugin marketplace add postgres-ai/postgresai\n"
sleep 1
printf "✓ Added marketplace: postgres-ai/postgresai\n\n"
sleep 0.5

printf "\033[32m$\033[0m claude plugin install pgai@postgresai\n"
sleep 1
printf "✓ Installed plugin: pgai\n\n"
sleep 1

printf "\033[1;36m# Use /pgai:issues in Claude Code:\033[0m\n\n"
sleep 0.5

export TERM=xterm-256color
tmux kill-session -t demo-cc 2>/dev/null || true

# Issue ID to analyze (H002 Unused indexes - 31 indexes, 19.2 GiB)
ISSUE_ID="019b3336-fb12-7072-b792-3233ffbcd699"

# Create inner script
cat > /tmp/demo-inner.sh << EOF
#!/bin/bash
sleep 2

# Type the slash command character by character
type_cmd() {
    local cmd="\$1"
    for ((i=0; i<\${#cmd}; i++)); do
        tmux send-keys -t demo-cc -l "\${cmd:\$i:1}"
        sleep 0.03
    done
}

# Step 1: List issues
type_cmd "/pgai:issues"
sleep 1
tmux send-keys -t demo-cc Enter

# Wait for response
sleep 25

# Step 2: Analyze specific issue
type_cmd "/pgai:issues $ISSUE_ID"
sleep 1
tmux send-keys -t demo-cc Enter

# Wait for analysis to complete and be read
sleep 45

# Exit
tmux send-keys -t demo-cc "/exit"
sleep 0.5
tmux send-keys -t demo-cc Enter
sleep 2
EOF
chmod +x /tmp/demo-inner.sh

# Start tmux with Claude, matching agg dimensions
# NOTE: --dangerously-skip-permissions is used ONLY for demo recording automation
# in a sandboxed environment. Never use this flag in production - it bypasses
# security controls.
tmux new-session -d -s demo-cc -x 100 -y 30 "claude --dangerously-skip-permissions"
/tmp/demo-inner.sh &
tmux attach -t demo-cc
