import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Config } from "./types.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function projectPath(...parts: string[]): string {
  return join(ROOT, ...parts);
}

/** Load config.json, falling back to config.example.json. */
export function loadConfig(): Config {
  const real = projectPath("config.json");
  const example = projectPath("config.example.json");
  const path = existsSync(real) ? real : example;
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as Config;
}
