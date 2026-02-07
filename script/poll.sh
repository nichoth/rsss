#!/usr/bin/env bash
#
# Poll (refresh) all RSS feeds for all tracked users
# on the local dev server.
#
# Usage:
#   ./script/poll.sh                     # refresh all users
#   ./script/poll.sh did:plc:xyz123      # refresh specific DID
#   ./script/poll.sh --register          # dev-login + refresh
#
# The local dev server must be running (npm start).
#

set -euo pipefail

PORT="${PORT:-8888}"
BASE="http://localhost:${PORT}"
DID=""
REGISTER=false

for arg in "$@"; do
    case "$arg" in
        --register)
            REGISTER=true
            ;;
        did:*)
            DID="$arg"
            ;;
        --help|-h)
            echo "Usage: poll.sh [--register] [did:plc:...]"
            echo ""
            echo "Options:"
            echo "  --register   Dev-login first (registers"
            echo "               user in KV for future polls)"
            echo "  did:...      Refresh a specific user only"
            echo ""
            echo "Environment:"
            echo "  PORT         Dev server port (default 9999)"
            exit 0
            ;;
        *)
            echo "Unknown argument: $arg"
            exit 1
            ;;
    esac
done

# Check if the dev server is running
if ! curl -sf "${BASE}/health" > /dev/null 2>&1; then
    echo "Dev server is not running on port ${PORT}."
    echo "Start it with: npm start"
    exit 1
fi

echo "Dev server is running on port ${PORT}."

# If --register, do a dev-login to ensure the user
# is tracked in KV
if [ "$REGISTER" = true ]; then
    echo "Registering dev user via dev-login..."
    if [ -n "$DID" ]; then
        curl -sf "${BASE}/api/auth/dev-login" \
            -X POST \
            -H "Content-Type: application/json" \
            -d "{\"did\":\"${DID}\"}" \
            > /dev/null
    else
        curl -sf "${BASE}/api/auth/dev-login" \
            -X POST \
            -H "Content-Type: application/json" \
            -d '{}' \
            > /dev/null
    fi
    echo "  registered."
fi

# Refresh feeds
if [ -n "$DID" ]; then
    echo "Refreshing feeds for ${DID}..."
    RESULT=$(curl -sf "${BASE}/admin/refresh-all" \
        -X POST \
        -H "Content-Type: application/json" \
        -d "{\"dids\":[\"${DID}\"]}")
else
    echo "Refreshing feeds for all tracked users..."
    RESULT=$(curl -sf "${BASE}/admin/refresh-all" \
        -X POST \
        -H "Content-Type: application/json" \
        -d '{}')
fi

echo "$RESULT" | python3 -m json.tool 2>/dev/null \
    || echo "$RESULT"

echo ""
echo "Done."
