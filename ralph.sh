#!/bin/bash
set -o pipefail  # catch CLI failures

# Using Claude

# --- Config ---
PROMPT_FILE="PROMPT.md"
PRD_FILE="specs/prd.json"
LOG_FILE="progress.log"
MAX_ITERATIONS=${1:-10}
ITERATION=0
STALLED_COUNT=0

# --- UI Colors ---
BLUE='\033[1;34m'; YELLOW='\033[1;33m'; GREEN='\033[1;32m'; MAGENTA='\033[1;35m'; NC='\033[0m'
log_info()    { echo -e "${BLUE}ℹ️  $1${NC}"; }
log_step()    { echo -e "${YELLOW}➔ $1${NC}"; }
log_success() { echo -e "${GREEN}✅ $1${NC}"; }
log_warn()    { echo -e "${MAGENTA}⚠️  $1${NC}"; }

# Exit the entire script if Ctrl+C is pressed
trap "echo -e '\n${MAGENTA}Stopping Ralph Loop...${NC}'; exit 1" SIGINT

while [ $ITERATION -lt $MAX_ITERATIONS ]; do
    ITERATION=$((ITERATION + 1))
    
    # 1. Adjust Reasoning Level
    REASONING_LEVEL="low"
    [ "$STALLED_COUNT" -eq 1 ] && REASONING_LEVEL="medium"
    [ "$STALLED_COUNT" -ge 2 ] && REASONING_LEVEL="high"

    # If we've stalled twice, wipe the local wrangler state to ensure 
    # stale D1/KV data isn't causing the friction.
    if [ "$STALLED_COUNT" -eq 2 ]; then
        log_warn "Friction detected. Clearing .wrangler local state..."
        rm -rf .wrangler/state/v3
    fi

    # 2. Get Task Context
    PENDING_TASKS=$(jq -r '.userStories[] | select(.passes == false or .passes == null) | "[\(.id)] \(.title)"' "$PRD_FILE")
    CURRENT_TASK=$(echo "$PENDING_TASKS" | head -n 1)
    
    if [ -z "$CURRENT_TASK" ]; then
        log_success "No incomplete tasks found."
        exit 0
    fi

    echo -e "${BLUE}------------------------------------------------------------${NC}"
    log_info "ITERATION $ITERATION/$MAX_ITERATIONS | LEVEL: $REASONING_LEVEL"
    log_step "TARGET: $CURRENT_TASK"
    echo -e "${BLUE}------------------------------------------------------------${NC}"

    # 3. Build Dynamic Context for the CLI
    TMP_CONTEXT=$(mktemp)
    {
        cat "$PROMPT_FILE"
        echo -e "\n# CURRENT STATE"
        echo "PENDING_TASKS: $PENDING_TASKS"
        echo "LAST_LOG_ENTRY: $(tail -n 5 "$LOG_FILE" 2>/dev/null)"
    } > "$TMP_CONTEXT"

    # 4. Execute
    TMP_CAPTURE=$(mktemp)
    cat "$TMP_CONTEXT" | claude -p --effort "$REASONING_LEVEL" --dangerously-skip-permissions | tee "$TMP_CAPTURE"
    RESPONSE=$(cat "$TMP_CAPTURE")

    # 5. Progress Detection (Commit OR File Changes)
    HAS_CHANGES=$(git status --porcelain)
    if [ -n "$HAS_CHANGES" ]; then
        log_success "Activity detected."
        STALLED_COUNT=0
    else
        log_warn "No changes detected."
        STALLED_COUNT=$((STALLED_COUNT + 1))
    fi

    # Cleanup temp files
    rm "$TMP_CONTEXT" "$TMP_CAPTURE"

    if [[ "$RESPONSE" == *"<promise>COMPLETE</promise>"* ]]; then
        log_success "MISSION ACCOMPLISHED."
        exit 0
    fi
done
