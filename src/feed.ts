import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"

export type Entry = {
  ts: number
  session: string
  agent?: string
  kind: "edit" | "note"
  tool?: string
  files?: string[]
  note?: string
  /** Unique per append. Assigned on write; optional when reading older feeds. */
  id?: string
}

/** Identity used for delivery de-duplication. */
export const keyOf = (e: Entry) => e.id ?? `${e.ts}:${e.session}:${e.kind}`

/**
 * Tracks what a single session has already been shown.
 *
 * A plain "last seen timestamp" is not enough: an entry written in the same
 * millisecond as a turn boundary is either dropped (strict >) or redelivered
 * forever (>=). So the frontier is a timestamp plus the ids sitting exactly on
 * it, which keeps the remembered set bounded to same-millisecond collisions.
 */
export class Cursor {
  private lastTs: number
  private seen = new Map<string, number>()

  constructor(startTs: number) {
    this.lastTs = startTs
  }

  take(entries: Entry[]): Entry[] {
    const fresh = entries.filter((e) => e.ts >= this.lastTs && !this.seen.has(keyOf(e)))
    if (fresh.length === 0) return []

    for (const e of fresh) this.seen.set(keyOf(e), e.ts)
    this.lastTs = Math.max(this.lastTs, ...fresh.map((e) => e.ts))
    for (const [id, ts] of this.seen) if (ts < this.lastTs) this.seen.delete(id)

    return fresh
  }
}

export type FeedOptions = {
  /** Worktree root. Used to key the feed and to relativise paths. */
  root: string
  /** Override the feed file location. Mainly for tests. */
  file?: string
  /** On a session's first turn, look back this far so late joiners get context. */
  backfillMs?: number
  /** Entries older than this are dropped when the feed is compacted. */
  retentionMs?: number
  /** Compact the feed once it grows past this many bytes. */
  compactBytes?: number
  /** Clock injection, for tests. */
  now?: () => number
}

export const DEFAULTS = {
  backfillMs: 30 * 60 * 1000,
  retentionMs: 12 * 60 * 60 * 1000,
  compactBytes: 256 * 1024,
}

const MAX_FILES_PER_ENTRY = 20
const MAX_SESSIONS_IN_NOTICE = 8
const MAX_FILES_IN_NOTICE = 40
const MAX_NOTE_CHARS = 600

/** Tools whose successful execution counts as a code change. */
export const EDIT_TOOLS = new Set(["edit", "write", "apply_patch", "patch"])

export function feedPathFor(root: string) {
  const hash = crypto.createHash("sha256").update(root).digest("hex").slice(0, 16)
  return path.join(os.homedir(), ".cache", "opencode", "agent-feed", `${hash}.jsonl`)
}

/**
 * An append-only JSONL log shared by every opencode process running in the
 * same worktree. Writes are single small appends, which the OS keeps atomic at
 * these sizes, so concurrent sessions do not need a lock.
 */
export class Feed {
  readonly file: string
  readonly root: string
  readonly backfillMs: number
  readonly retentionMs: number
  readonly compactBytes: number
  private readonly now: () => number

  constructor(opts: FeedOptions) {
    this.root = opts.root
    this.file = opts.file ?? feedPathFor(opts.root)
    this.backfillMs = opts.backfillMs ?? DEFAULTS.backfillMs
    this.retentionMs = opts.retentionMs ?? DEFAULTS.retentionMs
    this.compactBytes = opts.compactBytes ?? DEFAULTS.compactBytes
    this.now = opts.now ?? Date.now
  }

  async init() {
    await fs.mkdir(path.dirname(this.file), { recursive: true }).catch(() => {})
  }

  /** Make a path relative to the worktree, leaving outside paths untouched. */
  rel(p: string) {
    if (!p) return ""
    try {
      const r = path.relative(this.root, path.resolve(this.root, p))
      return r.startsWith("..") ? p : r
    } catch {
      return p
    }
  }

  /** Pull touched file paths out of an edit tool's arguments. */
  filesOf(args: any): string[] {
    if (!args) return []
    const out: string[] = []
    if (typeof args.filePath === "string") out.push(args.filePath)
    if (typeof args.path === "string") out.push(args.path)
    if (typeof args.patchText === "string") {
      const re = /^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm
      let m: RegExpExecArray | null
      while ((m = re.exec(args.patchText))) out.push((m[1] ?? m[2] ?? "").trim())
    }
    return [...new Set(out.map((p) => this.rel(p)).filter(Boolean))].slice(0, MAX_FILES_PER_ENTRY)
  }

  async read(): Promise<Entry[]> {
    let raw: string
    try {
      raw = await fs.readFile(this.file, "utf8")
    } catch {
      return []
    }
    const out: Entry[] = []
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue
      try {
        const e = JSON.parse(line) as Entry
        if (e && typeof e.ts === "number" && typeof e.session === "string") out.push(e)
      } catch {
        // A torn line from a concurrent writer. Skipping is correct.
      }
    }
    return out
  }

  async append(entry: Entry) {
    const stamped: Entry = {
      ...entry,
      id: entry.id ?? `${entry.ts.toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    }
    try {
      await fs.appendFile(this.file, JSON.stringify(stamped) + "\n")
    } catch {
      return
    }
    await this.compact()
  }

  async compact() {
    try {
      const stat = await fs.stat(this.file)
      if (stat.size < this.compactBytes) return
      const cutoff = this.now() - this.retentionMs
      const kept = (await this.read()).filter((e) => e.ts >= cutoff)
      await fs.writeFile(this.file, kept.map((e) => JSON.stringify(e)).join("\n") + "\n")
    } catch {
      // Best effort. A failed compaction must never break a session.
    }
  }

  /** Entries from other sessions newer than `since`. */
  async since(sessionID: string, since: number) {
    return (await this.read()).filter((e) => e.session !== sessionID && e.ts > since)
  }

  private label(e: Entry) {
    const short = e.session.slice(-6)
    return e.agent ? `${e.agent}/${short}` : short
  }

  private ago(ts: number) {
    const m = Math.max(0, Math.round((this.now() - ts) / 60000))
    return m === 0 ? "just now" : `${m}m ago`
  }

  /** Render entries into a compact, bounded block for the model. */
  render(entries: Entry[]): string {
    const notes = entries.filter((e) => e.kind === "note" && e.note)
    const edits = entries.filter((e) => e.kind !== "note")

    const lines: string[] = []

    for (const n of notes.sort((a, b) => a.ts - b.ts)) {
      lines.push(`- ${this.label(n)} says (${this.ago(n.ts)}): ${n.note!.slice(0, MAX_NOTE_CHARS)}`)
    }

    const bySession = new Map<string, { name: string; files: Set<string>; last: number }>()
    for (const e of edits) {
      const g = bySession.get(e.session) ?? { name: this.label(e), files: new Set<string>(), last: 0 }
      for (const f of e.files ?? []) g.files.add(f)
      g.last = Math.max(g.last, e.ts)
      g.name = this.label(e)
      bySession.set(e.session, g)
    }

    let budget = MAX_FILES_IN_NOTICE
    for (const g of [...bySession.values()].sort((a, b) => b.last - a.last).slice(0, MAX_SESSIONS_IN_NOTICE)) {
      if (g.files.size === 0) continue
      const files = [...g.files]
      const show = files.slice(0, Math.max(1, budget))
      budget -= show.length
      const extra = files.length - show.length
      lines.push(
        `- ${g.name} changed (${this.ago(g.last)}): ${show.join(", ")}${extra > 0 ? ` (+${extra} more)` : ""}`,
      )
      if (budget <= 0) break
    }

    if (lines.length === 0) return ""

    return [
      "<agent-messages>",
      "Other opencode sessions are working in this same worktree. Since your last turn:",
      ...lines,
      "Your knowledge of any file listed above may be stale. Re-read it before editing.",
      "</agent-messages>",
    ].join("\n")
  }
}
