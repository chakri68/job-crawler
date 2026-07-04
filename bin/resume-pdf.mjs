#!/usr/bin/env node
// PLACEHOLDER JSON → "PDF" renderer for job-cron.
//
// This is a stand-in so the tailor pipeline works end-to-end. It renders the
// custom resume schema (resumes/base.json shape) to a self-contained HTML file
// you can open in a browser and "Print → Save as PDF".
//
// Swap this out for your real JSON→PDF CLI: keep the same arg contract
//   resume-pdf <input.json> -o <output.(pdf|html)>
// and point bin/resume-pdf.mjs (or PDF_CLI in src/tailor.ts) at it.

import { readFileSync, writeFileSync } from "node:fs";

function parseArgs(argv) {
  const args = { input: undefined, out: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-o" || a === "--out") args.out = argv[++i];
    else if (!args.input) args.input = a;
  }
  return args;
}

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

function render(r) {
  const p = r.personal ?? {};
  const contact = Object.values(p.contact ?? {})
    .map((c) => `<a href="${esc(c.url)}">${esc(c.text)}</a>`)
    .join(" · ");

  const skills = (r.skills?.categories ?? [])
    .map((c) => `<p><strong>${esc(c.title)}:</strong> ${esc(c.items)}</p>`)
    .join("");

  const experience = (r.experience ?? [])
    .map((e) => {
      const positions = e.positions?.length
        ? e.positions
            .map(
              (pos) =>
                `<div class="pos"><em>${esc(pos.title)}</em> <span>${esc(pos.period)}</span>` +
                `<ul>${(pos.achievements ?? []).map((a) => `<li>${esc(a)}</li>`).join("")}</ul></div>`,
            )
            .join("")
        : `<ul>${(e.achievements ?? []).map((a) => `<li>${esc(a)}</li>`).join("")}</ul>`;
      return (
        `<div class="job"><h3>${esc(e.company)} — ${esc(e.title)} ` +
        `<span>${esc(e.location)} · ${esc(e.period)}</span></h3>${positions}</div>`
      );
    })
    .join("");

  const projects = (r.projects ?? [])
    .map(
      (pr) =>
        `<li><a href="${esc(pr.url)}"><strong>${esc(pr.name)}</strong></a> — ${esc(pr.description)}</li>`,
    )
    .join("");

  const ed = r.education ?? {};
  const achievements = (r.achievements ?? [])
    .map(
      (a) =>
        `<li><strong>${esc(a.title)}</strong> — ${esc(a.description)}</li>`,
    )
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8">
<title>${esc(p.name)} — Resume</title>
<style>
  body{font:13px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;max-width:760px;margin:32px auto;color:#1a1a1a;padding:0 20px}
  h1{margin:0;font-size:24px} h2{border-bottom:1px solid #ccc;margin:20px 0 8px;font-size:15px;text-transform:uppercase;letter-spacing:.04em}
  h3{margin:12px 0 4px;font-size:14px} h3 span,.pos span{font-weight:400;color:#666;font-size:12px;float:right}
  ul{margin:4px 0 8px;padding-left:18px} .pos{margin:6px 0} a{color:#0b5fff;text-decoration:none}
  .contact{color:#444;margin:4px 0 0} .note{background:#fff8c5;border:1px solid #e6d77a;padding:6px 10px;border-radius:6px;font-size:11px;margin-bottom:16px}
</style></head><body>
<div class="note">⚠️ Placeholder renderer (HTML). Open in a browser → Print → Save as PDF, or wire your real JSON→PDF CLI.</div>
<h1>${esc(p.name)}</h1>
<p class="contact">${contact}</p>
<h2>Summary</h2><p>${esc(r.summary?.text)}</p>
<h2>Skills</h2>${skills}
<h2>Experience</h2>${experience}
<h2>Projects</h2><ul>${projects}</ul>
<h2>Education</h2><p><strong>${esc(ed.institution)}</strong> — ${esc(ed.degree)} (${esc(ed.gpa)})<br>${esc(ed.period)} · ${esc(ed.location)}</p>
<h2>Achievements</h2><ul>${achievements}</ul>
</body></html>`;
}

const { input, out } = parseArgs(process.argv.slice(2));
if (!input) {
  console.error("Usage: resume-pdf <input.json> -o <output.(pdf|html)>");
  process.exit(1);
}
const resume = JSON.parse(readFileSync(input, "utf8"));
const htmlPath =
  (out ?? input.replace(/\.json$/, "")).replace(/\.pdf$/i, "") + ".html";
writeFileSync(htmlPath, render(resume));
console.log(`[placeholder] rendered HTML resume → ${htmlPath}`);
console.log(
  `[placeholder] (real PDF would be written to ${out ?? "<-o path>"})`,
);
