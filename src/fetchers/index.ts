import type { JobPosting, SourceConfig } from "../types.ts";
import { nowIso } from "../util.ts";

export interface Fetcher {
  key: string;
  company: string;
  fetchJobs(): Promise<JobPosting[]>;
  /** Lazily fetch the full job description for tailoring. */
  fetchDescription(job: JobPosting): Promise<string>;
}

const UA = "job-cron/0.1 (+https://github.com/chakri68/job-cron)";

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "application/json" },
  });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.json();
}

async function getText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "user-agent": UA } });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.text();
}

function qs(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

function stripHtml(html: string | undefined): string {
  if (!html) return "";
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Greenhouse ──────────────────────────────────────────────────────────────
// https://boards-api.greenhouse.io/v1/boards/{board}/jobs?content=true
type GhJob = {
  id: number;
  title: string;
  absolute_url: string;
  location?: { name?: string };
  updated_at?: string;
  content?: string;
};

function greenhouse(cfg: SourceConfig): Fetcher {
  const board = cfg.board!;
  const key = `greenhouse:${board}`;
  const listUrl = `https://boards-api.greenhouse.io/v1/boards/${board}/jobs?content=true`;
  return {
    key,
    company: cfg.company,
    async fetchJobs() {
      const data = (await getJson(listUrl)) as { jobs?: GhJob[] };
      const now = nowIso();
      return (data.jobs ?? []).map((j) => ({
        source: key,
        company: cfg.company,
        jobId: String(j.id),
        title: j.title,
        location: j.location?.name ?? "",
        url: j.absolute_url,
        detectedAt: now,
        postedAt: j.updated_at,
        sourceUrl: listUrl,
      }));
    },
    async fetchDescription(job) {
      const data = (await getJson(
        `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${job.jobId}`,
      )) as GhJob;
      return stripHtml(data.content);
    },
  };
}

// ─── Lever ───────────────────────────────────────────────────────────────────
// https://api.lever.co/v0/postings/{board}?mode=json
type LeverJob = {
  id: string;
  text: string;
  hostedUrl: string;
  categories?: { location?: string };
  createdAt?: number;
  descriptionPlain?: string;
};

function lever(cfg: SourceConfig): Fetcher {
  const board = cfg.board!;
  const key = `lever:${board}`;
  const listUrl = `https://api.lever.co/v0/postings/${board}?mode=json`;
  return {
    key,
    company: cfg.company,
    async fetchJobs() {
      const data = (await getJson(listUrl)) as LeverJob[];
      const now = nowIso();
      return data.map((j) => ({
        source: key,
        company: cfg.company,
        jobId: j.id,
        title: j.text,
        location: j.categories?.location ?? "",
        url: j.hostedUrl,
        detectedAt: now,
        postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : undefined,
        sourceUrl: listUrl,
      }));
    },
    async fetchDescription(job) {
      const data = (await getJson(
        `https://api.lever.co/v0/postings/${board}/${job.jobId}?mode=json`,
      )) as LeverJob;
      return stripHtml(data.descriptionPlain);
    },
  };
}

// ─── Ashby ───────────────────────────────────────────────────────────────────
// https://api.ashbyhq.com/posting-api/job-board/{board}
type AshbyJob = {
  id: string;
  title: string;
  location?: string;
  jobUrl: string;
  publishedAt?: string;
  descriptionPlain?: string;
};

function ashby(cfg: SourceConfig): Fetcher {
  const board = cfg.board!;
  const key = `ashby:${board}`;
  const listUrl = `https://api.ashbyhq.com/posting-api/job-board/${board}`;
  return {
    key,
    company: cfg.company,
    async fetchJobs() {
      const data = (await getJson(listUrl)) as { jobs?: AshbyJob[] };
      const now = nowIso();
      return (data.jobs ?? []).map((j) => ({
        source: key,
        company: cfg.company,
        jobId: j.id,
        title: j.title,
        location: j.location ?? "",
        url: j.jobUrl,
        detectedAt: now,
        postedAt: j.publishedAt,
        sourceUrl: listUrl,
      }));
    },
    async fetchDescription(job) {
      // Ashby's list endpoint already includes descriptions; refetch and match.
      const data = (await getJson(listUrl)) as { jobs?: AshbyJob[] };
      const found = data.jobs?.find((j) => j.id === job.jobId);
      return stripHtml(found?.descriptionPlain);
    },
  };
}

// ─── Google ──────────────────────────────────────────────────────────────────
// Google retired its public jobs JSON API; the careers results page is
// server-rendered, so we extract the job links from that HTML (no browser
// needed). Each listing is `.../jobs/results/{id}-{slug}`. Titles are derived
// from the slug; the real title/location are refined lazily in fetchDescription.
// Config query params map straight onto the results URL, e.g.
//   "query": { "location": "India", "q": "software engineer", "target_level": "EARLY" }
const GOOGLE_BASE =
  "https://www.google.com/about/careers/applications/u/0/jobs/results";
const GOOGLE_LINK_RE = /jobs\/results\/(\d+)-([a-z0-9-]+)(?:\?|")/g;

function titleFromSlug(slug: string): string {
  return slug
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bIi\b/g, "II")
    .replace(/\bIii\b/g, "III");
}

function google(cfg: SourceConfig): Fetcher {
  const key = `custom:${cfg.customKey}`;
  const query = cfg.query ?? { location: "India" };
  const maxPages = Number(query.maxPages ?? 3);
  const locationLabel = query.location ?? "India";
  return {
    key,
    company: cfg.company,
    async fetchJobs() {
      const now = nowIso();
      const found = new Map<string, string>(); // id → slug
      for (let page = 1; page <= maxPages; page++) {
        const { maxPages: _mp, ...rest } = query;
        const url = `${GOOGLE_BASE}?${qs({ ...rest, page: String(page) })}`;
        const html = await getText(url);
        const before = found.size;
        for (const m of html.matchAll(GOOGLE_LINK_RE)) found.set(m[1]!, m[2]!);
        if (found.size === before) break; // no new jobs on this page
      }
      return [...found].map(([id, slug]) => ({
        source: key,
        company: cfg.company,
        jobId: id,
        title: titleFromSlug(slug),
        location: locationLabel,
        url: `${GOOGLE_BASE}${id}-${slug}?${qs({ location: locationLabel })}`,
        detectedAt: now,
        sourceUrl: GOOGLE_BASE,
      }));
    },
    async fetchDescription(job) {
      return stripHtml(await getText(job.url));
    },
  };
}

// ─── Microsoft ───────────────────────────────────────────────────────────────
// In-house JSON backend behind jobs.careers.microsoft.com.
//   list:   gcsservices.careers.microsoft.com/search/api/v1/search?...
//   detail: gcsservices.careers.microsoft.com/search/api/v1/job/{jobId}?lang=en_us
// Config query params, e.g. "query": { "lc": "India", "q": "software engineer" }.
const MS_SEARCH =
  "https://gcsservices.careers.microsoft.com/search/api/v1/search";
const MS_JOB = "https://gcsservices.careers.microsoft.com/search/api/v1/job";
const MS_APPLY = "https://jobs.careers.microsoft.com/global/en/job";

type MsJob = {
  jobId: string;
  title: string;
  postingDate?: string;
  properties?: {
    primaryLocation?: string;
    locations?: string[];
    description?: string;
  };
};
type MsSearchResp = {
  operationResult?: { result?: { jobs?: MsJob[]; totalJobs?: number } };
};
type MsJobResp = {
  operationResult?: {
    result?: {
      description?: string;
      responsibilities?: string;
      qualifications?: string;
    };
  };
};

function microsoft(cfg: SourceConfig): Fetcher {
  const key = `custom:${cfg.customKey}`;
  const query = cfg.query ?? { lc: "India" };
  const pgSz = Number(query.pgSz ?? 20);
  const maxPages = Number(query.maxPages ?? 3);
  return {
    key,
    company: cfg.company,
    async fetchJobs() {
      const now = nowIso();
      const { pgSz: _ps, maxPages: _mp, ...rest } = query;
      const base: Record<string, string> = {
        l: "en_us",
        o: "Relevance",
        flt: "true",
        pgSz: String(pgSz),
        ...rest,
      };
      const jobs: JobPosting[] = [];
      for (let pg = 1; pg <= maxPages; pg++) {
        const url = `${MS_SEARCH}?${qs({ ...base, pg: String(pg) })}`;
        const data = (await getJson(url)) as MsSearchResp;
        const batch = data.operationResult?.result?.jobs ?? [];
        if (batch.length === 0) break;
        for (const j of batch) {
          jobs.push({
            source: key,
            company: cfg.company,
            jobId: String(j.jobId),
            title: j.title,
            location:
              j.properties?.primaryLocation ??
              j.properties?.locations?.[0] ??
              "",
            url: `${MS_APPLY}/${j.jobId}`,
            detectedAt: now,
            postedAt: j.postingDate,
            sourceUrl: MS_SEARCH,
          });
        }
        const total = data.operationResult?.result?.totalJobs ?? jobs.length;
        if (jobs.length >= total) break;
      }
      return jobs;
    },
    async fetchDescription(job) {
      const data = (await getJson(
        `${MS_JOB}/${job.jobId}?lang=en_us`,
      )) as MsJobResp;
      const r = data.operationResult?.result ?? {};
      return stripHtml(
        [r.description, r.responsibilities, r.qualifications]
          .filter(Boolean)
          .join(" "),
      );
    },
  };
}

/**
 * Registry for hand-written custom fetchers (Google/Microsoft/Amazon in-house
 * sources). Add entries here and reference them via
 * { provider: "custom", customKey: "..." } in config.
 */
const CUSTOM: Record<string, (cfg: SourceConfig) => Fetcher> = {
  google,
  microsoft,
};

export function buildFetcher(cfg: SourceConfig): Fetcher {
  switch (cfg.provider) {
    case "greenhouse":
      return greenhouse(cfg);
    case "lever":
      return lever(cfg);
    case "ashby":
      return ashby(cfg);
    case "custom": {
      const make = cfg.customKey ? CUSTOM[cfg.customKey] : undefined;
      if (!make) throw new Error(`Unknown custom fetcher: ${cfg.customKey}`);
      return make(cfg);
    }
    default:
      throw new Error(`Unknown provider: ${(cfg as SourceConfig).provider}`);
  }
}

export function buildFetchers(sources: SourceConfig[]): Fetcher[] {
  return sources.filter((s) => s.enabled).map(buildFetcher);
}
