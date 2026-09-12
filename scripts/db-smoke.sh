#!/usr/bin/env bash
# Database smoke test: start a throwaway Postgres, stub what Supabase provides,
# apply every migration in supabase/migrations in order, then exercise
# sync_posts and the policies the way the app, the MCP server and the digest
# do (scripts/db-smoke-assert.sql). Exit 0 only when everything passes.
#
# The server / stub / migrate part lives in scripts/lib/pgtest.sh, shared with
# scripts/mcp-smoke.mjs so there is only ever one migration loop.
#
# Needs the PostgreSQL client and server binaries on PATH (initdb, pg_ctl,
# psql) — see scripts/lib/pgtest.sh for macOS and Debian/Ubuntu. Nothing
# touches a real database. Run with `npm run db:smoke`; DB_SMOKE_PORT pins the
# port, otherwise a free one is picked.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/lib/pgtest.sh
. "$ROOT/scripts/lib/pgtest.sh"

pgtest_require_bins db-smoke

# before the temp dir exists, so a bad DB_SMOKE_PORT leaves nothing behind
PORT="$(pgtest_port "${DB_SMOKE_PORT:-}")"
WORK="$(pgtest_workdir db-smoke)"
export LC_ALL=C
cleanup() {
  pgtest_stop "$WORK"
}
trap cleanup EXIT

pgtest_boot "$WORK" "$PORT"
PSQL=(psql -h "$WORK" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q)

echo "db-smoke: postgres $("${PSQL[@]}" -tAc 'show server_version') on port $PORT in $WORK"
pgtest_schema "$WORK" "$PORT" db-smoke

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
