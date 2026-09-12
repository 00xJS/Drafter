#!/usr/bin/env bash
# Throwaway-Postgres harness shared by the two smoke tests, so the migration
# loop exists once:
#
#   scripts/db-smoke.sh    sources this and runs SQL assertions against it
#   scripts/mcp-smoke.mjs  runs `bash scripts/lib/pgtest.sh up`, which leaves a
#                          server running and prints where it is
#
# Sourced:   pgtest_require_bins / pgtest_port / pgtest_boot / pgtest_schema / pgtest_psql
# Executed:  bash scripts/lib/pgtest.sh up          -> prints DIR=… and PORT=…
#            bash scripts/lib/pgtest.sh down <dir>  -> stops it and deletes it
#
# Needs the PostgreSQL client and server binaries on PATH (initdb, pg_ctl,
# psql): `brew install postgresql@17` on macOS; on Debian/Ubuntu the
# postgresql-17 package from apt.postgresql.org with /usr/lib/postgresql/17/bin
# on PATH, which is what .github/workflows/ci.yml does. Nothing here touches a
# real database: every server listens on a unix socket inside its own temp dir.
set -euo pipefail

PGTEST_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Fail early and by name when this machine cannot run a throwaway server. Exit
# 2, not 1, so a caller can tell "cannot run here" from "the schema is broken".
pgtest_require_bins() {
  local label="${1:-pgtest}" bin
  for bin in initdb pg_ctl psql; do
    if ! command -v "$bin" >/dev/null 2>&1; then
      echo "$label: '$bin' not found on PATH — install PostgreSQL 17 (macOS: brew install postgresql@17; Debian/Ubuntu: postgresql-17 from apt.postgresql.org, then put /usr/lib/postgresql/17/bin on PATH) to run this." >&2
      exit 2
    fi
  done
  # initdb and postgres refuse to run as root, and that failure lands in a log
  # file where it reads like a broken schema. CI containers are often root;
  # GitHub's hosted runners are not.
  if [ "$(id -u)" = 0 ]; then
    echo "$label: PostgreSQL will not run as root — run this as an unprivileged user." >&2
    exit 2
  fi
}

# A short socket path: unix sockets cap at ~100 bytes and macOS's $TMPDIR
# (/var/folders/…) is long enough to break that, so this is always /tmp.
# `mktemp -d TEMPLATE` is the one form GNU and BSD mktemp agree on.
pgtest_workdir() {
  mktemp -d "/tmp/drafter-${1:-pgtest}.XXXXXX"
}

# The port: the caller's override when one is set, else a free one. Each
# server listens only on a unix socket in its own temp dir, so the number just
# names that socket — two runs given the same one still both start. Picking an
# unused port anyway means concurrent runs never share a fixed default, and it
# stays right if TCP is ever turned on.
pgtest_port() { # [override]
  local port="${1:-}" _i
  if [ -n "$port" ]; then
    case "$port" in
      *[!0-9]*)
        echo "pgtest: port '$port' is not a number" >&2
        return 1
        ;;
    esac
    echo "$port"
    return 0
  fi
  for _i in $(seq 1 50); do
    # the dynamic range; bash's /dev/tcp connect is refused when nothing listens
    port=$((49152 + RANDOM % 16384))
    if ! (: <>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
      echo "$port"
      return 0
    fi
  done
  echo "pgtest: found no free port" >&2
  return 1
}

pgtest_psql() { # <workdir> <port> [psql args…]
  local work="$1" port="$2"
  shift 2
  psql -h "$work" -p "$port" -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"
}

# initdb + start + wait for the socket to answer.
pgtest_boot() { # <workdir> <port>
  local work="$1" port="$2" _i
  # without a C locale the postmaster goes multithreaded during startup on macOS
  # and refuses to boot ("Set the LC_ALL environment variable to a valid locale");
  # C exists everywhere, so Linux gets the same, reproducible collation
  export LC_ALL=C
  initdb -D "$work/data" -U postgres --auth=trust --no-locale -E UTF8 >"$work/initdb.log" 2>&1
  pg_ctl -D "$work/data" -l "$work/pg.log" -o "-p $port -k $work -c listen_addresses=''" start >"$work/start.log" 2>&1
  for _i in $(seq 1 30); do
    if pgtest_psql "$work" "$port" -c 'select 1' >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  echo "pgtest: postgres in $work (port $port) never accepted a connection" >&2
  return 1
}

pgtest_stop() { # <workdir>
  local work="$1"
  [ -n "$work" ] || return 0
  pg_ctl -D "$work/data" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$work"
}

# The Supabase stand-ins, then every migration in order. This loop is the one
# that must not be duplicated: a smoke test that applies a different set of
# migrations than the app ships proves nothing.
pgtest_schema() { # <workdir> <port> [label]
  local work="$1" port="$2" label="${3:-pgtest}" count=0 f
  local migrations="${DB_SMOKE_MIGRATIONS:-$PGTEST_ROOT/supabase/migrations}"
  pgtest_psql "$work" "$port" -f "$PGTEST_ROOT/scripts/db-smoke-stubs.sql"
  for f in "$migrations"/*.sql; do
    if ! pgtest_psql "$work" "$port" -f "$f" >"$work/migrate.log" 2>&1; then
      echo "$label: FAIL applying $(basename "$f")" >&2
      cat "$work/migrate.log" >&2
      return 1
    fi
    count=$((count + 1))
  done
  echo "$label: applied $count migrations"
}

# ---------------------------------------------------------------------------
# Executed directly: bring one up (and leave it up) or tear it down.
# ---------------------------------------------------------------------------
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  case "${1:-}" in
    up)
      pgtest_require_bins pgtest
      # before the temp dir exists, so a bad PGTEST_PORT leaves nothing behind
      PGTEST_PORT="$(pgtest_port "${PGTEST_PORT:-}")"
      PGTEST_WORK="$(pgtest_workdir mcp-smoke)"
      if ! pgtest_boot "$PGTEST_WORK" "$PGTEST_PORT" || ! pgtest_schema "$PGTEST_WORK" "$PGTEST_PORT" pgtest >&2; then
        pgtest_stop "$PGTEST_WORK"
        exit 1
      fi
      echo "pgtest: postgres on port $PGTEST_PORT in $PGTEST_WORK" >&2
      # the only two lines the caller parses
      echo "DIR=$PGTEST_WORK"
      echo "PORT=$PGTEST_PORT"
      ;;
    down)
      pgtest_stop "${2:-}"
      ;;
    *)
      echo "usage: bash scripts/lib/pgtest.sh up | down <dir>" >&2
      exit 64
      ;;
  esac
fi
