import blessed from "blessed";
import { spawn } from "node:child_process";
import { Store } from "./store.ts";
import { loadConfig, projectPath } from "./config.ts";
import { relTime } from "./ui.ts";
import type { Config, JobRow, SourceStateRow } from "./types.ts";

const esc = (s: string): string => blessed.escape(String(s ?? ""));

function sourceKey(s: Config["sources"][number]): string {
  return s.provider === "custom" ? `custom:${s.customKey}` : `${s.provider}:${s.board}`;
}

/** Platform "open this URL in the default browser" command. */
function openCmd(): string {
  if (process.platform === "darwin") return "open";
  if (process.platform === "win32") return "start";
  return "xdg-open";
}

function jobLabel(j: JobRow, width: number): string {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const isNew = new Date(j.first_seen).getTime() >= cutoff;
  const dot = isNew ? "{green-fg}●{/}" : " ";
  const company = esc(j.company);
  const budget = Math.max(10, width - company.length - 8);
  let title = esc(j.title);
  if (title.length > budget) title = title.slice(0, budget - 1) + "…";
  return `${dot} {bold}${company}{/} {gray-fg}—{/} ${title}`;
}

function renderDetail(j: JobRow | undefined): string {
  if (!j) return "{gray-fg}No job selected.{/}";
  return [
    `{bold}{cyan-fg}${esc(j.title)}{/}`,
    `{bold}${esc(j.company)}{/}   {gray-fg}${esc(j.location || "—")}{/}`,
    "",
    `{gray-fg}Source {/}  ${esc(j.source)}`,
    `{gray-fg}Seen   {/}  ${relTime(j.first_seen)}  {gray-fg}(${esc(j.first_seen)}){/}`,
    `{gray-fg}Posted {/}  ${j.posted_at ? esc(j.posted_at) : "—"}`,
    `{gray-fg}Alerted{/}  ${j.notified ? "{green-fg}yes{/}" : "{gray-fg}no{/}"}`,
    `{gray-fg}ID     {/}  ${esc(j.id)}`,
    "",
    "{gray-fg}URL{/}",
    `{underline}${esc(j.url)}{/}`,
  ].join("\n");
}

function renderHeader(
  cfg: Config,
  states: SourceStateRow[],
  jobs: JobRow[],
  shown: number,
): string {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const newCount = jobs.filter((j) => new Date(j.first_seen).getTime() >= cutoff).length;
  const enabled = cfg.sources.filter((s) => s.enabled);
  const byKey = new Map(states.map((s) => [s.source, s]));
  const failing = enabled.filter((s) => (byKey.get(sourceKey(s))?.fail_streak ?? 0) > 0).length;
  const ok = enabled.length - failing;

  const filtered = shown !== jobs.length ? ` {gray-fg}(showing ${shown}){/}` : "";
  return (
    ` {bold}{cyan-fg}job-cron{/}   ` +
    `{bold}${jobs.length}{/} {gray-fg}jobs{/}${filtered}   ` +
    `{green-fg}${newCount}{/} {gray-fg}new (24h){/}   ` +
    `{gray-fg}sources{/} {bold}${enabled.length}/${cfg.sources.length}{/}   ` +
    `{green-fg}${ok} ok{/}` +
    (failing > 0 ? `   {red-fg}${failing} failing{/}` : "")
  );
}

function renderSourcesPanel(cfg: Config, states: SourceStateRow[]): string {
  const byKey = new Map(states.map((s) => [s.source, s]));
  const lines = ["{bold}{cyan-fg}Sources{/}", ""];
  for (const s of cfg.sources) {
    const key = sourceKey(s);
    if (!s.enabled) {
      lines.push(`{gray-fg}✗ ${esc(key)}  —  disabled{/}`);
      continue;
    }
    const st = byKey.get(key);
    let health: string;
    if (!st || !st.last_run) health = "{gray-fg}not run yet{/}";
    else if (st.fail_streak > 0)
      health = `{red-fg}failing ×${st.fail_streak}{/} {gray-fg}(${relTime(st.last_run)}){/}`;
    else if (!st.seeded) health = "{yellow-fg}seeding…{/}";
    else health = `{green-fg}ok{/} {gray-fg}· ${relTime(st.last_ok)}{/}`;
    lines.push(`{green-fg}✓{/} {bold}${esc(key)}{/}  {gray-fg}—{/}  ${health}`);
  }
  lines.push("", "{gray-fg}[s/esc] close{/}");
  return lines.join("\n");
}

export function runTui(): void {
  const store = new Store();
  const cfg = loadConfig();
  const allJobs = store.listJobs(1000);
  const states = store.listSourceState();
  store.close();

  let jobs = allJobs;

  const screen = blessed.screen({
    smartCSR: true,
    title: "job-cron",
    fullUnicode: true,
    autoPadding: true,
  });

  const header = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    right: 0,
    height: 1,
    tags: true,
    content: renderHeader(cfg, states, jobs, jobs.length),
  });

  const list = blessed.list({
    parent: screen,
    label: " Jobs ",
    top: 1,
    left: 0,
    width: "50%",
    bottom: 1,
    tags: true,
    keys: true,
    vi: true,
    mouse: true,
    border: "line",
    scrollbar: { ch: " ", style: { bg: "cyan" } } as never,
    style: {
      border: { fg: "gray" },
      selected: { bg: "cyan", fg: "black", bold: true },
    },
  });

  const detail = blessed.box({
    parent: screen,
    label: " Details ",
    top: 1,
    left: "50%",
    right: 0,
    bottom: 1,
    tags: true,
    scrollable: true,
    keys: true,
    mouse: true,
    border: "line",
    padding: { left: 1, right: 1, top: 0, bottom: 0 },
    style: { border: { fg: "gray" }, label: { fg: "cyan" } },
  });

  const footer = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    right: 0,
    height: 1,
    tags: true,
    content:
      " {gray-fg}{bold}j/k{/}{gray-fg} move  {bold}enter/o{/}{gray-fg} open  " +
      "{bold}t{/}{gray-fg} tailor  {bold}d{/}{gray-fg} dismiss  {bold}s{/}{gray-fg} sources  " +
      "{bold}/{/}{gray-fg} search  {bold}q{/}{gray-fg} quit{/}",
  });

  const sourcesPanel = blessed.box({
    parent: screen,
    label: " Sources ",
    top: "center",
    left: "center",
    width: "70%",
    height: "60%",
    tags: true,
    hidden: true,
    scrollable: true,
    keys: true,
    border: "line",
    padding: { left: 1, right: 1, top: 0, bottom: 0 },
    content: renderSourcesPanel(cfg, states),
    style: { border: { fg: "cyan" }, label: { fg: "cyan" } },
  });

  const search = blessed.textbox({
    parent: screen,
    bottom: 0,
    left: 0,
    right: 0,
    height: 1,
    hidden: true,
    inputOnFocus: true,
    style: { fg: "white" },
  });

  const confirm = blessed.box({
    parent: screen,
    label: " Confirm dismiss ",
    top: "center",
    left: "center",
    width: "60%",
    height: 11,
    tags: true,
    hidden: true,
    keys: true,
    border: "line",
    padding: { left: 2, right: 2, top: 0, bottom: 0 },
    style: { border: { fg: "red" }, label: { fg: "red" } },
  });

  // @types/blessed omits ListElement.selected though it exists at runtime.
  const selectedIndex = (): number =>
    (list as unknown as { selected: number }).selected ?? 0;

  const listWidth = (): number => (Number(screen.width) || 80) / 2 - 4;

  function setItems(): void {
    const w = listWidth();
    list.setItems(
      jobs.length ? jobs.map((j) => jobLabel(j, w)) : ["{gray-fg}No jobs match.{/}"],
    );
  }

  function refreshDetail(): void {
    detail.setContent(renderDetail(jobs[selectedIndex()]));
    header.setContent(renderHeader(cfg, states, allJobs, jobs.length));
    screen.render();
  }

  function applyFilter(q: string): void {
    const needle = q.trim().toLowerCase();
    jobs = needle
      ? allJobs.filter(
          (j) =>
            j.company.toLowerCase().includes(needle) ||
            j.title.toLowerCase().includes(needle) ||
            j.location.toLowerCase().includes(needle),
        )
      : allJobs;
    setItems();
    list.select(0);
    refreshDetail();
  }

  function openSelected(): void {
    const j = jobs[selectedIndex()];
    if (!j) return;
    const child = spawn(openCmd(), [j.url], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  }

  function tailorSelected(): void {
    const j = jobs[selectedIndex()];
    if (!j) return;
    screen.destroy();
    console.log(`\nTailoring resume for: ${j.company} — ${j.title}\n`);
    const child = spawn(
      process.execPath,
      [projectPath("src", "cli.ts"), "tailor", j.id],
      { stdio: "inherit" },
    );
    child.on("exit", (code) => process.exit(code ?? 0));
    child.on("error", (err) => {
      console.error(err);
      process.exit(1);
    });
  }

  function confirmDismiss(): void {
    const j = jobs[selectedIndex()];
    if (!j) return;
    confirm.setContent(
      `Dismiss this job?\n\n` +
        `  {bold}${esc(j.company)}{/} {gray-fg}—{/} ${esc(j.title)}\n\n` +
        `{gray-fg}It's hidden for good — no re-alert and it won't come back on the next {bold}run{/}{gray-fg}.{/}\n` +
        `{bold}{red-fg}y{/} dismiss   {bold}n{/}{gray-fg}/{bold}esc{/}{gray-fg} cancel{/}`,
    );
    confirm.show();
    confirm.setFront();
    confirm.focus();
    screen.render();
  }

  function closeConfirm(): void {
    confirm.hide();
    list.focus();
    screen.render();
  }

  function performDismiss(): void {
    const idx = selectedIndex();
    const j = jobs[idx];
    if (!j) {
      closeConfirm();
      return;
    }
    const store2 = new Store();
    store2.dismissJob(j.id);
    store2.close();

    const drop = (arr: JobRow[]): void => {
      const i = arr.findIndex((x) => x.id === j.id);
      if (i !== -1) arr.splice(i, 1);
    };
    drop(allJobs);
    if (jobs !== allJobs) drop(jobs);

    confirm.hide();
    setItems();
    list.select(Math.min(idx, Math.max(0, jobs.length - 1)));
    list.focus();
    refreshDetail();
  }

  confirm.key(["y"], performDismiss);
  confirm.key(["n", "escape"], closeConfirm);

  // Keep the detail pane in sync as the cursor moves.
  list.on("keypress", () => process.nextTick(refreshDetail));
  list.on("select", openSelected);

  list.key(["o"], openSelected);
  list.key(["t"], tailorSelected);
  list.key(["d"], confirmDismiss);

  list.key(["s"], () => {
    sourcesPanel.show();
    sourcesPanel.setFront();
    sourcesPanel.focus();
    screen.render();
  });
  const closeSources = (): void => {
    sourcesPanel.hide();
    list.focus();
    screen.render();
  };
  sourcesPanel.key(["s", "escape", "q"], closeSources);

  list.key(["/"], () => {
    footer.hide();
    search.show();
    search.setValue("");
    (search as unknown as { setLabel?: (s: string) => void }).setLabel?.("");
    search.focus();
    search.readInput();
    screen.render();
  });
  const endSearch = (): void => {
    search.hide();
    footer.show();
    list.focus();
    screen.render();
  };
  search.on("submit", () => {
    applyFilter(search.getValue());
    endSearch();
  });
  search.on("cancel", endSearch);
  search.key(["C-u"], () => {
    search.setValue("");
    screen.render();
  });

  screen.key(["q", "C-c"], () => {
    screen.destroy();
    process.exit(0);
  });

  screen.on("resize", () => {
    setItems();
    refreshDetail();
  });

  setItems();
  list.focus();
  refreshDetail();
  screen.render();
}
