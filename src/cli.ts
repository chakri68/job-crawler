#!/usr/bin/env node
import { spawn } from "node:child_process";
import { runOnce } from "./runner.ts";
import { tailor } from "./tailor.ts";
import { Store } from "./store.ts";
import { loadConfig, projectPath } from "./config.ts";
import { renderJobs, renderSources, renderStatus } from "./ui.ts";
import { runTui } from "./tui.ts";
import { notifyText } from "./notify.ts";

function printHelp(): void {
  console.log(`job-cron — career-page watcher + resume tailoring

Usage:
  job-cron run                 Poll all enabled sources once; alert on new matches.
  job-cron tui                 Interactive browser: jobs + details + source health.
                               (default when no command is given)
  job-cron status              Dashboard: job counts + per-source health.
  job-cron list [n]            Show the n most recently seen jobs (default 50).
  job-cron sources             Show configured sources and their health.
  job-cron tailor <id|url>     Tailor base.json to a stored job and render a PDF.
  job-cron purge [--days N]    Delete stale jobs: not looked at, and gone from
              [--dry-run]      listings for N days (default 7). --dry-run previews.
  job-cron deploy <cmd>        Manage the local hourly systemd timer (no sudo):
                               install | uninstall | status | logs [-f] | run | print.
  job-cron help                Show this help.
`);
}

/** Read a numeric flag like `--days 14`, falling back to a default. */
function numFlag(args: string[], name: string, fallback: number): number {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const v = Number(args[i + 1]);
  return Number.isFinite(v) ? v : fallback;
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "run":
      await runOnce();
      break;
    case "tui":
    case undefined:
      runTui();
      break;
    case "status": {
      const store = new Store();
      const cfg = loadConfig();
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      console.log(
        renderStatus(cfg, store.listSourceState(), store.stats(since)),
      );
      store.close();
      break;
    }
    case "list": {
      const store = new Store();
      const n = rest[0] ? Number(rest[0]) : 50;
      console.log(renderJobs(store.listJobs(n)));
      store.close();
      break;
    }
    case "sources": {
      const store = new Store();
      const cfg = loadConfig();
      console.log(renderSources(cfg, store.listSourceState()));
      store.close();
      break;
    }
    case "tailor": {
      const target = rest[0];
      if (!target) {
        console.error("Usage: job-cron tailor <id|url>");
        process.exitCode = 1;
        return;
      }
      await tailor(target);
      break;
    }
    case "purge": {
      const days = numFlag(rest, "--days", 7);
      const dryRun = rest.includes("--dry-run") || rest.includes("-n");
      const cutoff = new Date(
        Date.now() - days * 24 * 60 * 60 * 1000,
      ).toISOString();
      const store = new Store();
      const victims = store.listPurgeable(cutoff);
      if (victims.length === 0) {
        console.log(
          `Nothing to purge (no un-looked-at jobs gone from listings for ${days}d+).`,
        );
      } else if (dryRun) {
        console.log(
          `[dry-run] ${victims.length} job(s) would be purged (older than ${days}d, not looked at):`,
        );
        for (const j of victims.slice(0, 100)) {
          console.log(
            `  ${j.id}  ${j.company} — ${j.title}  (last seen ${j.last_seen.slice(0, 10)})`,
          );
        }
        if (victims.length > 100)
          console.log(`  …and ${victims.length - 100} more`);
      } else {
        const n = store.purgeJobs(cutoff);
        console.log(
          `Purged ${n} stale job(s) (older than ${days}d, not looked at).`,
        );
      }
      store.close();
      break;
    }
    case "deploy": {
      // Thin wrapper over deploy/job-cron.sh (systemd timer manager).
      const script = projectPath("deploy", "job-cron.sh");
      const code = await new Promise<number>((resolve) => {
        const child = spawn("bash", [script, ...rest], {
          stdio: "inherit",
          env: { ...process.env, JOB_CRON_PROG: "job-cron deploy" },
        });
        child.on("exit", (c) => resolve(c ?? 0));
        child.on("error", (err) => {
          console.error(
            `Failed to run deploy script: ${(err as Error).message}`,
          );
          resolve(1);
        });
      });
      process.exitCode = code;
      break;
    }
    case "_notify": {
      // Internal: push a one-off message through the configured notifier.
      // Used by deploy/job-cron.sh to alert on timer install/uninstall.
      const message = rest.join(" ").trim();
      if (!message) {
        console.error("Usage: job-cron _notify <message>");
        process.exitCode = 1;
        return;
      }
      await notifyText(message, loadConfig().notifier);
      break;
    }
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    default:
      console.error(`Unknown command: ${cmd}\n`);
      printHelp();
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
