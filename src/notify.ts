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

/** Escape text for Telegram HTML parse mode. */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escape a value for use inside an HTML attribute (e.g. href). */
function escAttr(s: string): string {
  return esc(s).replace(/"/g, "&quot;");
}

/** Telegram-flavored message (HTML parse mode): bold titles, clickable links. */
function formatBatchTelegram(company: string, jobs: JobPosting[]): string {
  if (jobs.length === 1) {
    const j = jobs[0]!;
    return [
      `🚨 <b>New ${esc(company)} job</b>`,
      "",
      `<b>${esc(j.title)}</b>`,
      `📍 ${esc(j.location)}`,
      `🕒 ${esc(prettyTime(j.detectedAt))}`,
      "",
      `🔗 <a href="${escAttr(j.url)}">Apply now</a>`,
      `💡 Tailor: <code>job-cron tailor ${esc(jobKey(j))}</code>`,
    ].join("\n");
  }
  const lines = [`🚨 <b>${jobs.length} new ${esc(company)} jobs</b>`, ""];
  jobs.forEach((j, i) => {
    lines.push(
      `<b>${i + 1}.</b> <a href="${escAttr(j.url)}">${esc(j.title)}</a>`,
      `📍 ${esc(j.location)}`,
      `💡 <code>job-cron tailor ${esc(jobKey(j))}</code>`,
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
    throw new Error(
      `Discord webhook failed: ${res.status} ${await res.text()}`,
    );
  }
}

async function sendTelegram(
  content: string,
  botToken: string,
  chatId: string,
  parseMode?: "HTML",
): Promise<void> {
  // Telegram caps a single message at 4096 chars.
  const body = content.length > 4000 ? content.slice(0, 4000) + "\n…" : content;
  const res = await fetch(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: body,
        disable_web_page_preview: true,
        ...(parseMode ? { parse_mode: parseMode } : {}),
      }),
    },
  );
  if (!res.ok) {
    throw new Error(`Telegram API failed: ${res.status} ${await res.text()}`);
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

  const webhookUrl = cfg.webhookUrlEnv
    ? process.env[cfg.webhookUrlEnv]
    : undefined;
  if (!webhookUrl) {
    log.warn(
      `notifier is "${cfg.type}" but env ${cfg.webhookUrlEnv} is unset — printing instead:\n${message}`,
    );
    return;
  }
  if (cfg.type === "discord") await sendDiscord(message, webhookUrl);
  if (cfg.type === "telegram") {
    const chatId = cfg.chatIdEnv ? process.env[cfg.chatIdEnv] : undefined;
    if (!chatId) {
      log.warn(
        `notifier is "telegram" but env ${cfg.chatIdEnv} is unset — printing instead:\n${message}`,
      );
      return;
    }
    await sendTelegram(
      formatBatchTelegram(company, jobs),
      webhookUrl,
      chatId,
      "HTML",
    );
  }
}

/** A plain text health/warning message (no job batching). */
export async function notifyText(
  text: string,
  cfg: NotifierConfig,
): Promise<void> {
  if (cfg.type === "console") {
    log.info(`(console notifier) ${text}`);
    return;
  }
  const webhookUrl = cfg.webhookUrlEnv
    ? process.env[cfg.webhookUrlEnv]
    : undefined;
  if (!webhookUrl) {
    log.warn(`${text} (no webhook configured)`);
    return;
  }
  if (cfg.type === "discord") await sendDiscord(text, webhookUrl);
  if (cfg.type === "telegram") {
    const chatId = cfg.chatIdEnv ? process.env[cfg.chatIdEnv] : undefined;
    if (!chatId) {
      log.warn(`${text} (no telegram chat id configured)`);
      return;
    }
    await sendTelegram(text, webhookUrl, chatId);
  }
}
