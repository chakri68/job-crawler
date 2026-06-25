import { createHash } from "node:crypto";

export function sha1(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 16);
}

/** Stable id for a job: prefer the official id, else hash identifying fields. */
export function jobKey(job: {
  source: string;
  jobId?: string;
  company: string;
  title: string;
  location: string;
  url: string;
}): string {
  if (job.jobId) return `${job.source}:${job.jobId}`;
  return `${job.source}:${sha1(`${job.company}:${job.title}:${job.location}:${job.url}`)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** "25 Jun 2026, 11:30 AM" style for alerts. */
export function prettyTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

export function lower(s: string | undefined | null): string {
  return (s ?? "").toLowerCase();
}
