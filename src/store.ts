import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { projectPath } from "./config.ts";
import { jobKey, nowIso } from "./util.ts";
import type { JobPosting, JobRow } from "./types.ts";

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
  notified    INTEGER NOT NULL DEFAULT 0
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
      .prepare("SELECT * FROM jobs ORDER BY first_seen DESC LIMIT ?")
      .all(limit) as JobRow[];
  }

  close(): void {
    this.db.close();
  }
}
