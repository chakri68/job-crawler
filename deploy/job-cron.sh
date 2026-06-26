#!/usr/bin/env bash
#
# job-cron service manager — installs a *user-level* systemd timer that runs
# `job-cron run` + `job-cron purge` hourly. No sudo required.
#
#   ./deploy/job-cron.sh install      Install + enable + start the hourly timer
#   ./deploy/job-cron.sh uninstall    Stop, disable, and remove the timer/service
#   ./deploy/job-cron.sh status       Show timer state and next run time
#   ./deploy/job-cron.sh logs [-f]    Show (or follow) recent run logs
#   ./deploy/job-cron.sh run          Trigger one run now (and show its logs)
#   ./deploy/job-cron.sh print        Print the unit files without installing
#   ./deploy/job-cron.sh help
#
# Config: edit env vars (e.g. DISCORD_WEBHOOK_URL) in:
#   ~/.config/job-cron/env
#
set -euo pipefail

# ── Resolve paths ────────────────────────────────────────────────────────────
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
ENV_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/job-cron"
ENV_FILE="$ENV_DIR/env"
SERVICE="job-cron.service"
TIMER="job-cron.timer"
PURGE_DAYS="${JOB_CRON_PURGE_DAYS:-7}"

# Program name shown in help/hints. Overridden to "job-cron deploy" when invoked
# via the CLI wrapper; falls back to the script path when run directly.
PROG="${JOB_CRON_PROG:-$0}"

# Absolute node path — systemd has no nvm shims on its PATH, so we pin it.
NODE="$(command -v node || true)"

c_red()  { printf '\033[31m%s\033[0m\n' "$*"; }
c_grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
c_dim()  { printf '\033[2m%s\033[0m\n' "$*"; }

require_node() {
  if [[ -z "$NODE" ]]; then
    c_red "node not found on PATH. Install Node 24+ and re-run."; exit 1
  fi
  local major
  major="$("$NODE" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if (( major < 24 )); then
    c_red "Node 24+ required (found $("$NODE" -v)). job-cron runs .ts files natively."; exit 1
  fi
}

# Best-effort alert through the configured notifier (Discord/Telegram/console).
# Loads the deploy env file first so secrets are available even when they only
# live in ~/.config/job-cron/env (not the repo .env). Never fails the command.
send_alert() {
  local msg="$1"
  [[ -z "$NODE" ]] && return 0
  (
    if [[ -f "$ENV_FILE" ]]; then
      set -a
      # shellcheck disable=SC1090
      source "$ENV_FILE" 2>/dev/null || true
      set +a
    fi
    cd "$REPO" && "$NODE" src/cli.ts _notify "$msg"
  ) >/dev/null 2>&1 || true
}

require_systemd_user() {
  if ! systemctl --user show-environment >/dev/null 2>&1; then
    c_red "No user systemd manager available (systemctl --user not working)."
    c_dim "On a normal desktop login this works. Over SSH, try: loginctl enable-linger $USER"
    exit 1
  fi
}

# ── Unit file generators ─────────────────────────────────────────────────────
service_unit() {
  cat <<EOF
[Unit]
Description=job-cron — career-page watcher (poll + purge)
Documentation=file://$REPO/README.md

[Service]
Type=oneshot
WorkingDirectory=$REPO
EnvironmentFile=-$ENV_FILE
ExecStart=$NODE src/cli.ts run
ExecStart=$NODE src/cli.ts purge --days $PURGE_DAYS
# Keep it from hammering anything if something loops:
TimeoutStartSec=600
EOF
}

timer_unit() {
  cat <<EOF
[Unit]
Description=job-cron hourly schedule

[Timer]
OnCalendar=hourly
# Catch up on the next boot/wake if the machine was asleep at fire time:
Persistent=true
# Politeness jitter so we don't hit career pages exactly on the hour:
RandomizedDelaySec=180
AccuracySec=1min

[Install]
WantedBy=timers.target
EOF
}

ensure_env_file() {
  if [[ ! -f "$ENV_FILE" ]]; then
    mkdir -p "$ENV_DIR"
    cat > "$ENV_FILE" <<'EOF'
# job-cron environment — KEY=VALUE per line (no quotes, no `export`).
# Without a webhook, alerts are written to the systemd journal instead.

#DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/XXXX/YYYY

# Optional: override the JSON→PDF CLI used by `tailor`
#RESUME_PDF_CLI=resume-to-pdf
EOF
    chmod 600 "$ENV_FILE"
    c_dim "Created $ENV_FILE (edit it to add DISCORD_WEBHOOK_URL)."
  fi
}

# ── Subcommands ──────────────────────────────────────────────────────────────
cmd_install() {
  require_node
  require_systemd_user
  ensure_env_file
  mkdir -p "$UNIT_DIR"
  service_unit > "$UNIT_DIR/$SERVICE"
  timer_unit   > "$UNIT_DIR/$TIMER"
  systemctl --user daemon-reload
  systemctl --user enable --now "$TIMER"

  # Let the timer fire even when you're not logged in (best-effort).
  if ! loginctl show-user "$USER" 2>/dev/null | grep -q 'Linger=yes'; then
    if loginctl enable-linger "$USER" 2>/dev/null; then
      c_dim "Enabled linger so the timer runs when you're logged out."
    else
      c_dim "Tip: 'sudo loginctl enable-linger $USER' to run while logged out."
    fi
  fi

  c_grn "Installed. node=$NODE  repo=$REPO"
  echo
  systemctl --user list-timers "$TIMER" --no-pager || true
  echo
  c_dim "Edit config:  $ENV_FILE"
  c_dim "Run now:      $PROG run    |   Logs: $PROG logs -f   |   Remove: $PROG uninstall"

  send_alert "✅ job-cron: hourly timer installed on $(hostname 2>/dev/null || echo this host) — polling every hour."
}

cmd_uninstall() {
  systemctl --user disable --now "$TIMER" 2>/dev/null || true
  systemctl --user stop "$SERVICE" 2>/dev/null || true
  rm -f "$UNIT_DIR/$SERVICE" "$UNIT_DIR/$TIMER"
  systemctl --user daemon-reload 2>/dev/null || true
  c_grn "Removed $TIMER and $SERVICE."
  c_dim "Left your config ($ENV_FILE) and database (data/jobs.db) untouched."
  c_dim "Delete the env file manually if you want: rm $ENV_FILE"

  send_alert "🛑 job-cron: hourly timer removed on $(hostname 2>/dev/null || echo this host) — scheduled polling stopped."
}

cmd_status() {
  systemctl --user list-timers "$TIMER" --no-pager || true
  echo
  systemctl --user status "$SERVICE" --no-pager 2>/dev/null || true
}

cmd_logs() {
  if [[ "${1:-}" == "-f" || "${1:-}" == "--follow" ]]; then
    journalctl --user -u "$SERVICE" -f
  else
    journalctl --user -u "$SERVICE" -n 100 --no-pager
  fi
}

cmd_run() {
  c_dim "Triggering one run (this blocks until it finishes)…"
  systemctl --user start "$SERVICE"
  journalctl --user -u "$SERVICE" -n 40 --no-pager
}

cmd_print() {
  echo "# ── $UNIT_DIR/$SERVICE ──"
  service_unit
  echo
  echo "# ── $UNIT_DIR/$TIMER ──"
  timer_unit
}

usage() {
  cat <<EOF
job-cron service manager — user-level systemd timer (no sudo). Runs
'job-cron run' + 'job-cron purge' hourly.

  $PROG install      Install + enable + start the hourly timer
  $PROG uninstall    Stop, disable, and remove the timer/service
  $PROG status       Show timer state and next run time
  $PROG logs [-f]    Show (or follow) recent run logs
  $PROG run          Trigger one run now (and show its logs)
  $PROG print        Print the unit files without installing
  $PROG help

Config (env vars like DISCORD_WEBHOOK_URL): $ENV_FILE
EOF
}

case "${1:-help}" in
  install)   cmd_install ;;
  uninstall|remove) cmd_uninstall ;;
  status)    cmd_status ;;
  logs)      shift; cmd_logs "${1:-}" ;;
  run)       cmd_run ;;
  print)     cmd_print ;;
  help|-h|--help) usage ;;
  *) c_red "Unknown command: $1"; echo; usage; exit 1 ;;
esac
