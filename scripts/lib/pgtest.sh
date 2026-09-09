#!/usr/bin/env bash
# Throwaway-Postgres harness shared by the two smoke tests, so the migration
# loop exists once:
#
#   scripts/db-smoke.sh    sources this and runs SQL assertions against it
#   scripts/mcp-smoke.mjs  runs `bash scripts/lib/pgtest.sh up`, which leaves a
#                          server running and prints where it is
#
# Sourced:   pgtest_require_bins / pgtest_boot / pgtest_schema / pgtest_psql
# Executed:  bash scripts/lib/pgtest.sh up          -> prints DIR=… and PORT=…
#            bash scripts/lib/pgtest.sh down <dir>  -> stops it and deletes it
#
# Needs the PostgreSQL client and server binaries on PATH (initdb, pg_ctl,
# psql), e.g. `brew install postgresql@17`. Nothing here touches a real
# database: every server listens on a unix socket inside its own temp dir.
set -euo pipefail

PGTEST_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Fail early and by name when the toolchain is missing. Exit 2, not 1, so a
# caller can tell "Postgres is not installed" from "the schema is broken".
pgtest_require_bins() {
  local label="${1:-pgtest}" bin
  for bin in initdb pg_ctl psql; do
    if ! command -v "$bin" >/dev/null 2>&1; then
      echo "$label: '$bin' not found on PATH — install PostgreSQL (brew install postgresql@17) to run this." >&2
      exit 2
    fi
  done
}

# A short socket path: unix sockets cap at ~100 bytes and /tmp is always short.
pgtest_workdir() {
  mktemp -d "/tmp/drafter-${1:-pgtest}.XXXXXX"
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
  # and refuses to boot ("Set the LC_ALL environment variable to a valid locale")
  export LC_ALL=C
  initdb -D "$work/data" -U postgres --auth=trust --no-locale -E UTF8 >"$work/initdb.log" 2>&1
  pg_ctl -D "$work/data" -l "$work/pg.log" -o "-p $port -k $work -c listen_addresses=''" start >"$work/start.log" 2>&1
  for _i in $(seq 1 30); do
    if pgtest_psql "$work" "$port" -c 'select 1' >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  echo "pgtest: postgres in $work never accepted a connection" >&2
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
      PGTEST_WORK="$(pgtest_workdir mcp-smoke)"
      PGTEST_PORT="${PGTEST_PORT:-55433}"
      if ! pgtest_boot "$PGTEST_WORK" "$PGTEST_PORT" || ! pgtest_schema "$PGTEST_WORK" "$PGTEST_PORT" pgtest >&2; then
        pgtest_stop "$PGTEST_WORK"
        exit 1
      fi
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
