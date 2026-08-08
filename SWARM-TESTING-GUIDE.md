# Swarm Testing Guide: See It Work IRL

```
    ╔══════════════════════════════════════════════════════════════════╗
    ║                                                                  ║
    ║     🐝  HANDS-ON SWARM TESTING  🐝                               ║
    ║                                                                  ║
    ║     Not unit tests. Real swarms. Real coordination.             ║
    ║     Watch the bees dance.                                        ║
    ║                                                                  ║
    ╚══════════════════════════════════════════════════════════════════╝
```

## Prerequisites

```bash
# 1. Install the plugin globally
bun add -g opencode-swarm-plugin@npm:@srmcguirt/opencode-swarm-plugin@latest

# 2. Verify CLI works
swarm --version

# 3. Ensure Ollama is running (for semantic memory features)
ollama serve &
ollama pull mxbai-embed-large

# 4. Open a project with opencode
cd /path/to/your/project
opencode
```

---

## Test 1: Basic Swarm Coordination

**Goal:** Watch a swarm decompose a task, spawn workers, and coordinate.

### Step 1: Trigger a Swarm

In opencode, run:

```
/swarm "Add a simple greeting utility with tests"
```

### Step 2: Watch the Magic

You should see:

1. **Decomposition** - Task broken into subtasks
2. **Epic created** - `hive_create_epic` called
3. **Workers spawned** - Multiple agents start working
4. **File reservations** - Workers claim files
5. **Progress updates** - Workers report status
6. **Review cycle** - Coordinator reviews work
7. **Completion** - Epic closed when all subtasks done

### Step 3: Monitor in Real-Time

Open another terminal:

```bash
# Watch the swarm live
swarm dashboard

# Or focus on the specific epic
swarm dashboard --epic <epic-id-from-output>
```

### What to Look For

```
┌─────────────────────────────────────────────────────────────┐
│  ✅ WORKING                    │  ❌ BROKEN                 │
├─────────────────────────────────────────────────────────────┤
│  Multiple workers spawned      │  Only 1 worker             │
│  File reservations shown       │  No reservations           │
│  Progress updates flowing      │  Silent workers            │
│  Review feedback sent          │  No review cycle           │
│  Epic closes when done         │  Epic stays open forever   │
└─────────────────────────────────────────────────────────────┘
```

---

## Test 2: Swarm Mail Coordination

**Goal:** See agents communicate via swarm mail.

### Step 1: Start a Multi-File Task

```
/swarm "Refactor the auth module: split into separate files for login, logout, and session management"
```

### Step 2: Watch Agent Communication

```bash
# In another terminal, watch messages
swarm query --sql "SELECT * FROM messages ORDER BY timestamp DESC LIMIT 20"
```

### Step 3: Check Reservations

```bash
# See who owns what files
swarm query --sql "SELECT * FROM reservations WHERE released_at IS NULL"
```

### What to Look For

- Workers send progress updates to coordinator
- Blocked workers notify coordinator
- Coordinator sends review feedback
- File reservations prevent conflicts

---

## Test 3: Compaction with Swarm Context

**Goal:** Verify compaction preserves swarm state.

### Step 1: Start a Long-Running Swarm

```
/swarm "Implement a full CRUD API with validation, error handling, and tests"
```

### Step 2: Wait for Context to Fill

Let the swarm run until you see context getting heavy (or manually trigger with `/checkpoint`).

### Step 3: Check Compaction Output

After compaction, you should see:

```
[Swarm compaction: LLM-generated, Epic 'CRUD API' with 3/5 subtasks complete]

## 🐝 Swarm State

**Epic:** bd-xxx - Implement CRUD API
**Project:** /path/to/project
**Progress:** 3/5 subtasks complete

**Active:**
- bd-xxx.4: Add validation [in_progress] → BlueLake working on src/validation.ts

**Completed:**
- bd-xxx.1: Create routes ✓
- bd-xxx.2: Add handlers ✓
- bd-xxx.3: Error handling ✓

**Ready to Spawn:**
- bd-xxx.5: Write tests (files: tests/api.test.ts)
```

### Step 4: Verify Coordinator Resumes

After compaction, the coordinator should:

1. Call `swarm_status()` immediately
2. Check `swarmmail_inbox()`
3. Spawn any ready subtasks
4. Continue orchestrating

### What to Look For

```
┌─────────────────────────────────────────────────────────────┐
│  ✅ WORKING                    │  ❌ BROKEN                 │
├─────────────────────────────────────────────────────────────┤
│  "Epic with X/Y complete"      │  "No cells found"          │
│  Subtask status preserved      │  Lost track of progress    │
│  Coordinator resumes work      │  Coordinator confused      │
│  Ready tasks get spawned       │  Nothing happens           │
└─────────────────────────────────────────────────────────────┘
```

---

## Test 4: Semantic Memory in Action

**Goal:** See memory store, retrieve, and link knowledge.

### Step 1: Store Some Learnings

In opencode:

```
Store this in semantic memory: "OAuth refresh tokens need 5 minute buffer before expiry to avoid race conditions in concurrent requests"
```

The agent should call `semantic-memory_store()`.

### Step 2: Query It Back

Later in the session (or a new session):

```
What do we know about OAuth token handling?
```

The agent should call `semantic-memory_find()` and retrieve your learning.

### Step 3: Test Smart Upsert

```
Store this: "OAuth refresh tokens need 3 minute buffer" (this contradicts the 5 minute one)
```

With smart upsert, the LLM should:
- Detect the conflict
- Decide to UPDATE (not ADD)
- Explain the change

### Step 4: Check Memory Stats

```bash
# Via CLI
swarm tool semantic-memory_stats

# Or in opencode
Check semantic memory stats
```

### What to Look For

```
┌─────────────────────────────────────────────────────────────┐
│  ✅ WORKING                    │  ❌ BROKEN                 │
├─────────────────────────────────────────────────────────────┤
│  Memory stored with tags       │  "Ollama not available"    │
│  Semantic search finds it      │  Empty results             │
│  Smart upsert detects dupe     │  Creates duplicate         │
│  Auto-tags extracted           │  No tags                   │
└─────────────────────────────────────────────────────────────┘
```

---

## Test 5: CASS (Cross-Agent Session Search)

**Goal:** Search past agent sessions for solutions.

### Step 1: Build the Index

```bash
# Check health first
swarm tool cass_health

# If unhealthy, build index
swarm tool cass_index
```

### Step 2: Search Past Sessions

In opencode:

```
Search CASS for how we handled authentication errors before
```

Or via CLI:

```bash
swarm tool cass_search --query "authentication error handling" --limit 5
```

### Step 3: View a Result

```bash
# Use the path from search results
swarm tool cass_view --path "/path/to/session.jsonl" --line 42
```

### What to Look For

- Index builds without errors
- Search returns relevant past sessions
- Can view specific session context
- Helps avoid solving same problem twice

---

## Test 6: Observability Tools

**Goal:** Debug and analyze swarm behavior.

### Step 1: Run a Swarm (any task)

```
/swarm "Add logging to the API endpoints"
```

### Step 2: Query Analytics

```bash
# What strategies work best?
swarm query --preset duration_by_strategy

# Any failures?
swarm query --preset failed_decompositions

# File conflicts?
swarm query --preset file_conflicts

# Worker success rates?
swarm query --preset worker_success_rate
```

### Step 3: Replay an Epic

```bash
# Get epic ID from swarm output or hive_cells
swarm replay <epic-id> --speed 2x
```

### Step 4: Export for Analysis

```bash
# Export to JSON
swarm export --epic <epic-id> --format json > swarm-events.json

# Filter with jq
cat swarm-events.json | jq '.[] | select(.type=="worker_spawned")'
```

### Step 5: Check Stats

```bash
# Overall health
swarm stats --since 24h

# Recent history
swarm history --limit 10
```

---

## Test 7: Hive Cell Management

**Goal:** Verify cell tracking and queries work.

### Step 1: Create Some Cells

```bash
# Via CLI
swarm tool hive_create --title "Test task" --type task

# Or in opencode
Create a new task: "Implement feature X"
```

### Step 2: Query Cells

```bash
# All open cells
swarm tool hive_cells

# Filter by status
swarm tool hive_cells --status in_progress

# Partial ID search
swarm tool hive_cells --id "abc"  # Finds all cells containing "abc"
```

### Step 3: Update and Close

```bash
# Start working
swarm tool hive_start --id <cell-id>

# Close when done
swarm tool hive_close --id <cell-id> --reason "Completed successfully"
```

### Step 4: Sync to Git

```bash
swarm tool hive_sync
```

Check `.hive/issues.jsonl` - should have your cells.

---

## Test 8: Skills System

**Goal:** Load and use skills for specialized knowledge.

### Step 1: List Available Skills

```bash
swarm tool skills_list
```

### Step 2: Use a Skill

In opencode:

```
Load the testing-patterns skill and help me write tests for this auth module
```

The agent should call `skills_use(name="testing-patterns")` and apply the patterns.

### Step 3: Create a Custom Skill

```bash
# Initialize skills in project
swarm tool skills_init

# Create a new skill
swarm tool skills_create --name "my-project-patterns" --description "Patterns specific to this project"
```

Edit `.opencode/skills/my-project-patterns/SKILL.md` with your patterns.

---

## Test 9: Review Cycle

**Goal:** See coordinator review and provide feedback.

### Step 1: Start a Swarm with Intentional Issues

```
/swarm "Add a function that divides two numbers" 
```

### Step 2: Watch for Review

The coordinator should:
1. Spawn a worker
2. Worker completes
3. Coordinator calls `swarm_review()`
4. Coordinator sends `swarm_review_feedback()`

### Step 3: Check Review in Logs

```bash
swarm query --sql "SELECT * FROM events WHERE type LIKE '%review%' ORDER BY timestamp DESC LIMIT 10"
```

### What to Look For

- `swarm_review` generates review prompt
- `swarm_review_feedback` sends approval or issues
- If rejected, worker gets another chance (up to 3 tries)
- After 3 rejections, task marked blocked

---

## Test 10: Full E2E Swarm

**Goal:** Complete end-to-end swarm with all features.

### The Task

```
/swarm "Create a user preferences module with:
1. Schema definition (Zod)
2. CRUD operations
3. Validation
4. Unit tests
5. Integration tests"
```

### Watch For

1. **Decomposition** - 5 subtasks created
2. **Parallel spawning** - Multiple workers start
3. **File reservations** - Each worker claims their files
4. **Progress updates** - Workers report via swarm mail
5. **Dependencies** - Tests wait for implementation
6. **Review cycle** - Coordinator reviews each completion
7. **Compaction** - If context fills, state preserved
8. **Completion** - All subtasks done, epic closed

### Monitor Everything

Terminal 1 (opencode):
```
/swarm "Create user preferences module..."
```

Terminal 2 (dashboard):
```bash
swarm dashboard
```

Terminal 3 (queries):
```bash
watch -n 5 'swarm query --sql "SELECT type, COUNT(*) FROM events GROUP BY type"'
```

---

## Troubleshooting

### "No cells found" during compaction

**Cause:** Hive projection stale, cells already closed.
**Fix:** Swarm signature detection should handle this. Check logs for "projection" vs "hive_query" source.

### Workers not spawning in parallel

**Cause:** Dependencies between subtasks, or coordinator not spawning.
**Fix:** Check decomposition - are files overlapping? Check coordinator is calling `swarm_spawn_subtask`.

### Semantic memory "Ollama not available"

**Cause:** Ollama not running or model not pulled.
**Fix:** 
```bash
ollama serve &
ollama pull mxbai-embed-large
```

### CASS returns no results

**Cause:** Index not built or no sessions indexed.
**Fix:**
```bash
swarm tool cass_health
swarm tool cass_index --full true
swarm tool cass_stats
```

### Swarm mail messages not showing

**Cause:** Workers not initialized or not sending updates.
**Fix:** Check workers call `swarmmail_init()` first. Check `swarmmail_send()` calls in logs.

---

## Quick Reference

| Feature | How to Trigger | How to Verify |
|---------|----------------|---------------|
| Swarm coordination | `/swarm "task"` | `swarm dashboard` |
| Swarm mail | Automatic in swarm | `swarm query --sql "SELECT * FROM messages"` |
| Compaction | `/checkpoint` or auto | Check output for "Swarm State" |
| Semantic memory | "Store this..." | `swarm tool semantic-memory_stats` |
| CASS | "Search CASS for..." | `swarm tool cass_search` |
| Observability | After any swarm | `swarm query --preset <name>` |
| Hive cells | "Create task..." | `swarm tool hive_cells` |
| Skills | "Load skill..." | `swarm tool skills_list` |
| Review cycle | Automatic in swarm | Check events for `review` type |

---

```
           🐝
         /   \
        | o o |  "Now go make the bees dance."
         \   /
          | |
         _| |_
        /     \
       |  🍯   |
        \_____/
```
