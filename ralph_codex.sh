#!/bin/bash

# Config
PROMPT_FILE="PROMPT.md"
MAX_ITERATIONS=${1:-10}
STALEMATE_THRESHOLD=3
ITERATION=0
STALLED_COUNT=0
REASONING_LEVEL="low" # Start at low

echo "Starting Ralph Loop with Improved Stall Detection..."

if ! git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
    echo "Error: This script requires a git repository."
    exit 1
fi

# Exit the entire script if Ctrl+C is pressed
trap "echo -e '\n${MAGENTA}Stopping Ralph Loop...${NC}'; exit 1" SIGINT

while [ $ITERATION -lt $MAX_ITERATIONS ]; do
    ITERATION=$((ITERATION + 1))

    # 1. Determine Reasoning Level
    if [ $STALLED_COUNT -ge $STALEMATE_THRESHOLD ]; then
        REASONING_LEVEL="high"
        COLOR="\033[1;33m" # Yellow
        echo -e "${COLOR}>>> STALL DETECTED ($STALLED_COUNT rounds). Escalating to HIGH... \033[0m"
    else
        # We stay at whatever level we were (or medium)
        COLOR="\033[1;34m" # Blue
    fi

    echo -e "\n${COLOR}--- Iteration $ITERATION ($REASONING_LEVEL reasoning) --- \033[0m"

    # 2. Capture state BEFORE the run
    # We use a hash of the porcelain status to see if anything changes
    PRE_STATE=$(git status --porcelain | sha256sum)

    # 3. Codex CLI
    # We pass the reasoning level into the config flag
    RESPONSE=$(cat "$PROMPT_FILE" | codex -m gpt-5.5 exec --yolo --config model_reasoning_effort="\"$REASONING_LEVEL\"" -)
    if [ $? -ne 0 ]; then
        echo -e "\033[0;31m[!] Codex command failed. Sleeping and retrying...\033[0m"
        sleep 5
        continue
    fi

    tmp_response=$(mktemp)
    
    # 4. Capture state AFTER the run
    POST_STATE=$(git status --porcelain | sha256sum)

    # 5. Stall Detection Logic
    if [ "$PRE_STATE" == "$POST_STATE" ]; then
        STALLED_COUNT=$((STALLED_COUNT + 1))
        echo -e "\033[0;31m[!] No file changes detected this round.\033[0m"
    else
        echo -e "\033[0;32m[+] Progress detected! Keeping current effort level.\033[0m"
        STALLED_COUNT=0 
        # Optional: Reset to medium if you want to save tokens/credits
        REASONING_LEVEL="medium" 
    fi

    # 6. Completion Signal
    if [[ "$RESPONSE" == *"<promise>COMPLETE</promise>"* ]]; then
        echo -e "\n\033[1;32m✅ SUCCESS: Mission accomplished.\033[0m"
        exit 0
    fi

    sleep 2
done

echo -e "\n\033[1;31m⚠️ Loop reached max iterations.\033[0m"
