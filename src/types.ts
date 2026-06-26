export type JobPosting = {
  /** fetcher key, e.g. "greenhouse:stripe" */
  source: string;
  company: string;
  /** stable per-source id */
  jobId: string;
  title: string;
  location: string;
  /** apply / detail URL */
  url: string;
  /** fetched lazily, only when tailoring */
  description?: string;
  /** ISO timestamp when we first saw it */
  detectedAt: string;
  postedAt?: string;
  /** the API/page we read it from */
  sourceUrl: string;
};

export type Filters = {
  includeKeywords: string[];
  locationKeywords: string[];
  excludeKeywords: string[];
};

export type NotifierConfig = {
  type: "discord" | "telegram" | "console";
  /** name of the env var holding the webhook URL (for discord) or bot token (for telegram) */
  webhookUrlEnv?: string;
  /** name of the env var holding the target chat id (for telegram) */
  chatIdEnv?: string;
};

export type SourceConfig = {
  /** generic ATS provider, or "custom" for a hand-written fetcher */
  provider: "greenhouse" | "lever" | "ashby" | "custom";
  /** board slug for ATS providers, e.g. "stripe" */
  board?: string;
  /** display name */
  company: string;
  enabled: boolean;
  /** for provider:"custom", the key into the custom fetcher registry */
  customKey?: string;
  /** for provider:"custom", query params passed to the source API/page */
  query?: Record<string, string>;
};

export type Config = {
  notifier: NotifierConfig;
  filters: Filters;
  sources: SourceConfig[];
  /** consecutive failures before a warning alert */
  failStreakAlert: number;
};

/** A stored source-health row (snake_case mirrors the SQLite schema). */
export type SourceStateRow = {
  source: string;
  seeded: number;
  last_run: string | null;
  last_ok: string | null;
  fail_streak: number;
};

/** A stored job row (snake_case mirrors the SQLite schema). */
export type JobRow = {
  id: string;
  source: string;
  company: string;
  title: string;
  location: string;
  url: string;
  posted_at: string | null;
  first_seen: string;
  last_seen: string;
  notified: number;
  looked_at: number;
  dismissed: number;
};
