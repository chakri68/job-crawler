import chalk from "chalk";
import Table from "cli-table3";
import type { Config, JobRow, SourceStateRow } from "./types.ts";

/** Compact relative time, e.g. "just now", "12m", "3h", "2d", "5w". */
export function relTime(iso: string | null): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff)) return "—";
  const s = Math.floor(diff / 1000);
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d}d ago`;
  return `${Math.floor(d / 7)}w ago`;
}

function truncate(s: string, n: number): string {
  s = s.replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** A borderless, dim-ruled table that lines columns up without visual noise. */
function cleanTable(head: string[]): InstanceType<typeof Table> {
  return new Table({
    head: head.map((h) => chalk.bold.cyan(h)),
    style: { head: [], border: [], "padding-left": 0, "padding-right": 2 },
    chars: {
      top: "",
      "top-mid": "",
      "top-left": "",
      "top-right": "",
      bottom: "",
      "bottom-mid": "",
      "bottom-left": "",
      "bottom-right": "",
      left: "",
      "left-mid": "",
      mid: "",
      "mid-mid": "",
      right: "",
      "right-mid": "",
      middle: "",
    },
  });
}

/** Render the recent-jobs list as an aligned, colorized table. */
export function renderJobs(rows: JobRow[]): string {
  if (rows.length === 0) return chalk.dim("No jobs stored yet. Run `job-cron run` first.");

  const recentCutoff = Date.now() - 24 * 60 * 60 * 1000;
  const table = cleanTable(["", "Company", "Role", "Location", "Seen"]);

  for (const j of rows) {
    const isNew = new Date(j.first_seen).getTime() >= recentCutoff;
    const dot = isNew ? chalk.green("●") : chalk.dim("·");
    const role = `${chalk.white(truncate(j.title, 48))}\n${chalk.dim(j.id)}`;
    table.push([
      dot,
      chalk.bold(truncate(j.company, 18)),
      role,
      chalk.dim(truncate(j.location || "—", 26)),
      chalk.dim(relTime(j.first_seen)),
    ]);
  }

  const newCount = rows.filter(
    (j) => new Date(j.first_seen).getTime() >= recentCutoff,
  ).length;
  const footer = chalk.dim(
    `\n${rows.length} job(s) · ${chalk.green(`${newCount} new`)}${chalk.dim(
      " in last 24h · ● = new · tailor with `job-cron tailor <id>`",
    )}`,
  );
  return table.toString() + footer;
}

/** Describe a source's health from its stored state row. */
function healthLabel(state: SourceStateRow | undefined): string {
  if (!state || !state.last_run) return chalk.dim("not run yet");
  if (state.fail_streak > 0)
    return chalk.red(`failing ×${state.fail_streak}`) + chalk.dim(` (last try ${relTime(state.last_run)})`);
  if (!state.seeded) return chalk.yellow("seeding…");
  return chalk.green("ok") + chalk.dim(` · ${relTime(state.last_ok)}`);
}

function sourceKey(s: Config["sources"][number]): string {
  return s.provider === "custom" ? `custom:${s.customKey}` : `${s.provider}:${s.board}`;
}

/** Render configured sources joined with their stored health. */
export function renderSources(cfg: Config, states: SourceStateRow[]): string {
  const byKey = new Map(states.map((s) => [s.source, s]));
  const table = cleanTable(["", "Source", "Company", "Health"]);

  for (const s of cfg.sources) {
    const key = sourceKey(s);
    const mark = s.enabled ? chalk.green("✓") : chalk.dim("✗");
    table.push([
      mark,
      s.enabled ? chalk.cyan(key) : chalk.dim(key),
      s.enabled ? chalk.bold(s.company) : chalk.dim(s.company),
      s.enabled ? healthLabel(byKey.get(key)) : chalk.dim("disabled"),
    ]);
  }
  return table.toString();
}

/** A full status dashboard: headline counts plus per-source health. */
export function renderStatus(
  cfg: Config,
  states: SourceStateRow[],
  stats: { total: number; notified: number; recent: number },
): string {
  const enabled = cfg.sources.filter((s) => s.enabled);
  const byKey = new Map(states.map((s) => [s.source, s]));
  const okCount = enabled.filter((s) => {
    const st = byKey.get(sourceKey(s));
    return st && st.last_ok && st.fail_streak === 0;
  }).length;
  const failing = enabled.filter((s) => (byKey.get(sourceKey(s))?.fail_streak ?? 0) > 0).length;

  const stat = (label: string, value: string) =>
    `${chalk.bold(value)} ${chalk.dim(label)}`;

  const line = chalk.dim("─".repeat(48));
  const header = [
    chalk.bold.cyan("  job-cron status"),
    line,
    "  " +
      [
        stat("jobs tracked", String(stats.total)),
        stat("alerted", String(stats.notified)),
        stat("new (24h)", chalk.green(String(stats.recent))),
      ].join(chalk.dim("   ·   ")),
    "  " +
      [
        stat("sources", `${enabled.length}/${cfg.sources.length}`),
        stat("healthy", chalk.green(String(okCount))),
        failing > 0 ? stat("failing", chalk.red(String(failing))) : stat("failing", "0"),
      ].join(chalk.dim("   ·   ")),
    line,
  ].join("\n");

  return `${header}\n${renderSources(cfg, states)}`;
}
