import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { projectPath } from "./config.ts";
import { Store } from "./store.ts";
import { buildFetcher } from "./fetchers/index.ts";
import { loadConfig } from "./config.ts";
import { log } from "./logger.ts";
import type { JobPosting, JobRow, SourceConfig } from "./types.ts";

/** Reconstruct a JobPosting from a stored row (jobId is the id minus its source prefix). */
function rowToPosting(row: JobRow): JobPosting {
  const jobId = row.id.startsWith(`${row.source}:`)
    ? row.id.slice(row.source.length + 1)
    : row.id;
  return {
    source: row.source,
    company: row.company,
    jobId,
    title: row.title,
    location: row.location ?? "",
    url: row.url,
    detectedAt: row.first_seen,
    postedAt: row.posted_at ?? undefined,
    sourceUrl: row.url,
  };
}

type Resume = Record<string, unknown> & {
  experience?: Array<{ company?: string }>;
  education?: { institution?: string };
};

// Real JSON→PDF CLI: `resume-to-pdf <input.json> -o <output.pdf>`.
// Override with RESUME_PDF_CLI (e.g. to fall back to ./bin/resume-pdf.mjs).
const PDF_CLI = process.env.RESUME_PDF_CLI ?? "resume-to-pdf";

function readBaseResume(): Resume {
  return JSON.parse(
    readFileSync(projectPath("resumes", "base.json"), "utf8"),
  ) as Resume;
}

function buildPrompt(base: Resume, job: JobRow, description: string): string {
  return `You are tailoring a resume to a specific job. You will be given a BASE
resume as JSON and a JOB description. Produce a tailored resume.

HARD RULES — these are absolute:
- Output ONLY a single valid JSON object. No prose, no markdown, no code fences.
- Use the EXACT SAME JSON schema/shape as the base resume (same keys, same nesting).
- Use ONLY facts present in the base resume. Do NOT invent or alter any employer,
  job title, date, school, metric, or skill. Every company, role, and date in your
  output MUST already exist in the base resume.
- You MAY: reorder experience/projects/skills to surface what's most relevant to the
  job; rewrite the "summary" text and achievement bullets to mirror the job's language
  and emphasis; drop or de-emphasize clearly irrelevant projects.
- You may NOT add new experience entries, new employers, or new factual claims.

JOB:
Company: ${job.company}
Title: ${job.title}
Location: ${job.location}
Description:
${description.slice(0, 6000)}

BASE RESUME (JSON):
${JSON.stringify(base)}

Return the tailored resume JSON now.`;
}

/** Run `claude -p`, feeding the prompt on stdin, return the model's text result. */
function runClaude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["-p", "--output-format", "json"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${err}`));
      try {
        const envelope = JSON.parse(out) as {
          result?: string;
          is_error?: boolean;
        };
        if (envelope.is_error || typeof envelope.result !== "string") {
          return reject(
            new Error(
              `claude returned an error envelope: ${out.slice(0, 300)}`,
            ),
          );
        }
        resolve(envelope.result);
      } catch {
        // Fallback: maybe plain text output.
        resolve(out);
      }
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function extractJson(text: string): unknown {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1)
    throw new Error("no JSON object found in model output");
  return JSON.parse(trimmed.slice(start, end + 1));
}

/** Reject fabricated content: companies/school must be a subset of the base. */
function validateSubset(base: Resume, tailored: Resume): string[] {
  const problems: string[] = [];
  for (const k of [
    "personal",
    "summary",
    "skills",
    "experience",
    "education",
  ]) {
    if (!(k in tailored)) problems.push(`missing top-level "${k}"`);
  }
  const baseCompanies = new Set(
    (base.experience ?? []).map((e) => (e.company ?? "").toLowerCase()),
  );
  for (const e of tailored.experience ?? []) {
    const c = (e.company ?? "").toLowerCase();
    if (c && !baseCompanies.has(c))
      problems.push(`fabricated employer: "${e.company}"`);
  }
  if ((tailored.experience ?? []).length > (base.experience ?? []).length) {
    problems.push("more experience entries than the base resume");
  }
  const baseSchool = (base.education?.institution ?? "").toLowerCase();
  const tSchool = (tailored.education?.institution ?? "").toLowerCase();
  if (tSchool && baseSchool && tSchool !== baseSchool) {
    problems.push(
      `altered education institution: "${tailored.education?.institution}"`,
    );
  }
  return problems;
}

function renderPdf(jsonPath: string, pdfPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // A .mjs/.js override is run via node; a PATH command is run directly.
    const isScript = /\.[mc]?js$/.test(PDF_CLI);
    const cmd = isScript ? "node" : PDF_CLI;
    const args = isScript
      ? [PDF_CLI, jsonPath, "-o", pdfPath]
      : [jsonPath, "-o", pdfPath];
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${PDF_CLI} exited ${code}`)),
    );
  });
}

export async function tailor(idOrUrl: string): Promise<void> {
  const store = new Store();
  const job = store.findJob(idOrUrl);
  store.close();
  if (!job) {
    log.error(
      `No stored job for "${idOrUrl}". Run \`job-cron list\` to see ids.`,
    );
    process.exitCode = 1;
    return;
  }
  log.info(`Tailoring for ${job.company} — ${job.title}`);

  // Lazily fetch the full job description from the originating source.
  let description = "";
  try {
    const cfg = loadConfig().sources.find((s) => sourceKey(s) === job.source);
    if (cfg)
      description = await buildFetcher(cfg).fetchDescription(rowToPosting(job));
  } catch (err) {
    log.warn(
      `Could not fetch job description (continuing with title only):`,
      err,
    );
  }

  const base = readBaseResume();
  const slug = `${job.company}-${job.id}`.replace(/[^a-zA-Z0-9._-]+/g, "_");
  const outDir = projectPath("resumes", "out");
  mkdirSync(outDir, { recursive: true });
  const jsonPath = `${outDir}/${slug}.json`;
  const pdfPath = `${outDir}/${slug}.pdf`;

  let resume: Resume = base;
  try {
    const result = await runClaude(buildPrompt(base, job, description));
    const tailored = extractJson(result) as Resume;
    const problems = validateSubset(base, tailored);
    if (problems.length) {
      log.warn(
        `Tailored resume failed validation, using base resume:\n - ${problems.join("\n - ")}`,
      );
    } else {
      resume = tailored;
      log.info("Tailored resume validated ✓");
    }
  } catch (err) {
    log.warn("Tailoring failed, falling back to base resume:", err);
  }

  writeFileSync(jsonPath, JSON.stringify(resume, null, 2));
  log.info(`Wrote ${jsonPath}`);
  await renderPdf(jsonPath, pdfPath);
  log.info(`Done → ${pdfPath}`);
}

function sourceKey(s: SourceConfig): string {
  return s.provider === "custom"
    ? `custom:${s.customKey}`
    : `${s.provider}:${s.board}`;
}
