# opencode-agent-messaging

Keeps parallel [opencode](https://opencode.ai) sessions working in the same worktree up to date with each other's code changes.

Run two or three opencode sessions against one repo and they each hold a private, increasingly stale picture of the codebase. Session A renames an export, session B keeps editing against the old name and clobbers it. This plugin closes that loop: every file change is written to a shared local feed, and each session is told what the others did at the start of its next turn.

## What it does

| | |
|---|---|
| **Automatic change feed** | Every `edit` / `write` / `apply_patch` is appended to a per-worktree feed. |
| **Turn-start delivery** | Before the model sees your next message, changes made by *other* sessions are injected as a synthetic part. |
| **`notify` tool** | An agent can broadcast a short note to the other sessions. |
| **`changes` tool** | An agent can query recent activity on demand. |

What another session sees:

```
<agent-messages>
Other opencode sessions are working in this same worktree. Since your last turn:
- build/9f2a1c says (2m ago): renamed getUser to fetchUser across the api package
- build/9f2a1c changed (1m ago): src/api/user.ts, src/api/index.ts
Your knowledge of any file listed above may be stale. Re-read it before editing.
</agent-messages>
```

Everything is local. One append-only JSONL file per worktree under `~/.cache/opencode/agent-feed/`. Nothing leaves the machine, nothing is written into your repository, and no LLM call is made to produce a notice.

## Install

```jsonc
// opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-agent-messaging"]
}
```

Then start two or more opencode sessions in the same worktree.

### Local development

opencode only auto-loads files at the **top level** of its plugins directory, so clone the repo there and add a one-line loader beside it:

```sh
git clone https://github.com/TheArctesian/open-code-agent-messaging.git \
  ~/.config/opencode/plugins/open-code-agent-messaging
cd ~/.config/opencode/plugins/open-code-agent-messaging && bun install
```

```ts
// ~/.config/opencode/plugins/agent-messaging.ts
export { AgentMessaging } from "./open-code-agent-messaging/src/index.js"
```

Restart opencode to pick up source edits.

```sh
bun test        # 35 tests
bun run typecheck
bun run build
```

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `OPENCODE_AGENT_MESSAGING` | on | Set to `0` to disable every hook. |
| `OPENCODE_AGENT_MESSAGING_BACKFILL_MIN` | `30` | How far back a newly started session looks, so late joiners are not blind. |
| `OPENCODE_AGENT_MESSAGING_RETENTION_HOURS` | `12` | How long entries survive feed compaction. |

To stop agents broadcasting on their own, deny the tools:

```jsonc
{ "permission": { "notify": "deny", "changes": "deny" } }
```

## How it works

| Hook | Role |
|---|---|
| `tool.execute.after` | Appends an entry when an edit tool succeeds. |
| `chat.message` | Drains the session's cursor and injects a synthetic text part. |
| `tool` | Registers `notify` and `changes`. |

Sessions are matched by worktree, so unrelated projects never see each other's traffic. Concurrency is handled without a lock: each entry is a single small `appendFile`, which the OS keeps atomic at these sizes, and a torn line from a crashed writer is skipped on read.

Delivery is tracked per session by a cursor holding a timestamp *plus the entry ids sitting exactly on it*. A timestamp alone is not sufficient — an entry written in the same millisecond as a turn boundary is either dropped forever (strict `>`) or redelivered forever (`>=`). Carrying the frontier ids fixes both, and the remembered set stays bounded to same-millisecond collisions.

Notices are capped (8 sessions, 40 file paths, 600 characters per note), so a busy worktree cannot flood another agent's context.

## Limitations

- **Same machine, same worktree.** The feed is a local file. Coordinating across machines would need a shared transport.
- **Cursors are in-memory.** Restarting a session resets it to the backfill window.
- **Changes are reported, not merged.** The plugin tells an agent a file is stale; it does not stop the edit. Real concurrent writes to one file still want separate git worktrees.
- **Paths only, no diffs.** A notice says *what* changed, not *how*. Keeps the context cost near zero.

## License

AGPL-3.0-only
