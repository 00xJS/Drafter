#!/usr/bin/env bash
# Database smoke test: start a throwaway Postgres, stub what Supabase provides,
# apply every migration in supabase/migrations in order, then exercise
# sync_posts and the policies the way the app, the MCP server and the digest
# do (scripts/db-smoke-assert.sql). Exit 0 only when everything passes.
#
# Needs the PostgreSQL client and server binaries on PATH (initdb, pg_ctl,
# psql), e.g. `brew install postgresql@17` and its bin dir on PATH. Nothing
# touches a real database. Run with `npm run db:smoke`.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
for bin in initdb pg_ctl psql; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "db-smoke: '$bin' not found on PATH — install PostgreSQL (brew install postgresql@17) to run this." >&2
    exit 2
  fi
done

# a short socket path: Unix sockets cap at ~100 bytes and /tmp is always short
WORK="$(mktemp -d /tmp/drafter-db-smoke.XXXXXX)"
PORT="${DB_SMOKE_PORT:-55432}"
export LC_ALL=C
cleanup() {
  pg_ctl -D "$WORK/data" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

initdb -D "$WORK/data" -U postgres --auth=trust --no-locale -E UTF8 >"$WORK/initdb.log" 2>&1
pg_ctl -D "$WORK/data" -l "$WORK/pg.log" -o "-p $PORT -k $WORK -c listen_addresses=''" start >"$WORK/start.log" 2>&1
for _ in $(seq 1 30); do
  if psql -h "$WORK" -p "$PORT" -U postgres -d postgres -c 'select 1' >/dev/null 2>&1; then break; fi
  sleep 0.5
done
PSQL=(psql -h "$WORK" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q)

echo "db-smoke: postgres $("${PSQL[@]}" -tAc 'show server_version') in $WORK"
"${PSQL[@]}" -f "$ROOT/scripts/db-smoke-stubs.sql"

count=0
MIGRATIONS="${DB_SMOKE_MIGRATIONS:-$ROOT/supabase/migrations}"
for f in "$MIGRATIONS"/*.sql; do
  if ! "${PSQL[@]}" -f "$f" >"$WORK/migrate.log" 2>&1; then
    echo "db-smoke: FAIL applying $(basename "$f")" >&2
    cat "$WORK/migrate.log" >&2
    exit 1
  fi
  count=$((count + 1))
done
echo "db-smoke: applied $count migrations"

# notices carry the per-step "ok" lines; anything raised stops psql with a non-zero exit
if "${PSQL[@]}" -f "$ROOT/scripts/db-smoke-assert.sql" 2>&1 | sed -n 's/^psql:.*NOTICE:  //p; /FAIL/p; /ERROR/p'; then
  status=${PIPESTATUS[0]}
else
  status=$?
fi
if [ "${status:-1}" -ne 0 ]; then
  echo "db-smoke: FAIL" >&2
  exit 1
fi
echo "db-smoke: PASS"
