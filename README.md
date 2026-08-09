# Swarm

[![npm version](https://img.shields.io/npm/v/opencode-swarm-plugin.svg)](https://www.npmjs.com/package/opencode-swarm-plugin)
[![Documentation](https://img.shields.io/badge/docs-swarmtools.ai-blue)](https://swarmtools.ai/docs)

```
 ███████╗██╗    ██╗ █████╗ ██████╗ ███╗   ███╗
 ██╔════╝██║    ██║██╔══██╗██╔══██╗████╗ ████║
 ███████╗██║ █╗ ██║███████║██████╔╝██╔████╔██║
 ╚════██║██║███╗██║██╔══██║██╔══██╗██║╚██╔╝██║
 ███████║╚███╔███╔╝██║  ██║██║  ██║██║ ╚═╝ ██║
 ╚══════╝ ╚══╝╚══╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝
```

**Multi-agent coordination that survives context death.**

Break big tasks into small ones. Spawn agents to work in parallel. Learn from what works.

> **[swarmtools.ai](https://swarmtools.ai)** · **[Documentation](https://swarmtools.ai/docs)**

---

## Installation

### OpenCode

```bash
bun add -g opencode-swarm-plugin@npm:@srmcguirt/opencode-swarm-plugin@latest
swarm setup
```

Done. Use `/swarm "your task"` in any OpenCode session.

### Claude Code

**Step 1:** Install the CLI globally (required):

```bash
bun add -g opencode-swarm-plugin@npm:@srmcguirt/opencode-swarm-plugin@latest
```

**Step 2:** Add the marketplace in Claude Code:

```
/plugin
→ Manage marketplaces
→ Add marketplace
→ Enter: joelhooks/swarm-tools
```

**Step 3:** Install the plugin:

```
/plugin
→ Manage plugins
→ swarm-tools
→ swarm
→ Install
```

The MCP server starts automatically. Use `/swarm "your task"` in any session.

---

## What It Does

```
/swarm "Add user authentication with OAuth"
```

1. **Decomposes** the task into parallelizable subtasks
2. **Creates cells** in the Hive (git-backed task tracker)
3. **Spawns workers** with file reservations (no conflicts)
4. **Coordinates** via Swarm Mail (embedded event store)
5. **Reviews** each completion before approval
6. **Learns** what worked for next time

---

## Core Concepts

### Hive

Git-backed task tracking in `.hive/`. Survives sessions, syncs via git.

```
hive_create({ title: "Fix auth bug", type: "bug" })
hive_cells({ status: "in_progress" })
hive_close({ id: "cell-123", reason: "Fixed" })
```

### Hivemind

Semantic memory with embeddings. Store learnings, search later.

```
hivemind_store({ information: "Auth requires idempotency keys", tags: "auth,gotcha" })
hivemind_find({ query: "auth patterns" })
```

### Swarm Mail

Actor-model coordination between agents. File reservations, messaging, checkpoints.

```
swarmmail_reserve({ paths: ["src/auth/*"], exclusive: true })
swarmmail_send({ to: ["worker-b"], subject: "Need types", body: "..." })
```

---

## Commands

| Command | Description |
|---------|-------------|
| `/swarm <task>` | Decompose and spawn parallel workers |
| `/hive` | Query and manage tasks |
| `/inbox` | Check messages from other agents |
| `/status` | Swarm coordination status |
| `/handoff` | End session with sync and handoff notes |

---

## CLI

```bash
swarm setup      # Configure OpenCode/Claude Code integration
swarm doctor     # Check dependencies (Ollama for embeddings)
swarm init       # Initialize hive in current project
swarm config     # Show config paths
```

---

## How It Works

```
                         Your Task
                             │
                             ▼
                    ┌────────────────┐
                    │  COORDINATOR   │
                    │                │
                    │ 1. Query past  │
                    │    sessions    │
                    │ 2. Pick strat  │
                    │ 3. Decompose   │
                    └────────────────┘
                             │
           ┌─────────────────┼─────────────────┐
           ▼                 ▼                 ▼
    ┌────────────┐    ┌────────────┐    ┌────────────┐
    │  Worker A  │    │  Worker B  │    │  Worker C  │
    │            │    │            │    │            │
    │ 🔒 files   │───▶│ 🔒 files   │    │ 🔒 files   │
    └────────────┘    └────────────┘    └────────────┘
           │                 │                 │
           └─────────────────┼─────────────────┘
                             ▼
                    ┌────────────────┐
                    │   LEARNING     │
                    │                │
                    │ Record outcome │
                    │ Update weights │
                    └────────────────┘
```

---

## Architecture

Everything runs locally. No external servers.

- **libSQL** - Embedded SQLite for event sourcing
- **Hive** - Git-backed `.hive/` directory for tasks
- **Hivemind** - Semantic memory with Ollama embeddings (falls back to FTS)
- **Swarm Mail** - DurableMailbox, DurableLock, DurableDeferred primitives

### Event Sourcing

All state is an append-only event log:

```
agent_registered → Agent joins swarm
message_sent     → Agent-to-agent communication
file_reserved    → Exclusive lock acquired
file_released    → Lock released
checkpoint       → Progress snapshot
outcome          → Completion result
```

---

## Learning System

Every completion records duration, errors, files touched, success.

- **Patterns** mature: candidate → established → proven
- **Anti-patterns** auto-generate when failure rate > 60%
- **Confidence decays** over 90 days unless revalidated

---

## Dependencies

| Required | Optional |
|----------|----------|
| [Bun](https://bun.sh) | [Ollama](https://ollama.ai) - local embeddings |

Run `swarm doctor` to check status.

### Embedding Model Configuration

Configure the embedding model via environment variables:

```bash
export OLLAMA_MODEL=nomic-embed-text  # Default: mxbai-embed-large
export OLLAMA_HOST=http://localhost:11434  # Default
```

Supported models: `mxbai-embed-large` (1024d), `nomic-embed-text` (768d), `all-minilm` (384d), `snowflake-arctic-embed` (1024d). See [swarm-mail docs](packages/swarm-mail/README.md#configuring-the-embedding-model) for details.

---

## Development

```bash
bun install
bun turbo build
bun turbo test
```

---

## Credits

- [MCP Agent Mail](https://github.com/Dicklesworthstone/mcp_agent_mail) - inspiration for multi-agent coordination
- [Electric SQL](https://electric-sql.com) - durable streams patterns
- [Superpowers](https://github.com/obra/superpowers) - verification patterns

---

MIT
