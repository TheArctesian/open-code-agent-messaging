import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Feed, Cursor, feedPathFor, EDIT_TOOLS, keyOf } from "../src/feed.js"

const ROOT = "/tmp/example-worktree"
let tmp: string

const makeFeed = (over: Partial<ConstructorParameters<typeof Feed>[0]> = {}) =>
  new Feed({ root: ROOT, file: tmp, now: () => 1_000_000, ...over })

beforeEach(async () => {
  tmp = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "feed-")), "feed.jsonl")
})

afterEach(async () => {
  await fs.rm(path.dirname(tmp), { recursive: true, force: true })
})

describe("feedPathFor", () => {
  test("is stable for a worktree and differs across worktrees", () => {
    expect(feedPathFor("/a/b")).toBe(feedPathFor("/a/b"))
    expect(feedPathFor("/a/b")).not.toBe(feedPathFor("/a/c"))
  })
})

describe("filesOf", () => {
  test("relativises paths inside the worktree", () => {
    expect(makeFeed().filesOf({ filePath: `${ROOT}/src/app.ts` })).toEqual(["src/app.ts"])
  })

  test("leaves paths outside the worktree alone", () => {
    expect(makeFeed().filesOf({ filePath: "/etc/hosts" })).toEqual(["/etc/hosts"])
  })

  test("parses every apply_patch marker", () => {
    const patchText = [
      "*** Begin Patch",
      "*** Add File: src/new.ts",
      "*** Update File: src/old.ts",
      "*** Move to: src/renamed.ts",
      "*** Delete File: src/gone.ts",
      "*** End Patch",
    ].join("\n")
    expect(makeFeed().filesOf({ patchText }).sort()).toEqual([
      "src/gone.ts",
      "src/new.ts",
      "src/old.ts",
      "src/renamed.ts",
    ])
  })

  test("dedupes and tolerates junk", () => {
    const feed = makeFeed()
    expect(feed.filesOf({ filePath: "a.ts", path: "a.ts" })).toEqual(["a.ts"])
    expect(feed.filesOf(null)).toEqual([])
    expect(feed.filesOf({})).toEqual([])
  })

  test("edit tool set covers the file-mutating built-ins", () => {
    for (const t of ["edit", "write", "apply_patch"]) expect(EDIT_TOOLS.has(t)).toBe(true)
    for (const t of ["read", "bash", "grep"]) expect(EDIT_TOOLS.has(t)).toBe(false)
  })
})

describe("append and read", () => {
  test("round-trips entries", async () => {
    const feed = makeFeed()
    await feed.append({ ts: 1, session: "ses_a", kind: "edit", files: ["a.ts"] })
    await feed.append({ ts: 2, session: "ses_b", kind: "note", note: "heads up" })
    const all = await feed.read()
    expect(all).toHaveLength(2)
    expect(all[1]!.note).toBe("heads up")
  })

  test("returns empty when the feed does not exist yet", async () => {
    expect(await makeFeed({ file: "/tmp/definitely-not-here/feed.jsonl" }).read()).toEqual([])
  })

  test("skips torn lines from a concurrent writer", async () => {
    await fs.writeFile(tmp, '{"ts":1,"session":"ses_a","kind":"edit"}\n{"ts":2,"sess\n')
    expect(await makeFeed().read()).toHaveLength(1)
  })
})

describe("since", () => {
  test("excludes the caller's own session and anything already seen", async () => {
    const feed = makeFeed()
    await feed.append({ ts: 10, session: "ses_self", kind: "edit", files: ["mine.ts"] })
    await feed.append({ ts: 10, session: "ses_other", kind: "edit", files: ["old.ts"] })
    await feed.append({ ts: 20, session: "ses_other", kind: "edit", files: ["new.ts"] })

    const fresh = await feed.since("ses_self", 15)
    expect(fresh).toHaveLength(1)
    expect(fresh[0]!.files).toEqual(["new.ts"])
  })
})

describe("Cursor", () => {
  const entry = (ts: number, id: string) => ({ ts, id, session: "ses_other", kind: "edit" as const, files: [id] })

  test("delivers each entry exactly once", () => {
    const cursor = new Cursor(0)
    const a = entry(10, "a")
    expect(cursor.take([a])).toEqual([a])
    expect(cursor.take([a])).toEqual([])
  })

  test("ignores anything older than the starting frontier", () => {
    const cursor = new Cursor(100)
    expect(cursor.take([entry(50, "old")])).toEqual([])
  })

  test("delivers an entry written in the same millisecond as the last delivery", () => {
    // The regression: a strict > comparison silently dropped this entry.
    const cursor = new Cursor(0)
    expect(cursor.take([entry(10, "a")])).toHaveLength(1)
    const b = entry(10, "b")
    expect(cursor.take([entry(10, "a"), b])).toEqual([b])
  })

  test("does not redeliver a same-millisecond entry on later turns", () => {
    const cursor = new Cursor(0)
    cursor.take([entry(10, "a")])
    cursor.take([entry(10, "a"), entry(10, "b")])
    expect(cursor.take([entry(10, "a"), entry(10, "b")])).toEqual([])
  })

  test("keeps the remembered id set bounded to the frontier", () => {
    const cursor = new Cursor(0)
    for (let ts = 1; ts <= 500; ts++) cursor.take([entry(ts, `e${ts}`)])
    expect((cursor as any).seen.size).toBe(1)
  })

  test("falls back to a derived key for entries written before ids existed", () => {
    expect(keyOf({ ts: 5, session: "ses_a", kind: "edit" })).toBe("5:ses_a:edit")
    expect(keyOf({ ts: 5, session: "ses_a", kind: "edit", id: "x" })).toBe("x")
  })
})

describe("append", () => {
  test("stamps every entry with a unique id", async () => {
    const feed = makeFeed()
    await feed.append({ ts: 1, session: "s", kind: "edit", files: ["a.ts"] })
    await feed.append({ ts: 1, session: "s", kind: "edit", files: ["a.ts"] })
    const [first, second] = await feed.read()
    expect(first!.id).toBeTruthy()
    expect(first!.id).not.toBe(second!.id)
  })
})

describe("render", () => {
  test("groups a session's edits onto one line", () => {
    const out = makeFeed().render([
      { ts: 1_000_000, session: "ses_abcdef", agent: "build", kind: "edit", files: ["a.ts"] },
      { ts: 1_000_000, session: "ses_abcdef", agent: "build", kind: "edit", files: ["b.ts"] },
    ])
    expect(out).toContain("build/abcdef changed")
    expect(out).toContain("a.ts, b.ts")
    expect(out.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(1)
  })

  test("includes broadcast notes", () => {
    const out = makeFeed().render([
      { ts: 1_000_000, session: "ses_abcdef", kind: "note", note: "renamed getUser to fetchUser" },
    ])
    expect(out).toContain("renamed getUser to fetchUser")
    expect(out).toContain("abcdef says")
  })

  test("wraps output in a tagged block with a staleness warning", () => {
    const out = makeFeed().render([{ ts: 1_000_000, session: "s", kind: "edit", files: ["a.ts"] }])
    expect(out.startsWith("<agent-messages>")).toBe(true)
    expect(out.endsWith("</agent-messages>")).toBe(true)
    expect(out).toContain("Re-read it before editing")
  })

  test("is empty when there is nothing worth saying", () => {
    expect(makeFeed().render([])).toBe("")
    expect(makeFeed().render([{ ts: 1, session: "s", kind: "edit", files: [] }])).toBe("")
  })

  test("caps the number of files so context cannot blow up", () => {
    const files = Array.from({ length: 200 }, (_, i) => `f${i}.ts`)
    const out = makeFeed().render([{ ts: 1_000_000, session: "s", kind: "edit", files }])
    expect(out).toContain("more)")
    expect(out.length).toBeLessThan(2000)
  })

  test("renders relative age", () => {
    const out = makeFeed().render([{ ts: 1_000_000 - 120_000, session: "s", kind: "edit", files: ["a.ts"] }])
    expect(out).toContain("2m ago")
  })
})

describe("compact", () => {
  test("drops entries past the retention window once the file is large", async () => {
    const feed = makeFeed({ compactBytes: 1, retentionMs: 1000 })
    await feed.append({ ts: 1_000_000 - 5000, session: "ses_old", kind: "edit", files: ["old.ts"] })
    await feed.append({ ts: 1_000_000, session: "ses_new", kind: "edit", files: ["new.ts"] })

    const all = await feed.read()
    expect(all).toHaveLength(1)
    expect(all[0]!.session).toBe("ses_new")
  })

  test("leaves a small feed untouched", async () => {
    const feed = makeFeed({ retentionMs: 1000 })
    await feed.append({ ts: 1, session: "ses_old", kind: "edit", files: ["old.ts"] })
    expect(await feed.read()).toHaveLength(1)
  })
})
