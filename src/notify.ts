import type { JobPosting, NotifierConfig } from "./types.ts";
import { jobKey, prettyTime } from "./util.ts";
import { log } from "./logger.ts";

function formatBatch(company: string, jobs: JobPosting[]): string {
  if (jobs.length === 1) {
    const j = jobs[0]!;
    return [
      `🚨 New ${company} job`,
      "",
      j.title,
      j.location,
      `Detected: ${prettyTime(j.detectedAt)}`,
      `id: ${jobKey(j)}`,
      "",
      `Apply: ${j.url}`,
      `Tailor: job-cron tailor ${jobKey(j)}`,
    ].join("\n");
  }
  const lines = [`🚨 ${jobs.length} new ${company} jobs`, ""];
  jobs.forEach((j, i) => {
    lines.push(
      `${i + 1}. ${j.title}`,
      `   ${j.location}`,
      `   ${j.url}`,
      `   tailor: job-cron tailor ${jobKey(j)}`,
      "",
    );
  });
  return lines.join("\n");
}

async function sendDiscord(content: string, webhookUrl: string): Promise<void> {
  // Discord caps content at 2000 chars.
  const body = content.length > 1900 ? content.slice(0, 1900) + "\n…" : content;
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: body }),
  });
  if (!res.ok) {
    throw new Error(`Discord webhook failed: ${res.status} ${await res.text()}`);
  }
}

/** Send one alert per source-batch. */
export async function notify(
  company: string,
  jobs: JobPosting[],
  cfg: NotifierConfig,
): Promise<void> {
  if (jobs.length === 0) return;
  const message = formatBatch(company, jobs);

  if (cfg.type === "console") {
    log.info(`(console notifier)\n${message}`);
    return;
  }

  const webhookUrl = cfg.webhookUrlEnv ? process.env[cfg.webhookUrlEnv] : undefined;
  if (!webhookUrl) {
    log.warn(
      `notifier is "${cfg.type}" but env ${cfg.webhookUrlEnv} is unset — printing instead:\n${message}`,
    );
    return;
  }
  if (cfg.type === "discord") await sendDiscord(message, webhookUrl);
}

/** A plain text health/warning message (no job batching). */
export async function notifyText(text: string, cfg: NotifierConfig): Promise<void> {
  if (cfg.type === "console") {
    log.info(`(console notifier) ${text}`);
    return;
  }
  const webhookUrl = cfg.webhookUrlEnv ? process.env[cfg.webhookUrlEnv] : undefined;
  if (!webhookUrl) {
    log.warn(`${text} (no webhook configured)`);
    return;
  }
  if (cfg.type === "discord") await sendDiscord(text, webhookUrl);
}
