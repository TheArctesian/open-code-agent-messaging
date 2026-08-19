import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import fs from "node:fs/promises"
import { AgentMessaging, feedPathFor } from "../src/index.js"

/**
 * Drives the real plugin hooks the way opencode does, with two independently
 * constructed plugin instances standing in for two separate opencode processes
 * sharing one worktree.
 */

let root: string

const load = async () => (await AgentMessaging({ worktree: root } as any)) as any

/** Fake the object opencode hands to chat.message, and report injected text. */
const turn = async (plugin: any, sessionID: string, agent = "build") => {
  const output = { message: { id: "msg_1" }, parts: [] as any[] }
  await plugin["chat.message"]({ sessionID, agent }, output)
  return output.parts.map((p) => p.text).join("\n")
}

const edit = (plugin: any, sessionID: string, filePath: string) =>
  plugin["tool.execute.after"]({ tool: "edit", sessionID, callID: "c1", args: { filePath } })

beforeEach(() => {
  root = `/tmp/oc-agent-messaging-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
})

afterEach(async () => {
  await fs.rm(feedPathFor(root), { force: true })
})

describe("cross-session flow", () => {
  test("one session's edit reaches another session's next turn", async () => {
    const a = await load()
    const b = await load()

    await turn(a, "ses_aaaaaa")
    await edit(a, "ses_aaaaaa", `${root}/src/auth.ts`)

    const injected = await turn(b, "ses_bbbbbb")
    expect(injected).toContain("src/auth.ts")
    expect(injected).toContain("<agent-messages>")
  })

  test("a session is never told about its own edits", async () => {
    const a = await load()
    await turn(a, "ses_aaaaaa")
    await edit(a, "ses_aaaaaa", `${root}/src/auth.ts`)
    expect(await turn(a, "ses_aaaaaa")).toBe("")
  })

  test("each change is delivered once, not on every subsequent turn", async () => {
    const a = await load()
    const b = await load()

    await edit(a, "ses_aaaaaa", `${root}/src/auth.ts`)
    expect(await turn(b, "ses_bbbbbb")).toContain("src/auth.ts")
    expect(await turn(b, "ses_bbbbbb")).toBe("")

    await edit(a, "ses_aaaaaa", `${root}/src/db.ts`)
    const second = await turn(b, "ses_bbbbbb")
    expect(second).toContain("src/db.ts")
    expect(second).not.toContain("src/auth.ts")
  })

  test("non-edit tools are ignored", async () => {
    const a = await load()
    const b = await load()
    await a["tool.execute.after"]({
      tool: "read",
      sessionID: "ses_aaaaaa",
      callID: "c1",
      args: { filePath: `${root}/src/auth.ts` },
    })
    expect(await turn(b, "ses_bbbbbb")).toBe("")
  })
})

describe("notify tool", () => {
  test("broadcasts a note to other sessions", async () => {
    const a = await load()
    const b = await load()

    const ack = await a.tool.notify.execute(
      { message: "renamed getUser to fetchUser across the api package" },
      { sessionID: "ses_aaaaaa", agent: "build" },
    )
    expect(ack).toContain("Broadcast")

    const injected = await turn(b, "ses_bbbbbb")
    expect(injected).toContain("renamed getUser to fetchUser")
    expect(injected).toContain("build/aaaaaa")
  })

  test("rejects an empty message", async () => {
    const a = await load()
    const ack = await a.tool.notify.execute({ message: "   " }, { sessionID: "ses_aaaaaa", agent: "build" })
    expect(ack).toContain("empty")
  })
})

describe("changes tool", () => {
  test("reports other sessions' recent activity on demand", async () => {
    const a = await load()
    const b = await load()
    await edit(a, "ses_aaaaaa", `${root}/src/auth.ts`)

    const out = await b.tool.changes.execute({}, { sessionID: "ses_bbbbbb", agent: "build" })
    expect(out).toContain("src/auth.ts")
  })

  test("says so when there is nothing to report", async () => {
    const b = await load()
    const out = await b.tool.changes.execute({}, { sessionID: "ses_bbbbbb", agent: "build" })
    expect(out).toContain("No activity")
  })

  test("does not consume the chat.message queue", async () => {
    const a = await load()
    const b = await load()
    await edit(a, "ses_aaaaaa", `${root}/src/auth.ts`)

    await b.tool.changes.execute({}, { sessionID: "ses_bbbbbb", agent: "build" })
    expect(await turn(b, "ses_bbbbbb")).toContain("src/auth.ts")
  })
})

describe("kill switch", () => {
  test("OPENCODE_AGENT_MESSAGING=0 disables every hook", async () => {
    process.env["OPENCODE_AGENT_MESSAGING"] = "0"
    try {
      const plugin = (await AgentMessaging({ worktree: root } as any)) as any
      expect(plugin["chat.message"]).toBeUndefined()
      expect(plugin.tool).toBeUndefined()
    } finally {
      delete process.env["OPENCODE_AGENT_MESSAGING"]
    }
  })
})
