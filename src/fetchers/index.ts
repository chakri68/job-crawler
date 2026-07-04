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

/**
 * Normalize a source's `query` into a list of query objects. A source may set
 * `query` to a single object (one search) or an array of objects (several
 * searches whose results are merged). Falls back to `fallback` when `query` is
 * absent or an empty array.
 */
function queriesOf(
  cfg: SourceConfig,
  fallback: Record<string, string> = {},
): Record<string, string>[] {
  const q = cfg.query;
  if (Array.isArray(q)) return q.length ? q : [fallback];
  return [q ?? fallback];
}

function stripHtml(html: string | undefined): string {
  if (!html) return "";
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&#x0*27;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) =>
      String.fromCodePoint(parseInt(h, 16)),
    )
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

// ─── SmartRecruiters ─────────────────────────────────────────────────────────
// https://api.smartrecruiters.com/v1/companies/{company}/postings
type SrJob = {
  id: string;
  name: string;
  releasedDate?: string;
  location?: { fullLocation?: string; city?: string; country?: string };
};
type SrListResp = { content?: SrJob[]; totalFound?: number };
type SrDetail = {
  jobAd?: {
    sections?: Record<string, { text?: string }>;
  };
};

function srLocation(loc: SrJob["location"]): string {
  if (!loc) return "";
  if (loc.fullLocation) return loc.fullLocation;
  return [loc.city, loc.country].filter(Boolean).join(", ");
}

function smartrecruiters(cfg: SourceConfig): Fetcher {
  const board = cfg.board!;
  const key = `smartrecruiters:${board}`;
  const api = `https://api.smartrecruiters.com/v1/companies/${board}/postings`;
  const pageSize = 100;
  return {
    key,
    company: cfg.company,
    async fetchJobs() {
      const now = nowIso();
      const jobs: JobPosting[] = [];
      for (let offset = 0; ; offset += pageSize) {
        const url = `${api}?${qs({
          limit: String(pageSize),
          offset: String(offset),
        })}`;
        const data = (await getJson(url)) as SrListResp;
        const batch = data.content ?? [];
        for (const j of batch) {
          jobs.push({
            source: key,
            company: cfg.company,
            jobId: j.id,
            title: j.name,
            location: srLocation(j.location),
            url: `https://jobs.smartrecruiters.com/${board}/${j.id}`,
            detectedAt: now,
            postedAt: j.releasedDate,
            sourceUrl: api,
          });
        }
        const total = data.totalFound ?? jobs.length;
        if (batch.length === 0 || jobs.length >= total) break;
      }
      return jobs;
    },
    async fetchDescription(job) {
      const data = (await getJson(`${api}/${job.jobId}`)) as SrDetail;
      const sections = data.jobAd?.sections ?? {};
      return stripHtml(
        Object.values(sections)
          .map((s) => s.text)
          .filter(Boolean)
          .join(" "),
      );
    },
  };
}

// ─── Workday ─────────────────────────────────────────────────────────────────
// In-house but ubiquitous, so treated as a generic provider. A board is a
// (tenant, datacenter, site) triple, e.g. nvidia / wd5 / NVIDIAExternalCareerSite:
//   { provider: "workday", board: "nvidia",
//     query: { dc: "wd5", site: "NVIDIAExternalCareerSite" } }
//   list:   POST {host}/wday/cxs/{tenant}/{site}/jobs   (paged JSON)
//   detail: GET  {host}/wday/cxs/{tenant}/{site}{externalPath}
type WdJob = {
  title: string;
  externalPath: string;
  locationsText?: string;
  postedOn?: string;
  bulletFields?: string[];
};
type WdListResp = { total?: number; jobPostings?: WdJob[] };
type WdDetail = { jobPostingInfo?: { jobDescription?: string } };

function workday(cfg: SourceConfig): Fetcher {
  const tenant = cfg.board!;
  const queries = queriesOf(cfg);
  // dc/site are structural (they define the endpoint), so they come from the
  // first query that carries them; only searchText/maxPages vary per query.
  const structural = queries.find((q) => q.site) ?? queries[0]!;
  const dc = structural.dc ?? "wd1";
  const site = structural.site;
  if (!site) throw new Error(`workday source "${tenant}" needs query.site`);
  const key = `workday:${tenant}`;
  const host = `https://${tenant}.${dc}.myworkdayjobs.com`;
  const cxs = `${host}/wday/cxs/${tenant}/${site}`;
  const sitePrefix = `${host}/${site}`;
  const pageSize = 20;
  return {
    key,
    company: cfg.company,
    async fetchJobs() {
      const now = nowIso();
      const byId = new Map<string, JobPosting>();
      for (const query of queries) {
        const searchText = query.q ?? "";
        const maxPages = Number(query.maxPages ?? 5);
        let count = 0;
        for (let pg = 0; pg < maxPages; pg++) {
          const res = await fetch(`${cxs}/jobs`, {
            method: "POST",
            headers: {
              "user-agent": UA,
              accept: "application/json",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              limit: pageSize,
              offset: pg * pageSize,
              searchText,
              appliedFacets: {},
            }),
          });
          if (!res.ok) throw new Error(`POST ${cxs}/jobs → ${res.status}`);
          const data = (await res.json()) as WdListResp;
          const batch = data.jobPostings ?? [];
          for (const j of batch) {
            count++;
            const jobId = j.bulletFields?.[0] ?? j.externalPath;
            if (byId.has(jobId)) continue;
            byId.set(jobId, {
              source: key,
              company: cfg.company,
              jobId,
              title: j.title,
              location: j.locationsText ?? "",
              url: `${sitePrefix}${j.externalPath}`,
              detectedAt: now,
              sourceUrl: `${cxs}/jobs`,
            });
          }
          const total = data.total ?? count;
          if (batch.length === 0 || count >= total) break;
        }
      }
      return [...byId.values()];
    },
    async fetchDescription(job) {
      const externalPath = job.url.startsWith(sitePrefix)
        ? job.url.slice(sitePrefix.length)
        : job.url.slice(host.length);
      const data = (await getJson(`${cxs}${externalPath}`)) as WdDetail;
      return stripHtml(data.jobPostingInfo?.jobDescription);
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
  const queries = queriesOf(cfg, { location: "India" });
  return {
    key,
    company: cfg.company,
    async fetchJobs() {
      const now = nowIso();
      const byId = new Map<string, JobPosting>();
      for (const query of queries) {
        const maxPages = Number(query.maxPages ?? 3);
        const locationLabel = query.location ?? "India";
        const { maxPages: _mp, ...rest } = query;
        const found = new Map<string, string>(); // id → slug
        for (let page = 1; page <= maxPages; page++) {
          const url = `${GOOGLE_BASE}?${qs({ ...rest, page: String(page) })}`;
          const html = await getText(url);
          const before = found.size;
          for (const m of html.matchAll(GOOGLE_LINK_RE))
            found.set(m[1]!, m[2]!);
          if (found.size === before) break; // no new jobs on this page
        }
        for (const [id, slug] of found) {
          if (byId.has(id)) continue;
          byId.set(id, {
            source: key,
            company: cfg.company,
            jobId: id,
            title: titleFromSlug(slug),
            location: locationLabel,
            url: `${GOOGLE_BASE}/${id}-${slug}?${qs({ location: locationLabel })}`,
            detectedAt: now,
            sourceUrl: GOOGLE_BASE,
          });
        }
      }
      return [...byId.values()];
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
  const queries = queriesOf(cfg, { lc: "India" });
  return {
    key,
    company: cfg.company,
    async fetchJobs() {
      const now = nowIso();
      const byId = new Map<string, JobPosting>();
      for (const query of queries) {
        const pgSz = Number(query.pgSz ?? 20);
        const maxPages = Number(query.maxPages ?? 3);
        const { pgSz: _ps, maxPages: _mp, ...rest } = query;
        const base: Record<string, string> = {
          l: "en_us",
          o: "Relevance",
          flt: "true",
          pgSz: String(pgSz),
          ...rest,
        };
        let count = 0;
        for (let pg = 1; pg <= maxPages; pg++) {
          const url = `${MS_SEARCH}?${qs({ ...base, pg: String(pg) })}`;
          const data = (await getJson(url)) as MsSearchResp;
          const batch = data.operationResult?.result?.jobs ?? [];
          if (batch.length === 0) break;
          for (const j of batch) {
            count++;
            const jobId = String(j.jobId);
            if (byId.has(jobId)) continue;
            byId.set(jobId, {
              source: key,
              company: cfg.company,
              jobId,
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
          const total = data.operationResult?.result?.totalJobs ?? count;
          if (count >= total) break;
        }
      }
      return [...byId.values()];
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

// ─── Amazon ──────────────────────────────────────────────────────────────────
// Public search JSON behind amazon.jobs. Descriptions ship in the list payload.
//   list: https://www.amazon.jobs/en/search.json?...
// Config query params map onto the search, e.g.
//   "query": { "loc_query": "India", "base_query": "software engineer" }
const AMZN_SEARCH = "https://www.amazon.jobs/en/search.json";
const AMZN_BASE = "https://www.amazon.jobs";

type AmznJob = {
  id_icims: string;
  title: string;
  job_path: string;
  location?: string;
  normalized_location?: string;
  posted_date?: string;
  description?: string;
  basic_qualifications?: string;
  preferred_qualifications?: string;
};
type AmznResp = { jobs?: AmznJob[]; hits?: number };

function amazon(cfg: SourceConfig): Fetcher {
  const key = `custom:${cfg.customKey}`;
  const queries = queriesOf(cfg, { loc_query: "India" });

  // The search list payload is the only reliable source of descriptions —
  // amazon.jobs job pages are client-rendered, so scraping them yields nothing.
  // We page through the configured search and yield the raw jobs.
  async function* searchOne(
    query: Record<string, string>,
  ): AsyncGenerator<AmznJob> {
    const pageSize = Number(query.result_limit ?? 100);
    const maxPages = Number(query.maxPages ?? 3);
    const { result_limit: _rl, maxPages: _mp, ...rest } = query;
    const base: Record<string, string> = {
      sort: "recent",
      result_limit: String(pageSize),
      ...rest,
    };
    for (let pg = 0; pg < maxPages; pg++) {
      const url = `${AMZN_SEARCH}?${qs({
        ...base,
        offset: String(pg * pageSize),
      })}`;
      const batch = ((await getJson(url)) as AmznResp).jobs ?? [];
      for (const j of batch) yield j;
      if (batch.length < pageSize) break;
    }
  }

  async function* search(): AsyncGenerator<AmznJob> {
    for (const query of queries) yield* searchOne(query);
  }

  return {
    key,
    company: cfg.company,
    async fetchJobs() {
      const now = nowIso();
      const byId = new Map<string, JobPosting>();
      for await (const j of search()) {
        const jobId = String(j.id_icims);
        if (byId.has(jobId)) continue;
        byId.set(jobId, {
          source: key,
          company: cfg.company,
          jobId,
          title: j.title,
          location: j.normalized_location ?? j.location ?? "",
          url: `${AMZN_BASE}${j.job_path}`,
          detectedAt: now,
          postedAt: j.posted_date,
          sourceUrl: AMZN_SEARCH,
        });
      }
      return [...byId.values()];
    },
    async fetchDescription(job) {
      for await (const j of search()) {
        if (String(j.id_icims) !== job.jobId) continue;
        return stripHtml(
          [j.description, j.basic_qualifications, j.preferred_qualifications]
            .filter(Boolean)
            .join(" "),
        );
      }
      return "";
    },
  };
}

// ─── Atlassian ───────────────────────────────────────────────────────────────
// Single public listings endpoint returns every posting with descriptions inline
// (no detail fetch, no query params — downstream filters do the narrowing).
//   list: https://www.atlassian.com/endpoint/careers/listings
const ATLASSIAN_LISTINGS =
  "https://www.atlassian.com/endpoint/careers/listings";

type AtlassianJob = {
  id: number;
  title: string;
  locations?: string[];
  category?: string;
  overview?: string;
  responsibilities?: string;
  qualifications?: string;
  applyUrl?: string;
  portalJobPost?: { portalUrl?: string; updatedDate?: string };
};

function atlassian(cfg: SourceConfig): Fetcher {
  const key = `custom:${cfg.customKey}`;
  const getListings = async () =>
    (await getJson(ATLASSIAN_LISTINGS)) as AtlassianJob[];
  return {
    key,
    company: cfg.company,
    async fetchJobs() {
      const now = nowIso();
      return (await getListings()).map((j) => ({
        source: key,
        company: cfg.company,
        jobId: String(j.id),
        title: j.title,
        location: (j.locations ?? []).join(" / "),
        url: j.portalJobPost?.portalUrl ?? j.applyUrl ?? "",
        detectedAt: now,
        postedAt: j.portalJobPost?.updatedDate,
        sourceUrl: ATLASSIAN_LISTINGS,
      }));
    },
    async fetchDescription(job) {
      const found = (await getListings()).find(
        (j) => String(j.id) === job.jobId,
      );
      return stripHtml(
        [found?.overview, found?.responsibilities, found?.qualifications]
          .filter(Boolean)
          .join(" "),
      );
    },
  };
}

// ─── Uber ────────────────────────────────────────────────────────────────────
// In-house JSON search; descriptions ship inline (markdown). Config query, e.g.
//   "query": { "q": "software engineer", "maxPages": "3" }
const UBER_SEARCH =
  "https://www.uber.com/api/loadSearchJobsResults?localeCode=en";

type UberJob = {
  id: number;
  title: string;
  description?: string;
  location?: { city?: string; region?: string; countryName?: string };
  updatedDate?: string;
};
type UberResp = {
  data?: { results?: UberJob[]; totalResults?: { low?: number } };
};

function uberLocation(loc: UberJob["location"]): string {
  if (!loc) return "";
  return [loc.city, loc.region, loc.countryName].filter(Boolean).join(", ");
}

function uber(cfg: SourceConfig): Fetcher {
  const key = `custom:${cfg.customKey}`;
  const queries = queriesOf(cfg);

  // Descriptions are inline in the search payload, so re-page the search and
  // match by id when a description is later requested.
  async function* searchOne(
    query: Record<string, string>,
  ): AsyncGenerator<UberJob> {
    const pageSize = Number(query.limit ?? 100);
    const maxPages = Number(query.maxPages ?? 3);
    for (let page = 0; page < maxPages; page++) {
      const res = await fetch(UBER_SEARCH, {
        method: "POST",
        headers: {
          "user-agent": UA,
          accept: "application/json",
          "content-type": "application/json",
          "x-csrf-token": "x",
        },
        body: JSON.stringify({
          params: { query: query.q ?? "" },
          limit: pageSize,
          page,
        }),
      });
      if (!res.ok) throw new Error(`POST ${UBER_SEARCH} → ${res.status}`);
      const data = (await res.json()) as UberResp;
      const batch = data.data?.results ?? [];
      for (const j of batch) yield j;
      if (batch.length < pageSize) break;
    }
  }

  async function* search(): AsyncGenerator<UberJob> {
    for (const query of queries) yield* searchOne(query);
  }

  return {
    key,
    company: cfg.company,
    async fetchJobs() {
      const now = nowIso();
      const byId = new Map<string, JobPosting>();
      for await (const j of search()) {
        const jobId = String(j.id);
        if (byId.has(jobId)) continue;
        byId.set(jobId, {
          source: key,
          company: cfg.company,
          jobId,
          title: j.title,
          location: uberLocation(j.location),
          url: `https://www.uber.com/careers/list/${j.id}/`,
          detectedAt: now,
          postedAt: j.updatedDate,
          sourceUrl: UBER_SEARCH,
        });
      }
      return [...byId.values()];
    },
    async fetchDescription(job) {
      for await (const j of search()) {
        if (String(j.id) === job.jobId) return stripHtml(j.description);
      }
      return "";
    },
  };
}

// ─── Netflix ─────────────────────────────────────────────────────────────────
// Eightfold-hosted board. The list omits descriptions; the per-job endpoint
// fills `job_description`. Config query, e.g. "query": { "q": "engineer" }.
//   list:   https://explore.jobs.netflix.net/api/apply/v2/jobs?domain=netflix.com&start=&num=&query=
//   detail: https://explore.jobs.netflix.net/api/apply/v2/jobs/{id}?domain=netflix.com
const NETFLIX_API = "https://explore.jobs.netflix.net/api/apply/v2/jobs";
const NETFLIX_DOMAIN = "netflix.com";

type NetflixJob = {
  id: number;
  name: string;
  location?: string;
  locations?: string[];
  t_update?: number;
  canonicalPositionUrl?: string;
  job_description?: string;
};
type NetflixResp = { positions?: NetflixJob[]; count?: number };

function netflix(cfg: SourceConfig): Fetcher {
  const key = `custom:${cfg.customKey}`;
  const queries = queriesOf(cfg);
  return {
    key,
    company: cfg.company,
    async fetchJobs() {
      const now = nowIso();
      const byId = new Map<string, JobPosting>();
      for (const query of queries) {
        const pageSize = Number(query.num ?? 100);
        const maxPages = Number(query.maxPages ?? 3);
        let count = 0;
        for (let pg = 0; pg < maxPages; pg++) {
          const url = `${NETFLIX_API}?${qs({
            domain: NETFLIX_DOMAIN,
            start: String(pg * pageSize),
            num: String(pageSize),
            query: query.q ?? "",
          })}`;
          const data = (await getJson(url)) as NetflixResp;
          const batch = data.positions ?? [];
          for (const j of batch) {
            count++;
            const jobId = String(j.id);
            if (byId.has(jobId)) continue;
            byId.set(jobId, {
              source: key,
              company: cfg.company,
              jobId,
              title: j.name,
              location: j.location ?? (j.locations ?? []).join(" / "),
              url:
                j.canonicalPositionUrl ??
                `https://explore.jobs.netflix.net/careers/job/${j.id}`,
              detectedAt: now,
              postedAt: j.t_update
                ? new Date(j.t_update * 1000).toISOString()
                : undefined,
              sourceUrl: NETFLIX_API,
            });
          }
          const total = data.count ?? count;
          if (batch.length === 0 || count >= total) break;
        }
      }
      return [...byId.values()];
    },
    async fetchDescription(job) {
      const data = (await getJson(
        `${NETFLIX_API}/${job.jobId}?${qs({ domain: NETFLIX_DOMAIN })}`,
      )) as NetflixJob & NetflixResp;
      const desc = data.job_description ?? data.positions?.[0]?.job_description;
      return stripHtml(desc);
    },
  };
}

/**
 * Registry for hand-written custom fetchers (in-house sources that aren't a
 * generic ATS). Add entries here and reference them via
 * { provider: "custom", customKey: "..." } in config.
 */
const CUSTOM: Record<string, (cfg: SourceConfig) => Fetcher> = {
  google,
  microsoft,
  amazon,
  atlassian,
  uber,
  netflix,
};

export function buildFetcher(cfg: SourceConfig): Fetcher {
  switch (cfg.provider) {
    case "greenhouse":
      return greenhouse(cfg);
    case "lever":
      return lever(cfg);
    case "ashby":
      return ashby(cfg);
    case "smartrecruiters":
      return smartrecruiters(cfg);
    case "workday":
      return workday(cfg);
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
