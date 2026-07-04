import { loadConfig } from "./config.ts";
import { Store } from "./store.ts";
import { buildFetchers } from "./fetchers/index.ts";
import { filterJobs } from "./filters.ts";
import { notify, notifyText } from "./notify.ts";
import { log } from "./logger.ts";

export async function runOnce(): Promise<void> {
  const config = loadConfig();
  const store = new Store();
  const fetchers = buildFetchers(config.sources);

  if (fetchers.length === 0) {
    log.warn("No enabled sources in config — nothing to do.");
    store.close();
    return;
  }

  let totalNew = 0;
  let failures = 0;

  for (const fetcher of fetchers) {
    try {
      const jobs = await fetcher.fetchJobs();
      if (jobs.length === 0) {
        // Zero parsed jobs is suspicious (likely a structure change), not "no jobs".
        log.warn(`${fetcher.key}: parsed 0 jobs — possible source change.`);
      }
      const matched = filterJobs(jobs, config.filters);
      const { fresh } = store.partitionUnseen(matched);

      if (!store.isSeeded(fetcher.key)) {
        store.markSeeded(fetcher.key);
        log.info(
          `${fetcher.key}: seeded ${matched.length} existing matches (no alerts on first run).`,
        );
      } else if (fresh.length > 0) {
        await notify(fetcher.company, fresh, config.notifier);
        store.markNotified(fresh.map((j) => `${j.source}:${j.jobId}`));
        totalNew += fresh.length;
        log.info(`${fetcher.key}: ${fresh.length} new — alerted.`);
      } else {
        log.info(
          `${fetcher.key}: ${jobs.length} jobs, ${matched.length} match, 0 new.`,
        );
      }
      store.recordOk(fetcher.key);
    } catch (err) {
      failures++;
      const streak = store.recordFail(fetcher.key);
      const e = err as Error & { cause?: { code?: string } };
      const detail = e.cause?.code
        ? `${e.message} (${e.cause.code})`
        : e.message;
      log.error(`${fetcher.key}: fetch failed (streak ${streak}): ${detail}`);
      if (streak >= config.failStreakAlert) {
        await notifyText(
          `⚠️ Job Watcher: ${fetcher.key} failed ${streak} times in a row.\nReason: ${
            (err as Error).message
          }`,
          config.notifier,
        ).catch(() => {});
      }
    }
  }

  log.info(
    `Run complete: ${fetchers.length} sources, ${totalNew} new alert(s), ${failures} failure(s).`,
  );
  store.close();
}
