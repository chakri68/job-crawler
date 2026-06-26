import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { projectPath } from "./config.ts";
import { jobKey, nowIso } from "./util.ts";
import type { JobPosting, JobRow, SourceStateRow } from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL,
  company     TEXT NOT NULL,
  title       TEXT NOT NULL,
  location    TEXT,
  url         TEXT NOT NULL,
  posted_at   TEXT,
  first_seen  TEXT NOT NULL,
  last_seen   TEXT NOT NULL,
  notified    INTEGER NOT NULL DEFAULT 0,
  looked_at   INTEGER NOT NULL DEFAULT 0,
  dismissed   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS source_state (
  source      TEXT PRIMARY KEY,
  seeded      INTEGER NOT NULL DEFAULT 0,
  last_run    TEXT,
  last_ok     TEXT,
  fail_streak INTEGER NOT NULL DEFAULT 0
);
`;

export class Store {
  private db: DatabaseSync;

  constructor(dbPath = projectPath("data", "jobs.db")) {
    mkdirSync(projectPath("data"), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Add columns introduced after a DB was first created. */
  private migrate(): void {
    const cols = this.db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "looked_at")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN looked_at INTEGER NOT NULL DEFAULT 0");
    }
    if (!cols.some((c) => c.name === "dismissed")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN dismissed INTEGER NOT NULL DEFAULT 0");
    }
  }

  isSeeded(source: string): boolean {
    const row = this.db
      .prepare("SELECT seeded FROM source_state WHERE source = ?")
      .get(source) as { seeded: number } | undefined;
    return !!row && row.seeded === 1;
  }

  markSeeded(source: string): void {
    this.db
      .prepare(
        `INSERT INTO source_state (source, seeded) VALUES (?, 1)
         ON CONFLICT(source) DO UPDATE SET seeded = 1`,
      )
      .run(source);
  }

  /** Split jobs into already-seen vs new; record all of them either way. */
  partitionUnseen(jobs: JobPosting[]): { fresh: JobPosting[]; seen: JobPosting[] } {
    const fresh: JobPosting[] = [];
    const seen: JobPosting[] = [];
    const now = nowIso();
    const exists = this.db.prepare("SELECT id FROM jobs WHERE id = ?");
    const touch = this.db.prepare("UPDATE jobs SET last_seen = ? WHERE id = ?");
    const insert = this.db.prepare(
      `INSERT INTO jobs (id, source, company, title, location, url, posted_at, first_seen, last_seen, notified)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    );
    for (const job of jobs) {
      const id = jobKey(job);
      if (exists.get(id)) {
        touch.run(now, id);
        seen.push(job);
      } else {
        insert.run(
          id,
          job.source,
          job.company,
          job.title,
          job.location,
          job.url,
          job.postedAt ?? null,
          now,
          now,
        );
        fresh.push(job);
      }
    }
    return { fresh, seen };
  }

  markNotified(ids: string[]): void {
    const stmt = this.db.prepare("UPDATE jobs SET notified = 1 WHERE id = ?");
    for (const id of ids) stmt.run(id);
  }

  /** Mark a job as engaged with (you ran `tailor` on it) — exempts it from purge. */
  markLookedAt(id: string): void {
    this.db.prepare("UPDATE jobs SET looked_at = 1 WHERE id = ?").run(id);
  }

  /**
   * Jobs eligible for purge: not looked at, and not seen in any poll since
   * `cutoffIso` (i.e. they've dropped off the career page, so deleting them
   * won't cause a re-alert). Oldest first.
   */
  listPurgeable(cutoffIso: string): JobRow[] {
    return this.db
      .prepare(
        "SELECT * FROM jobs WHERE looked_at = 0 AND last_seen < ? ORDER BY last_seen ASC",
      )
      .all(cutoffIso) as JobRow[];
  }

  /** Delete purgeable jobs (see listPurgeable); returns how many were removed. */
  purgeJobs(cutoffIso: string): number {
    const res = this.db
      .prepare("DELETE FROM jobs WHERE looked_at = 0 AND last_seen < ?")
      .run(cutoffIso);
    return Number(res.changes);
  }

  /**
   * Soft-delete a job: keep the row as a tombstone (so future polls treat it as
   * already-seen and never re-alert) but hide it from listings. Returns true if
   * a row was updated.
   */
  dismissJob(id: string): boolean {
    const res = this.db.prepare("UPDATE jobs SET dismissed = 1 WHERE id = ?").run(id);
    return Number(res.changes) > 0;
  }

  recordOk(source: string): void {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO source_state (source, last_run, last_ok, fail_streak) VALUES (?, ?, ?, 0)
         ON CONFLICT(source) DO UPDATE SET last_run = ?, last_ok = ?, fail_streak = 0`,
      )
      .run(source, now, now, now, now);
  }

  /** Increment fail streak, return the new streak value. */
  recordFail(source: string): number {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO source_state (source, last_run, fail_streak) VALUES (?, ?, 1)
         ON CONFLICT(source) DO UPDATE SET last_run = ?, fail_streak = fail_streak + 1`,
      )
      .run(source, now, now);
    const row = this.db
      .prepare("SELECT fail_streak FROM source_state WHERE source = ?")
      .get(source) as { fail_streak: number };
    return row.fail_streak;
  }

  getJob(id: string): JobRow | undefined {
    return this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as
      | JobRow
      | undefined;
  }

  /** Find a job by id, or by exact apply URL as a fallback. */
  findJob(idOrUrl: string): JobRow | undefined {
    return (
      this.getJob(idOrUrl) ??
      (this.db.prepare("SELECT * FROM jobs WHERE url = ?").get(idOrUrl) as
        | JobRow
        | undefined)
    );
  }

  listJobs(limit = 50): JobRow[] {
    return this.db
      .prepare("SELECT * FROM jobs WHERE dismissed = 0 ORDER BY first_seen DESC LIMIT ?")
      .all(limit) as JobRow[];
  }

  /** All source-health rows, most recently run first. */
  listSourceState(): SourceStateRow[] {
    return this.db
      .prepare("SELECT * FROM source_state ORDER BY last_run DESC")
      .all() as SourceStateRow[];
  }

  /** Headline counts for the status dashboard. */
  stats(sinceIso: string): { total: number; notified: number; recent: number } {
    const total = this.db
      .prepare("SELECT COUNT(*) c FROM jobs WHERE dismissed = 0")
      .get() as { c: number };
    const notified = this.db
      .prepare("SELECT COUNT(*) c FROM jobs WHERE notified = 1 AND dismissed = 0")
      .get() as { c: number };
    const recent = this.db
      .prepare("SELECT COUNT(*) c FROM jobs WHERE first_seen >= ? AND dismissed = 0")
      .get(sinceIso) as { c: number };
    return { total: total.c, notified: notified.c, recent: recent.c };
  }

  close(): void {
    this.db.close();
  }
}
