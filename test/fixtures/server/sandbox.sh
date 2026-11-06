#!/usr/bin/env bash
#
# Builds a stand-in "server" in a folder: the real release manager, a
# deploy.conf, stand-in pm2/node, and two deployed releases (c1111111 live
# first, then c2222222). The fake ssh's handler runs the release manager here.
#
#   bash sandbox.sh <dir> <path/to/app-deploy>
set -euo pipefail
D=$1
MANAGER=$2
mkdir -p "$D/bin" "$D/incoming" "$D/health" "$D/state" "$D/build"

cat > "$D/bin/pm2" <<EOF
#!/usr/bin/env bash
case "\$1" in
  jlist) echo '[]' ;;
  startOrReload)
    cp "$D/base/current/HEALTH" "$D/health/status"
    sed -n 's/^commit=//p' "$D/base/current/RELEASE.txt" > "$D/health/commit" ;;
esac
exit 0
EOF
cat > "$D/bin/node" <<'EOF'
#!/usr/bin/env bash
case "$1" in -p) echo 24 ;; -e) cat >/dev/null ;; esac
EOF
chmod +x "$D/bin/pm2" "$D/bin/node"

cat > "$D/deploy.conf" <<EOF
BASE=$D/base
APP_USER=$(id -un)
INCOMING=$D/incoming
PROCESS_MANAGER=pm2
REQUIRED_FILES="RELEASE.txt ecosystem.config.js"
HEALTH_CHECKS="file://$D/health/status|ok"
HEALTH_COMMIT_URL=file://$D/health/commit
HEALTH_TIMEOUT_SECONDS=1
KEEP_RELEASES=5
LOG_FILE=$D/deploy.log
LOCK_FILE=$D/deploy.lock
EOF

cat > "$D/env.sh" <<EOF
export MANAGER="$MANAGER"
export APP_DEPLOY_NAME=acme APP_DEPLOY_CONF="$D/deploy.conf" APP_DEPLOY_REQUIRE_ROOT=0 APP_DEPLOY_RUN_AS_APP=0
export APP_DEPLOY_PM2="$D/bin/pm2" APP_DEPLOY_NODE="$D/bin/node"
EOF
# shellcheck disable=SC1091
. "$D/env.sh"

for commit in c1111111 c2222222; do
  top="$D/build/$commit/$commit"
  mkdir -p "$top"
  printf 'commit=%s\nnode_major=24\n' "$commit" > "$top/RELEASE.txt"
  echo "module.exports = { apps: [] };" > "$top/ecosystem.config.js"
  echo ok > "$top/HEALTH"
  tar -czf "$D/incoming/$commit.tgz" -C "$D/build/$commit" "$commit"
  "$MANAGER" "$D/incoming/$commit.tgz" > /dev/null 2>&1
  sleep 1   # release ids have one-second resolution
done
