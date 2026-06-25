import type { Filters, JobPosting } from "./types.ts";
import { lower } from "./util.ts";

/** True if `haystack` contains any of the keywords (case-insensitive). */
function containsAny(haystack: string, keywords: string[]): boolean {
  const h = lower(haystack);
  return keywords.some((k) => h.includes(lower(k)));
}

/**
 * A job matches when:
 *  - its title contains an include keyword, AND
 *  - its location contains a location keyword (or no location filter set), AND
 *  - its title contains NO exclude keyword.
 */
export function matches(job: JobPosting, filters: Filters): boolean {
  const title = job.title;
  const loc = `${job.location} ${job.title}`; // some sources fold location into title

  if (filters.excludeKeywords.length && containsAny(title, filters.excludeKeywords)) {
    return false;
  }
  if (filters.includeKeywords.length && !containsAny(title, filters.includeKeywords)) {
    return false;
  }
  if (filters.locationKeywords.length && !containsAny(loc, filters.locationKeywords)) {
    return false;
  }
  return true;
}

export function filterJobs(jobs: JobPosting[], filters: Filters): JobPosting[] {
  return jobs.filter((j) => matches(j, filters));
}
