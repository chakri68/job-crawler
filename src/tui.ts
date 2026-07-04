import blessed from "blessed";
import { spawn } from "node:child_process";
import { Store } from "./store.ts";
import { loadConfig, projectPath } from "./config.ts";
import { relTime } from "./ui.ts";
import type { Config, JobRow, JobStatus, SourceStateRow } from "./types.ts";

const esc = (s: string): string => blessed.escape(String(s ?? ""));

/** Strip ANSI escape sequences and carriage returns from piped child output. */
// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string =>
  s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");

function sourceKey(s: Config["sources"][number]): string {
  return s.provider === "custom"
    ? `custom:${s.customKey}`
    : `${s.provider}:${s.board}`;
}

/** Platform "open this URL in the default browser" command. */
function openCmd(): string {
  if (process.platform === "darwin") return "open";
  if (process.platform === "win32") return "start";
  return "xdg-open";
}

/** Status ordering for cycling and the labels/colors used everywhere. */
const STATUS_FILTERS = ["all", "new", "applied", "rejected"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

/** One-char marker for the job list: status wins over the "new in 24h" dot. */
function statusMarker(j: JobRow): string {
  if (j.status === "applied") return "{green-fg}✓{/}";
  if (j.status === "rejected") return "{red-fg}✗{/}";
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return new Date(j.first_seen).getTime() >= cutoff ? "{green-fg}●{/}" : " ";
}

/** Colored status badge for the detail pane. */
function statusBadge(status: JobStatus): string {
  if (status === "applied") return "{green-fg}applied{/}";
  if (status === "rejected") return "{red-fg}rejected{/}";
  return "{gray-fg}new{/}";
}

function jobLabel(j: JobRow, width: number): string {
  const company = esc(j.company);
  const budget = Math.max(10, width - company.length - 8);
  let title = esc(j.title);
  if (title.length > budget) title = title.slice(0, budget - 1) + "…";
  return `${statusMarker(j)} {bold}${company}{/} {gray-fg}—{/} ${title}`;
}

function renderDetail(j: JobRow | undefined): string {
  if (!j) return "{gray-fg}No job selected.{/}";
  return [
    `{bold}{cyan-fg}${esc(j.title)}{/}`,
    `{bold}${esc(j.company)}{/}   {gray-fg}${esc(j.location || "—")}{/}`,
    "",
    `{gray-fg}Status {/}  ${statusBadge(j.status)}`,
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

type TailorState = "running" | "done" | "error";

/** The tailor modal body: streamed logs, then a status/hint footer. */
function renderTailorPanel(
  job: JobRow | undefined,
  state: TailorState,
  logText: string,
  pdfPath: string | null,
): string {
  const head = job
    ? `{bold}{cyan-fg}${esc(job.company)}{/} {gray-fg}—{/} ${esc(job.title)}`
    : "";
  // Log lines are escaped so ANSI-free child output can't break blessed tags.
  const body = logText.trim()
    ? stripAnsi(logText).trimEnd().split("\n").map(esc).join("\n")
    : "{gray-fg}starting…{/}";
  const lines = [head, "", body, ""];
  if (state === "running") {
    lines.push("{yellow-fg}⟳ Tailoring… please wait.{/}");
  } else if (state === "done") {
    lines.push("{green-fg}✓ Resume generated.{/}");
    if (pdfPath) lines.push(`{gray-fg}PDF{/}  {underline}${esc(pdfPath)}{/}`);
    lines.push("");
    lines.push(
      "{bold}{green-fg}enter{/}{gray-fg} open job link   {bold}esc{/}{gray-fg} close{/}",
    );
  } else {
    lines.push("{red-fg}✗ Tailoring failed — see the log above.{/}");
    lines.push("");
    lines.push(
      "{bold}enter{/}{gray-fg} open job link   {bold}esc{/}{gray-fg} close{/}",
    );
  }
  return lines.join("\n");
}

function renderHeader(
  cfg: Config,
  states: SourceStateRow[],
  jobs: JobRow[],
  shown: number,
): string {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const newCount = jobs.filter(
    (j) => new Date(j.first_seen).getTime() >= cutoff,
  ).length;
  const applied = jobs.filter((j) => j.status === "applied").length;
  const rejected = jobs.filter((j) => j.status === "rejected").length;
  const enabled = cfg.sources.filter((s) => s.enabled);
  const byKey = new Map(states.map((s) => [s.source, s]));
  const failing = enabled.filter(
    (s) => (byKey.get(sourceKey(s))?.fail_streak ?? 0) > 0,
  ).length;
  const ok = enabled.length - failing;

  const filtered =
    shown !== jobs.length ? ` {gray-fg}(showing ${shown}){/}` : "";
  return (
    ` {bold}{cyan-fg}job-cron{/}   ` +
    `{bold}${jobs.length}{/} {gray-fg}jobs{/}${filtered}   ` +
    `{green-fg}${newCount}{/} {gray-fg}new (24h){/}   ` +
    `{green-fg}${applied}{/} {gray-fg}applied{/}   ` +
    `{red-fg}${rejected}{/} {gray-fg}rejected{/}   ` +
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

/** Most recent value across source-state rows (ISO strings sort chronologically). */
function latest(
  states: SourceStateRow[],
  pick: (s: SourceStateRow) => string | null,
): string | null {
  const vals = states
    .map(pick)
    .filter((v): v is string => !!v)
    .sort();
  return vals.at(-1) ?? null;
}

/** The "run now?" warning: last-run details so you don't fire a redundant poll. */
function renderRunPrompt(cfg: Config, states: SourceStateRow[]): string {
  const enabled = cfg.sources.filter((s) => s.enabled);
  const byKey = new Map(states.map((s) => [s.source, s]));
  const failing = enabled.filter(
    (s) => (byKey.get(sourceKey(s))?.fail_streak ?? 0) > 0,
  ).length;
  const lastRun = latest(states, (s) => s.last_run);
  const lastOk = latest(states, (s) => s.last_ok);

  const lines = ["{bold}Run all enabled sources now?{/}", ""];
  if (lastRun) {
    lines.push(
      `{gray-fg}Last run    {/} {bold}${relTime(lastRun)}{/}  {gray-fg}(${esc(lastRun)}){/}`,
    );
    lines.push(
      `{gray-fg}Last success{/} ${lastOk ? relTime(lastOk) : "{red-fg}never{/}"}`,
    );
  } else {
    lines.push("{yellow-fg}No previous run recorded yet.{/}");
  }
  lines.push(
    `{gray-fg}Sources     {/} ${enabled.length} enabled` +
      (failing > 0
        ? `   {red-fg}· ${failing} failing{/}`
        : "   {green-fg}· all ok{/}"),
  );
  lines.push("");
  if (lastRun && Date.now() - new Date(lastRun).getTime() < 15 * 60 * 1000) {
    lines.push(
      `{yellow-fg}⚠ Last run was only ${relTime(lastRun)} — running again may be redundant.{/}`,
    );
  }
  lines.push(
    "{gray-fg}This fetches every enabled source and may send alerts for new matches.{/}",
  );
  lines.push("");
  lines.push(
    "{bold}{green-fg}y{/} run now   {bold}n{/}{gray-fg}/{bold}esc{/}{gray-fg} cancel{/}",
  );
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
      "{bold}t{/}{gray-fg} tailor  {bold}a{/}{gray-fg} applied  {bold}x{/}{gray-fg} rejected  " +
      "{bold}f/tab{/}{gray-fg} filter  {bold}d{/}{gray-fg} dismiss  {bold}r{/}{gray-fg} run  " +
      "{bold}s{/}{gray-fg} sources  {bold}/{/}{gray-fg} search  {bold}q{/}{gray-fg} quit{/}",
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

  const runPanel = blessed.box({
    parent: screen,
    label: " Run now ",
    top: "center",
    left: "center",
    width: "70%",
    height: 13,
    tags: true,
    hidden: true,
    keys: true,
    border: "line",
    padding: { left: 2, right: 2, top: 0, bottom: 0 },
    style: { border: { fg: "yellow" }, label: { fg: "yellow" } },
  });

  const tailorPanel = blessed.box({
    parent: screen,
    label: " Tailor ",
    top: "center",
    left: "center",
    width: "80%",
    height: "75%",
    tags: true,
    hidden: true,
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    vi: true,
    mouse: true,
    border: "line",
    scrollbar: { ch: " ", style: { bg: "cyan" } } as never,
    padding: { left: 1, right: 1, top: 0, bottom: 0 },
    style: { border: { fg: "cyan" }, label: { fg: "cyan" } },
  });

  // @types/blessed omits ListElement.selected though it exists at runtime.
  const selectedIndex = (): number =>
    (list as unknown as { selected: number }).selected ?? 0;

  const listWidth = (): number => (Number(screen.width) || 80) / 2 - 4;

  function setItems(): void {
    const w = listWidth();
    list.setItems(
      jobs.length
        ? jobs.map((j) => jobLabel(j, w))
        : ["{gray-fg}No jobs match.{/}"],
    );
  }

  function refreshDetail(): void {
    detail.setContent(renderDetail(jobs[selectedIndex()]));
    header.setContent(renderHeader(cfg, states, allJobs, jobs.length));
    screen.render();
  }

  let statusFilter: StatusFilter = "all";
  let searchNeedle = "";

  function updateListLabel(): void {
    const parts: string[] = statusFilter === "all" ? [] : [statusFilter];
    if (searchNeedle) parts.push(`/${searchNeedle}`);
    list.setLabel(parts.length ? ` Jobs · ${parts.join(" · ")} ` : " Jobs ");
  }

  /** Rebuild the visible list from status + search filters, keeping the cursor
   *  on `preserveId` when it's still visible. */
  function recompute(preserveId?: string): void {
    jobs = allJobs.filter((j) => {
      if (statusFilter !== "all" && j.status !== statusFilter) return false;
      if (searchNeedle) {
        return (
          j.company.toLowerCase().includes(searchNeedle) ||
          j.title.toLowerCase().includes(searchNeedle) ||
          j.location.toLowerCase().includes(searchNeedle)
        );
      }
      return true;
    });
    setItems();
    const idx = preserveId ? jobs.findIndex((j) => j.id === preserveId) : -1;
    list.select(idx === -1 ? 0 : idx);
    updateListLabel();
    refreshDetail();
  }

  function cycleFilter(dir: 1 | -1): void {
    const i = STATUS_FILTERS.indexOf(statusFilter);
    statusFilter =
      STATUS_FILTERS[
        (i + dir + STATUS_FILTERS.length) % STATUS_FILTERS.length
      ]!;
    recompute();
  }

  /** Toggle a job's status (pressing the same status again clears it to "new"). */
  function markStatus(status: JobStatus): void {
    const j = jobs[selectedIndex()];
    if (!j) return;
    const next: JobStatus = j.status === status ? "new" : status;
    const store2 = new Store();
    store2.setStatus(j.id, next);
    store2.close();
    const apply = (arr: JobRow[]): void => {
      const row = arr.find((x) => x.id === j.id);
      if (row) row.status = next;
    };
    apply(allJobs);
    if (jobs !== allJobs) apply(jobs);
    recompute(j.id);
  }

  function openJob(j: JobRow): void {
    const child = spawn(openCmd(), [j.url], {
      stdio: "ignore",
      detached: true,
    });
    child.on("error", () => {});
    child.unref();
  }

  function openSelected(): void {
    const j = jobs[selectedIndex()];
    if (j) openJob(j);
  }

  // Tailor modal state. The child `tailor` streams into `tailorPanel`; the modal
  // stays open (and can't be dismissed) until the child exits.
  let tailorJob: JobRow | undefined;
  let tailorState: TailorState = "running";
  let tailorLog = "";
  let tailorPdf: string | null = null;

  function paintTailor(): void {
    tailorPanel.setContent(
      renderTailorPanel(tailorJob, tailorState, tailorLog, tailorPdf),
    );
    tailorPanel.setScrollPerc(100);
    screen.render();
  }

  function tailorSelected(): void {
    const j = jobs[selectedIndex()];
    if (!j) return;
    tailorJob = j;
    tailorState = "running";
    tailorLog = "";
    tailorPdf = null;
    tailorPanel.show();
    tailorPanel.setFront();
    tailorPanel.focus();
    paintTailor();

    const child = spawn(
      process.execPath,
      [projectPath("src", "cli.ts"), "tailor", j.id],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const onData = (d: Buffer): void => {
      tailorLog += d.toString();
      // The tailor logs `Done → <path>.pdf` on success — grab the PDF path.
      const m = tailorLog.match(/Done → (.+\.pdf)/);
      if (m) tailorPdf = m[1]!.trim();
      paintTailor();
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err) => {
      tailorLog += `\n${err.message}\n`;
      tailorState = "error";
      paintTailor();
    });
    child.on("exit", (code) => {
      tailorState = code === 0 ? "done" : "error";
      paintTailor();
    });
  }

  function closeTailor(): void {
    if (tailorState === "running") return; // busy — can't dismiss yet
    tailorPanel.hide();
    list.focus();
    screen.render();
  }

  tailorPanel.key(["escape"], closeTailor);
  tailorPanel.key(["enter"], () => {
    if (tailorState === "running") return;
    if (tailorJob) openJob(tailorJob);
    closeTailor();
  });

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

  function showRunPrompt(): void {
    runPanel.setContent(renderRunPrompt(cfg, states));
    runPanel.show();
    runPanel.setFront();
    runPanel.focus();
    screen.render();
  }
  function closeRunPrompt(): void {
    runPanel.hide();
    list.focus();
    screen.render();
  }
  // Hand off to a child `run` (the runner logs to stdout, which would corrupt
  // the blessed screen in-process), then relaunch the TUI with fresh data.
  function performRun(): void {
    runPanel.hide();
    screen.destroy();
    console.log("\n  Running job-cron search…\n");
    const child = spawn(
      process.execPath,
      [projectPath("src", "cli.ts"), "run"],
      {
        stdio: "inherit",
      },
    );
    child.on("exit", () => {
      process.stdout.write(
        "\n  Run complete. Press Enter to return to the dashboard… ",
      );
      const stdin = process.stdin;
      stdin.setRawMode?.(false);
      stdin.resume();
      stdin.once("data", () => {
        stdin.pause();
        runTui();
      });
    });
    child.on("error", (err) => {
      console.error(err);
      process.exit(1);
    });
  }
  runPanel.key(["y"], performRun);
  runPanel.key(["n", "escape"], closeRunPrompt);

  // Keep the detail pane in sync as the cursor moves.
  list.on("keypress", () => process.nextTick(refreshDetail));
  list.on("select", openSelected);

  list.key(["o"], openSelected);
  list.key(["t"], tailorSelected);
  list.key(["a"], () => markStatus("applied"));
  list.key(["x"], () => markStatus("rejected"));
  list.key(["f", "tab"], () => cycleFilter(1));
  list.key(["S-tab"], () => cycleFilter(-1));
  list.key(["d"], confirmDismiss);
  list.key(["r"], showRunPrompt);

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
    searchNeedle = search.getValue().trim().toLowerCase();
    recompute();
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
