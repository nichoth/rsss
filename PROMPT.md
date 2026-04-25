study DOCS/README.md

# MISSION

Create a production-ready PWA (progressive web app) that uses Cloudflare
Durable Objects as the backend. This is a local-first PWA, with the app
using SQLite and OPFS locally. There is 1 user per Durable Object.

## Important

- Commit frequently
- Read the Codebase Patterns section in progress.log before starting


## EXECUTION RULES

1. READ: Always check `specs/prd.json` and `progress.log` at the start of
   every session.
2. SCOPE: Pick the highest priority task where `passes: false`. Work ONLY on
   that task.
3. WRITE TESTS: Before implementing, write failing tests for the feature/bug,
   then make the tests pass
4. TARGETED TESTING: 
   - DO NOT run the full test suite (`npm test`) for every minor change.
   - DO run only the tests relevant to the current file
     (e.g., `npx vitest path/to/file.spec.ts`).
   - Run the FULL test suite (`npm test`) ONLY when you believe the task is
     100% complete.
5. VERIFY: You must run `npm run lint` after any code change.
6. DOCUMENT: Update `progress.log` with what was changed and any new
   patterns discovered.
7. UPDATE: Update the PRD, `specs/prd.json` to set `passes: true` for the completed story
8. COMMIT: If tests pass, commit with a descriptive message
   like `FEATURE: [TaskID] - [Description]`.
9. ATOMICITY: Aim to complete exactly one task per iteration.


## Progress Report Format

APPEND to progress.log (never replace, always append):
```
## [Date/Time] - [Story ID]
Thread: https://ampcode.com/threads/$AMP_CURRENT_THREAD_ID
- What was implemented
- Files changed
- **Learnings for future iterations:**
  - Patterns discovered (e.g., "this codebase uses X for Y")
  - Gotchas encountered (e.g., "don't forget to update Z when changing W")
  - Useful context (e.g., "the evaluation panel is in component X")
---
```

The learnings section is critical - it helps future iterations avoid repeating mistakes and understand the codebase better.


## Consolidate Patterns

If you discover a **reusable pattern** that future iterations should know, add it to the `## Codebase Patterns` section at the TOP of progress.log (create it if it doesn't exist). This section should consolidate the most important learnings:

Only add patterns that are **general and reusable**, not story-specific details.

## Update AGENTS.md Files

Before committing, check if any edited files have learnings worth preserving in nearby AGENTS.md files:

1. **Identify directories with edited files** - Look at which directories you modified
2. **Check for existing AGENTS.md** - Look for AGENTS.md in those directories or parent directories
3. **Add valuable learnings** - If you discovered something future developers/agents should know:
   - API patterns or conventions specific to that module
   - Gotchas or non-obvious requirements
   - Dependencies between files
   - Testing approaches for that area
   - Configuration or environment requirements

**Examples of good AGENTS.md additions:**
- "When modifying X, also update Y to keep them in sync"
- "This module uses pattern Z for all API calls"
- "Tests require the dev server running on PORT 3000"
- "Field names must match the template exactly"

**Do NOT add:**
- Story-specific implementation details
- Temporary debugging notes
- Information already in progress.log

Only update AGENTS.md if you have **genuinely reusable knowledge** that would help future work in that directory.


## STOP CONDITION

Once ALL tasks in `specs/prd.json` have `passes: true`, you must output the 
exact string: <promise>COMPLETE</promise>
Do not perform any further work after all tasks are verified.