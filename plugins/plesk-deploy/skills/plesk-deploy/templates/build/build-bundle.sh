#!/usr/bin/env bash
#
# TEMPLATE — build-bundle.sh: builds one self-contained release bundle on the CI
# runner. The server only unpacks it; nothing is installed or built there.
#
#   STACK=node|next|static|laravel APP_NAME=myapp [build-time values] \
#     deploy/plesk/build-bundle.sh --app-dir <checkout> --tooling-dir <checkout> --out <dir>
#
# --app-dir is the commit being released; --tooling-dir is where this script and
# the process config come from (the newest, even when releasing an older commit).
#
# Produces <out>/<APP_NAME>-<short sha>-<UTC time>.tgz with one top folder:
#   RELEASE.txt              commit, ref, built_at, node_major/php_version, stack
#   ecosystem.config.js      PM2 only, from the tooling checkout
#   ...                      the app, laid out as the server runs it
#
# ADAPT: pick the STACK branch that fits, change its paths, delete the others.
# Monorepos: stage each app into its own folder (api/, web/) the same way, and
# install each app's production dependencies separately (npm ci --workspace=<app>
# --omit=dev in a clean copy), then remove the symlinks npm makes for sibling
# workspaces. See references/hosting-models.md.

set -Eeuo pipefail

APP_DIR=.
TOOLING_DIR=.
OUT_DIR=./release-bundle
while [ $# -gt 0 ]; do
  case "$1" in
    --app-dir) APP_DIR=$2; shift 2 ;;
    --tooling-dir) TOOLING_DIR=$2; shift 2 ;;
    --out) OUT_DIR=$2; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

APP_NAME=${APP_NAME:-myapp}            # ADAPT
STACK=${STACK:-node}                   # ADAPT
STATIC_DIR=${STATIC_DIR:-dist}         # static: the build output folder (build/, out/, dist/<project>/browser)
# ADAPT: build-time values the build needs; fail early with where to set them.
# : "${PUBLIC_API_URL:?Set the repository variable PUBLIC_API_URL}"

APP_DIR=$(cd "$APP_DIR" && pwd)
TOOLING_DIR=$(cd "$TOOLING_DIR" && pwd)
mkdir -p "$OUT_DIR"
OUT_DIR=$(cd "$OUT_DIR" && pwd)

COMMIT=$(git -C "$APP_DIR" rev-parse HEAD)
REF=${RELEASE_REF:-$(git -C "$APP_DIR" rev-parse --abbrev-ref HEAD)}
STAMP=$(date -u +%Y%m%d-%H%M%S)
NAME="${APP_NAME}-${COMMIT:0:7}-${STAMP}"
WORK=$(mktemp -d)
STAGE="$WORK/$NAME"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$STAGE"

step() { echo "::group::$*"; }
done_step() { echo "::endgroup::"; }

# Only tracked files, never a stray .env or local build output.
export_source() { git -C "$APP_DIR" archive --format=tar HEAD | tar -x -C "$1"; }

RUNTIME_LINE=""
case "$STACK" in
  node)
    # A single Node service built to dist/ and started with `node dist/main.js`.
    step "Building $COMMIT (node)"
    SRC="$WORK/src"; mkdir -p "$SRC"; export_source "$SRC"
    (cd "$SRC" && npm ci && NODE_ENV=production npm run build)
    cp -R "$SRC/dist" "$STAGE/dist"
    cp "$SRC/package.json" "$SRC/package-lock.json" "$STAGE/"
    # ADAPT: anything else the code reads at run time (templates, JSON data, prisma/).
    (cd "$STAGE" && NODE_ENV=production npm ci --omit=dev)
    RUNTIME_LINE="node_major=$(node -p 'process.versions.node.split(".")[0]')"
    REQUIRED="dist package.json node_modules"
    done_step
    ;;
  next)
    # Next.js with `next start`. With output: 'standalone', ship .next/standalone,
    # .next/static and public instead, and start with `node server.js`.
    step "Building $COMMIT (next)"
    SRC="$WORK/src"; mkdir -p "$SRC"; export_source "$SRC"
    (cd "$SRC" && npm ci && NODE_ENV=production npm run build)
    mkdir -p "$STAGE/.next"
    (cd "$SRC/.next" && tar -cf - --exclude=./cache .) | tar -xf - -C "$STAGE/.next"
    cp -R "$SRC/public" "$STAGE/public" 2>/dev/null || true
    for f in next.config.js next.config.mjs next.config.ts package.json package-lock.json; do
      [ -f "$SRC/$f" ] && cp "$SRC/$f" "$STAGE/"
    done
    (cd "$STAGE" && NODE_ENV=production npm ci --omit=dev)
    RUNTIME_LINE="node_major=$(node -p 'process.versions.node.split(".")[0]')"
    REQUIRED=".next/BUILD_ID package.json node_modules"
    done_step
    ;;
  static)
    # React/Vite/Angular: the build output is the release. version.json lets the
    # pipeline and the release manager see which commit is being served.
    step "Building $COMMIT (static)"
    SRC="$WORK/src"; mkdir -p "$SRC"; export_source "$SRC"
    (cd "$SRC" && npm ci && NODE_ENV=production npm run build)
    cp -R "$SRC/$STATIC_DIR/." "$STAGE/"
    printf '{"commit":"%s","built_at":"%s"}\n' "$COMMIT" "$STAMP" > "$STAGE/version.json"
    REQUIRED="index.html version.json"
    done_step
    ;;
  laravel)
    # Laravel: vendor/ and built assets in; node_modules, tests and .env out.
    # shared/.env and shared/storage are linked in by the release manager.
    step "Building $COMMIT (laravel)"
    export_source "$STAGE"
    (cd "$STAGE" && composer install --no-dev --optimize-autoloader --no-interaction --no-progress)
    if [ -f "$STAGE/package.json" ]; then
      (cd "$STAGE" && npm ci && npm run build && rm -rf node_modules)
    fi
    rm -rf "$STAGE/tests" "$STAGE/storage"   # storage is shared on the server
    RUNTIME_LINE="php_version=$(php -r 'echo PHP_MAJOR_VERSION.".".PHP_MINOR_VERSION;')"
    REQUIRED="artisan vendor/autoload.php public/index.php"
    done_step
    ;;
  *) echo "Unknown STACK: $STACK" >&2; exit 2 ;;
esac

# The PM2 processes, from the newest tooling (PM2 only; delete otherwise).
if [ -f "$TOOLING_DIR/deploy/plesk/ecosystem.config.js" ]; then
  cp "$TOOLING_DIR/deploy/plesk/ecosystem.config.js" "$STAGE/ecosystem.config.js"
fi

cat > "$STAGE/RELEASE.txt" <<EOF
commit=$COMMIT
ref=$REF
built_at=$STAMP
stack=$STACK
$RUNTIME_LINE
workflow_run=${GITHUB_SERVER_URL:-}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-local}
EOF

# ── Checks: a bundle that would fail on the server fails here instead ───────
step "Checking the bundle"
for f in RELEASE.txt $REQUIRED; do
  [ -e "$STAGE/$f" ] || { echo "::error::The bundle is missing $f"; exit 1; }
done
# No secrets or repository internals.
bad=$(find "$STAGE" \( -name '.env' -o -name '.env.*' -o -name '.git' \) ! -name '*.example' -not -path '*/node_modules/*' -print | /usr/bin/head -5 || true)
[ -z "$bad" ] || { echo "::error::The bundle contains files that must never ship: $bad"; exit 1; }
# No symlink that points outside the bundle (a workspace link back into the runner).
STAGE_REAL=$(cd "$STAGE" && pwd -P)
escaping_links() {
  local link target
  find "$STAGE" -type l | while read -r link; do
    target=$(cd "$(dirname "$link")" && cd "$(dirname "$(readlink "$link")")" 2>/dev/null && pwd -P || echo MISSING)
    case "$target" in
      "$STAGE_REAL" | "$STAGE_REAL"/*) ;;
      *) echo "$link -> $(readlink "$link")" ;;
    esac
  done
}
escaping=$(escaping_links | /usr/bin/head -5)
[ -z "$escaping" ] || { echo "::error::Symlinks point outside the bundle: $escaping"; exit 1; }
done_step

tar -czf "$OUT_DIR/$NAME.tgz" -C "$WORK" "$NAME"
echo "Bundle: $OUT_DIR/$NAME.tgz ($(du -h "$OUT_DIR/$NAME.tgz" | cut -f1))"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "name=$NAME.tgz" >> "$GITHUB_OUTPUT"
  echo "commit=$COMMIT" >> "$GITHUB_OUTPUT"
fi
