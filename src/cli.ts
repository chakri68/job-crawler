#!/usr/bin/env node
import { runOnce } from "./runner.ts";
import { tailor } from "./tailor.ts";
import { Store } from "./store.ts";
import { loadConfig } from "./config.ts";

function printHelp(): void {
  console.log(`job-cron — career-page watcher + resume tailoring

Usage:
  job-cron run                 Poll all enabled sources once; alert on new matches.
  job-cron list [n]            Show the n most recently seen jobs (default 50).
  job-cron sources             Show configured sources.
  job-cron tailor <id|url>     Tailor base.json to a stored job and render a PDF.
  job-cron help                Show this help.
`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "run":
      await runOnce();
      break;
    case "list": {
      const store = new Store();
      const n = rest[0] ? Number(rest[0]) : 50;
      for (const j of store.listJobs(n)) {
        console.log(`${j.id}\n  ${j.company} — ${j.title} (${j.location})\n  ${j.url}\n`);
      }
      store.close();
      break;
    }
    case "sources": {
      const cfg = loadConfig();
      for (const s of cfg.sources) {
        const key = s.provider === "custom" ? `custom:${s.customKey}` : `${s.provider}:${s.board}`;
        console.log(`${s.enabled ? "✓" : "✗"} ${key.padEnd(28)} ${s.company}`);
      }
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
    case "help":
    case "--help":
    case "-h":
    case undefined:
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
