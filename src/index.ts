/**
 * opencode-agent-messaging
 *
 * Keeps separate opencode sessions working in the same worktree up to date with
 * each other's changes.
 *
 *   tool.execute.after  every edit/write/apply_patch is appended to a shared
 *                       per-worktree feed on disk
 *   chat.message        before the model sees a new user turn, anything other
 *                       sessions did since this session last looked is injected
 *                       as a synthetic message part
 *   notify tool         lets an agent broadcast a note to the other sessions
 *   changes tool        lets an agent query recent activity on demand
 *
 * Everything is local: one append-only JSONL file per worktree under
 * ~/.cache/opencode/agent-feed/. Nothing leaves the machine and nothing is
 * written into your repository.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { Feed, Cursor, EDIT_TOOLS, DEFAULTS } from "./feed.js"

const num = (raw: string | undefined, fallback: number, scale: number) => {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n * scale : fallback
}

export const AgentMessaging: Plugin = async ({ worktree, directory }) => {
  if (process.env["OPENCODE_AGENT_MESSAGING"] === "0") return {}

  const root = worktree || directory || process.cwd()

  const feed = new Feed({
    root,
    backfillMs: num(process.env["OPENCODE_AGENT_MESSAGING_BACKFILL_MIN"], DEFAULTS.backfillMs, 60_000),
    retentionMs: num(process.env["OPENCODE_AGENT_MESSAGING_RETENTION_HOURS"], DEFAULTS.retentionMs, 3_600_000),
  })
  await feed.init()

  /** What each local session has already been shown. */
  const cursors = new Map<string, Cursor>()
  /** sessionID -> agent name, learned from chat.message, used when writing. */
  const agents = new Map<string, string>()

  /** Advance a session's cursor and return everything it has not seen yet. */
  const drain = async (sessionID: string) => {
    let cursor = cursors.get(sessionID)
    if (!cursor) {
      // A session joining late still gets a short look back, so it is not blind
      // to what happened just before it started.
      cursor = new Cursor(Date.now() - feed.backfillMs)
      cursors.set(sessionID, cursor)
    }
    const others = (await feed.read()).filter((e) => e.session !== sessionID)
    return cursor.take(others)
  }

  return {
    "chat.message": async (input, output) => {
      const sessionID = input.sessionID
      if (input.agent) agents.set(sessionID, input.agent)

      const fresh = await drain(sessionID)
      if (fresh.length === 0) return

      const text = feed.render(fresh)
      if (!text) return

      output.parts.push({
        id: `prt_msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        sessionID,
        messageID: output.message.id,
        type: "text",
        synthetic: true,
        text,
      })
    },

    "tool.execute.after": async (input) => {
      if (!EDIT_TOOLS.has(input.tool)) return
      const files = feed.filesOf(input.args)
      if (files.length === 0) return
      await feed.append({
        ts: Date.now(),
        session: input.sessionID,
        agent: agents.get(input.sessionID),
        kind: "edit",
        tool: input.tool,
        files,
      })
    },

    tool: {
      notify: tool({
        description:
          "Broadcast a short note to the other opencode sessions working in this worktree. " +
          "They receive it at the start of their next turn. Use it to flag a change that other " +
          "agents need to know about, such as a renamed export, a changed interface, a migration " +
          "you just ran, or a file you are about to rewrite. Do not use it for status chatter.",
        args: {
          message: tool.schema
            .string()
            .describe("The note to broadcast. One or two sentences, written for another agent."),
        },
        async execute(args, context) {
          const message = args.message.trim()
          if (!message) return "Nothing to send: message was empty."
          await feed.append({
            ts: Date.now(),
            session: context.sessionID,
            agent: context.agent,
            kind: "note",
            note: message,
          })
          return "Broadcast to other sessions in this worktree."
        },
      }),

      changes: tool({
        description:
          "List what other opencode sessions in this worktree have changed or broadcast recently. " +
          "Use before editing a file you have not read this turn, or when coordinating with a parallel agent.",
        args: {
          minutes: tool.schema
            .number()
            .optional()
            .describe("How far back to look, in minutes. Defaults to 60."),
        },
        async execute(args, context) {
          const since = Date.now() - (args.minutes ?? 60) * 60_000
          const entries = await feed.since(context.sessionID, since)
          if (entries.length === 0) return "No activity from other sessions in this window."
          return feed.render(entries) || "No activity from other sessions in this window."
        },
      }),
    },
  }
}

export default AgentMessaging
export { Feed, Cursor, EDIT_TOOLS, feedPathFor } from "./feed.js"
export type { Entry, FeedOptions } from "./feed.js"
