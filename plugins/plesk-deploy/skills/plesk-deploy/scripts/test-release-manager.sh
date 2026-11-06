#!/usr/bin/env bash
#
# Exercises the release manager (templates/server/app-deploy, or a project's
# adapted copy) in a temporary folder, with stand-in pm2, node, migrations and
# health files. No server, no root, no network. Needs bash, tar, curl.
#
#   bash scripts/test-release-manager.sh [path/to/app-deploy]
#
# Run it after adapting the script for a project, and after any change to it.
# An adapted copy must keep the APP_DEPLOY_* overrides for this to work.

set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
MANAGER=${1:-$HERE/../templates/server/app-deploy}
[ -f "$MANAGER" ] || { echo "No release manager at $MANAGER" >&2; exit 2; }
MANAGER=$(cd "$(dirname "$MANAGER")" && pwd)/$(basename "$MANAGER")

T=$(mktemp -d "${TMPDIR:-/tmp}/rm-test.XXXXXX")
T=$(cd "$T" && pwd -P)
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/incoming" "$T/elsewhere" "$T/shared/uploads" "$T/state" "$T/health" "$T/build"
echo "SECRET=placeholder" > "$T/shared/app.env"

# ── Stand-ins ───────────────────────────────────────────────────────────────
# pm2: records calls; on (re)load, "starts" whatever current points at by
# copying its HEALTH and commit into the health files.
cat > "$T/bin/pm2" <<EOF
#!/usr/bin/env bash
echo "\$*" >> "$T/state/pm2.log"
case "\$1" in
  jlist) echo '[]' ;;
  delete) rm -f "$T/state/cwd-\$2" ;;
  startOrReload)
    cur="$T/base/current"
    cp "\$cur/HEALTH" "$T/health/status"
    sed -n 's/^commit=//p' "\$cur/RELEASE.txt" > "$T/health/commit"
    ;;
esac
exit 0
EOF
# node: the version check, and the PM2 cwd lookup (from a state file).
cat > "$T/bin/node" <<EOF
#!/usr/bin/env bash
case "\$1" in
  -p) echo "\${FAKE_NODE_MAJOR:-24}" ;;
  -e) cat >/dev/null; cat "$T/state/cwd-\$3" 2>/dev/null || true ;;
esac
EOF
chmod +x "$T/bin/pm2" "$T/bin/node"

write_conf() {   # write_conf <file> [extra lines]
  cat > "$1" <<EOF
BASE=$T/base
APP_USER=$(id -un)
INCOMING=$T/incoming
PROCESS_MANAGER=pm2
PM2_APPS="testapp-api=app"
SHARED_LINKS="app/.env=$T/shared/app.env app/uploads=$T/shared/uploads"
REQUIRED_FILES="RELEASE.txt ecosystem.config.js app/main.js"
PRE_MIGRATE_CMD='echo "backup \$RELEASE_ID" >> $T/state/backup.log'
MIGRATE_CMD="sh ./migrate.sh"
HEALTH_CHECKS="file://$T/health/status|ok"
HEALTH_COMMIT_URL=file://$T/health/commit
HEALTH_TIMEOUT_SECONDS=1
KEEP_RELEASES=3
LOG_FILE=$T/deploy.log
LOCK_FILE=$T/deploy.lock
${2:-}
EOF
}
write_conf "$T/deploy.conf"

export APP_DEPLOY_NAME=testapp APP_DEPLOY_CONF="$T/deploy.conf" APP_DEPLOY_REQUIRE_ROOT=0 APP_DEPLOY_RUN_AS_APP=0 \
  APP_DEPLOY_PM2="$T/bin/pm2" APP_DEPLOY_NODE="$T/bin/node"

# make_bundle <name> <commit> <ok|bad> <migrate exit> [node_major] [omit file]
make_bundle() {
  local name=$1 commit=$2 health=$3 mig=$4 major=${5:-24} omit=${6:-}
  local top="$T/build/$name/$name"
  rm -rf "$T/build/$name"; mkdir -p "$top/app"
  printf 'commit=%s\nnode_major=%s\n' "$commit" "$major" > "$top/RELEASE.txt"
  echo "module.exports = { apps: [] };" > "$top/ecosystem.config.js"
  echo "$health" > "$top/HEALTH"
  printf 'echo "migrate %s" >> %s/state/migrations.log\nexit %s\n' "$commit" "$T" "$mig" > "$top/migrate.sh"
  echo "console.log('$commit')" > "$top/app/main.js"
  [ -z "$omit" ] || rm -f "$top/$omit"
  tar -czf "$T/incoming/$name.tgz" -C "$T/build/$name" "$name"
}

deploy() { "$MANAGER" "$@" > "$T/last.out" 2>&1; local rc=$?; sleep 0.3; return $rc; }
live() { basename "$(readlink "$T/base/current" 2>/dev/null)" 2>/dev/null; }
live_commit() { sed -n 's/^commit=//p' "$T/base/current/RELEASE.txt" 2>/dev/null; }
failed_count() { ls -1 "$T/base/releases" 2>/dev/null | grep -c -- '-failed$' || true; }
good_count() { ls -1 "$T/base/releases" 2>/dev/null | grep -cE '^[0-9]{8}-[0-9]{6}$' || true; }

PASS=0; FAIL=0
check() {   # check <description> <command...>
  local what=$1; shift
  if "$@"; then PASS=$((PASS + 1)); printf '  ok    %s\n' "$what"
  else FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$what"; sed 's/^/        | /' "$T/last.out" | tail -n 8; fi
}
out_has() { grep -qF -- "$1" "$T/last.out"; }

echo "Release manager: $MANAGER"
echo "Scratch: $T"

echo "1. First deploy, moving a process off an old checkout"
echo "/old/checkout/app" > "$T/state/cwd-testapp-api"
make_bundle b1 c1111111 ok 0
deploy "$T/incoming/b1.tgz"; rc=$?
check "exits 0" [ "$rc" = 0 ]
check "c1 is live" [ "$(live_commit)" = c1111111 ]
check "env file linked" [ -L "$T/base/current/app/.env" ]
check "uploads linked" [ -L "$T/base/current/app/uploads" ]
check "backup ran with RELEASE_ID" grep -q "backup $(live)" "$T/state/backup.log"
check "migration ran" grep -q "migrate c1111111" "$T/state/migrations.log"
check "old-cwd process restarted from current" grep -q "^delete testapp-api" "$T/state/pm2.log"
check "pm2 reloaded and saved" grep -q "^save" "$T/state/pm2.log"
check "ecosystem copied beside current" [ -f "$T/base/ecosystem.config.js" ]
check "bundle removed from incoming" [ ! -e "$T/incoming/b1.tgz" ]
R1=$(live)

echo "2. Second deploy"
make_bundle b2 c2222222 ok 0
deploy b2.tgz; rc=$?
check "exits 0 (bare file name taken from INCOMING)" [ "$rc" = 0 ]
check "c2 is live" [ "$(live_commit)" = c2222222 ]
check "health reports c2" [ "$(cat "$T/health/commit")" = c2222222 ]
R2=$(live)

echo "3. Unhealthy release rolls back by itself"
make_bundle b3 c3333333 bad 0
deploy "$T/incoming/b3.tgz"; rc=$?
check "exits non-zero" [ "$rc" != 0 ]
check "back on release 2" [ "$(live)" = "$R2" ]
check "release 2 serving again" [ "$(cat "$T/health/commit")" = c2222222 ]
check "release marked -failed" [ "$(failed_count)" = 1 ]
check "says it failed its health checks" out_has "failed its health checks"

echo "4. Failed migration switches nothing"
: > "$T/state/pm2.log"
make_bundle b4 c4444444 ok 1
deploy "$T/incoming/b4.tgz"; rc=$?
check "exits non-zero" [ "$rc" != 0 ]
check "release 2 still live" [ "$(live)" = "$R2" ]
check "processes never reloaded" [ ! -s "$T/state/pm2.log" ]
check "says the migrations failed" out_has "The migrations failed"

echo "5. Incomplete bundle"
make_bundle b5 c5555555 ok 0 24 app/main.js
deploy "$T/incoming/b5.tgz"; rc=$?
check "refused" [ "$rc" != 0 ]
check "names the missing file" out_has "Missing from the release: app/main.js"
check "release 2 still live" [ "$(live)" = "$R2" ]

echo "6. Built for another Node major"
make_bundle b6 c6666666 ok 0 22
deploy "$T/incoming/b6.tgz"; rc=$?
check "refused" [ "$rc" != 0 ]
check "says why" out_has "built with Node 22"
check "release 2 still live" [ "$(live)" = "$R2" ]

echo "7. Bundles only from INCOMING, only .tgz"
make_bundle b7 c7777777 ok 0
mv "$T/incoming/b7.tgz" "$T/elsewhere/b7.tgz"
deploy "$T/elsewhere/b7.tgz"; rc=$?
check "outside INCOMING refused" [ "$rc" != 0 ]
check "says where bundles come from" out_has "only taken from"
echo x > "$T/incoming/x.zip"
deploy "$T/incoming/x.zip"; rc=$?
check "non-.tgz refused" [ "$rc" != 0 ]
ln -s "$T/elsewhere/b7.tgz" "$T/incoming/link.tgz"
deploy "$T/incoming/link.tgz"; rc=$?
check "symlinked bundle refused" [ "$rc" != 0 ]
deploy "$T/incoming/../elsewhere/b7.tgz"; rc=$?
check "../ escape refused" [ "$rc" != 0 ]
check "release 2 still live" [ "$(live)" = "$R2" ]

echo "8. A malformed SHARED_LINKS entry is refused, not obeyed"
write_conf "$T/bad.conf" 'SHARED_LINKS="=/tmp"'
make_bundle b8 c8888888 ok 0
APP_DEPLOY_CONF="$T/bad.conf" deploy "$T/incoming/b8.tgz"; rc=$?
check "refused" [ "$rc" != 0 ]
check "release 2 still live" [ "$(live)" = "$R2" ]
check "says the entry is malformed" out_has "must be path/in/release=/absolute/target"

echo "9. --rollback and --status"
deploy --rollback; rc=$?
check "rollback exits 0" [ "$rc" = 0 ]
check "release 1 is live" [ "$(live)" = "$R1" ]
check "release 1 serving" [ "$(cat "$T/health/commit")" = c1111111 ]
deploy --status; rc=$?
check "status exits 0" [ "$rc" = 0 ]
check "status marks the live release" grep -qE "^\* $R1" "$T/last.out"
check "status lists failed releases" grep -q -- "-failed" "$T/last.out"

echo "10. Deploying after a rollback, and pruning to KEEP_RELEASES=3"
for n in 1 2 3; do
  make_bundle "p$n" "cp00000$n" ok 0
  deploy "$T/incoming/p$n.tgz" || true
done
check "newest is live" [ "$(live_commit)" = cp000003 ]
check "at most 3 good releases kept" [ "$(good_count)" -le 3 ]
check "at most 3 failed releases kept" [ "$(failed_count)" -le 3 ]

echo "11. One deploy at a time"
make_bundle b11 c1100000 ok 0
if command -v flock >/dev/null 2>&1; then
  ( exec 9>"$T/deploy.lock"; flock 9; sleep 4 ) & holder=$!
  sleep 0.5
else
  mkdir "$T/deploy.lock.d"; holder=""
fi
deploy "$T/incoming/b11.tgz"; rc=$?
check "second deploy refused while locked" [ "$rc" != 0 ]
check "says another deploy is running" out_has "Another deploy is running"
if [ -n "$holder" ]; then wait "$holder"; else rmdir "$T/deploy.lock.d"; fi
deploy "$T/incoming/b11.tgz"; rc=$?
check "deploys once the lock is free" [ "$rc" = 0 ]

echo "12. Rolling back with nothing older"
rm -rf "$T/base"; mkdir -p "$T/base"
deploy --rollback; rc=$?
check "refused clearly" [ "$rc" != 0 ]
check "says there is nothing to roll back to" out_has "no earlier release"

echo "13. --log reads the end of the deploy log, and nothing else"
deploy --log 3; rc=$?
check "log exits 0" [ "$rc" = 0 ]
check "at most 3 lines" [ "$(grep -c . "$T/last.out")" -le 3 ]
check "shows the newest entries" out_has "no earlier release"
deploy --log abc; rc=$?
check "a non-number is refused" [ "$rc" != 0 ]
deploy --log 0; rc=$?
check "zero lines is refused" [ "$rc" != 0 ]
deploy --log "/etc/passwd"; rc=$?
check "a path is refused" [ "$rc" != 0 ]
check "usage lists --log" sh -c "\"$MANAGER\" --help | grep -q -- '--log'"

echo
echo "$PASS passed, $FAIL failed."
[ "$FAIL" = 0 ]
