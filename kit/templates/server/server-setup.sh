#!/usr/bin/env bash
#
# TEMPLATE — one-time set-up of a Plesk server for deploys from GitHub Actions.
# Run as root, from the folder this kit was copied to. Safe to run again: every
# step checks what is already there, and nothing that exists is overwritten.
#
#   sudo bash server-setup.sh [--public-key <file.pub>] [--from-checkout <folder>]
#
#   --public-key     the deploy key's public half (GitHub Actions signs in with the private half)
#   --from-checkout  the folder the site runs from today: its env file and uploads
#                    are COPIED (never moved) to the shared places
#
# The first run with no /etc/<app>/deploy.conf writes one from
# deploy.conf.example and stops, so it can be filled in from the server's facts.
#
# ADAPT: APP_NAME, the kit's file names, CHECKOUT_ENV / CHECKOUT_UPLOADS, the
# placeholder env keys, and the database check. Delete what the stack does not use.

set -Eeuo pipefail

APP_NAME=myapp                                  # ADAPT
CHECKOUT_ENV=.env                               # ADAPT: the env file, relative to the old checkout
CHECKOUT_UPLOADS=uploads                        # ADAPT: run-time files, relative to the old checkout ("" for none)

KIT=$(cd "$(dirname "$0")" && pwd)
CONF=/etc/$APP_NAME/deploy.conf
MANAGER=/usr/local/bin/$APP_NAME-deploy
BACKUP_HELPER=/usr/local/bin/$APP_NAME-db-backup
PUBLIC_KEY=""
CHECKOUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --public-key) PUBLIC_KEY=$2; shift 2 ;;
    --from-checkout) CHECKOUT=$2; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

say() { printf '  %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
stop() { printf '\nSTOPPED: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || stop "Run it as root: sudo bash $0 $*"

# ── Settings ────────────────────────────────────────────────────────────────
step "Settings ($CONF)"
if [ ! -f "$CONF" ]; then
  install -d -m 755 "/etc/$APP_NAME"
  install -m 644 "$KIT/deploy.conf.example" "$CONF"
  stop "Wrote $CONF from the example. Fill it in from the server's facts (APP_USER, APP_GROUP, NODE_BIN_DIR, PM2_HOME, paths), then run this again."
fi
# shellcheck disable=SC1090
. "$CONF"
for setting in BASE APP_USER DEPLOY_USER INCOMING PROCESS_MANAGER; do
  [ -n "${!setting:-}" ] || stop "$setting is empty in $CONF."
done
APP_GROUP=${APP_GROUP:-$APP_USER}
SHARED_DIR=${SHARED_DIR:-$BASE/shared}
BACKUP_DIR=${BACKUP_DIR:-/var/backups/$APP_NAME}
LOG_FILE=${LOG_FILE:-/var/log/$APP_NAME-deploy.log}
id "$APP_USER" >/dev/null 2>&1 || stop "APP_USER $APP_USER does not exist on this server."
getent group "$APP_GROUP" >/dev/null || stop "APP_GROUP $APP_GROUP does not exist on this server."
[ "$APP_USER" != root ] || say "NOTE: the app runs as root. It works, but the subscription's system user would be safer (a separate change)."

case "$PROCESS_MANAGER" in
  pm2)
    [ -x "${NODE_BIN_DIR:-}/node" ] || stop "There is no node in NODE_BIN_DIR (${NODE_BIN_DIR:-empty})."
    pm2_bin=${PM2_BIN:-$NODE_BIN_DIR/pm2}
    [ -x "$pm2_bin" ] || stop "There is no pm2 at $pm2_bin. Set PM2_BIN, or install it for that Node: $NODE_BIN_DIR/npm install -g pm2"
    say "Apps run as $APP_USER:$APP_GROUP on Node $("$NODE_BIN_DIR/node" -v), PM2 $pm2_bin."
    ;;
  systemd)
    for unit in ${SYSTEMD_UNITS:-}; do
      systemctl cat "$unit" >/dev/null 2>&1 || say "NOTE: unit $unit is not installed yet (templates/process/app.service)."
    done
    ;;
  php-fpm)
    [ -n "${PHP_FPM_SERVICE:-}" ] || stop "PHP_FPM_SERVICE is empty: systemctl list-units 'plesk-php*' shows the domain's."
    systemctl cat "$PHP_FPM_SERVICE" >/dev/null 2>&1 || stop "There is no service $PHP_FPM_SERVICE."
    ;;
  none) ;;
  *) stop "PROCESS_MANAGER must be pm2, systemd, php-fpm or none." ;;
esac

# ── The deploy user ─────────────────────────────────────────────────────────
step "Deploy user ($DEPLOY_USER)"
if id "$DEPLOY_USER" >/dev/null 2>&1; then
  say "Exists."
else
  useradd --create-home --shell /bin/bash "$DEPLOY_USER"
  say "Created."
fi
deploy_home=$(getent passwd "$DEPLOY_USER" | cut -d: -f6)
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$deploy_home/.ssh" "$INCOMING"
keys="$deploy_home/.ssh/authorized_keys"
touch "$keys"
chown "$DEPLOY_USER:$DEPLOY_USER" "$keys"
chmod 600 "$keys"
if [ -n "$PUBLIC_KEY" ]; then
  [ -r "$PUBLIC_KEY" ] || stop "Cannot read $PUBLIC_KEY."
  key=$(cat "$PUBLIC_KEY")
  case "$key" in ssh-ed25519\ *) ;; *) stop "$PUBLIC_KEY is not an ed25519 public key (it should start with ssh-ed25519)." ;; esac
  if grep -qF "$key" "$keys"; then
    say "The deploy key is already authorised."
  else
    # No terminal, no forwarding: it uploads a bundle and runs one command.
    printf 'restrict %s\n' "$key" >> "$keys"
    say "Authorised the deploy key."
  fi
elif [ ! -s "$keys" ]; then
  say "NOTE: no key is authorised yet. Run again with --public-key <file.pub>."
fi

# ── What the deploy user may run ────────────────────────────────────────────
step "sudo rule"
rule=/etc/sudoers.d/$APP_NAME-deploy
tmp=$(mktemp)
cat > "$tmp" <<SUDOERS
# GitHub Actions deploys $APP_NAME by running this one command, and nothing else.
Defaults:$DEPLOY_USER !requiretty
$DEPLOY_USER ALL=(root) NOPASSWD: $MANAGER
SUDOERS
visudo -cf "$tmp" >/dev/null || { rm -f "$tmp"; stop "The sudo rule did not validate; nothing was changed."; }
if [ -f "$rule" ] && cmp -s "$tmp" "$rule"; then
  rm -f "$tmp"; say "In place."
else
  install -m 440 -o root -g root "$tmp" "$rule"; rm -f "$tmp"; say "Installed $rule."
fi

# ── Folders ─────────────────────────────────────────────────────────────────
step "Folders"
install -d -m 755 -o "$APP_USER" -g "$APP_GROUP" "$BASE" "$BASE/releases" "$SHARED_DIR"
install -d -m 700 -o root -g root "$BACKUP_DIR"
touch "$LOG_FILE"; chmod 640 "$LOG_FILE"
say "$BASE, $SHARED_DIR, $BACKUP_DIR and $LOG_FILE are ready."

# ── The app's settings ──────────────────────────────────────────────────────
if [ -n "${ENV_FILE:-}" ]; then
  step "App settings ($ENV_FILE)"
  install -d -m 755 "$(dirname "$ENV_FILE")"
  if [ -f "$ENV_FILE" ]; then
    say "Exists; left as it is."
  elif [ -n "$CHECKOUT" ] && [ -f "$CHECKOUT/$CHECKOUT_ENV" ]; then
    install -m 640 -o root -g "$APP_GROUP" "$CHECKOUT/$CHECKOUT_ENV" "$ENV_FILE"
    say "Copied from $CHECKOUT/$CHECKOUT_ENV. The original is untouched."
  else
    install -m 640 -o root -g "$APP_GROUP" /dev/null "$ENV_FILE"
    # ADAPT: the names from .env.example, no values.
    printf '%s\n' '# The app'"'"'s run-time settings. Names from .env.example; fill in on the server only.' \
      'NODE_ENV=production' 'PORT=' 'DB_HOST=127.0.0.1' 'DB_PORT=' 'DB_NAME=' 'DB_USER=' 'DB_PASSWORD=' > "$ENV_FILE"
    say "Created with empty values. Fill it in before the first deploy."
  fi
  chown root:"$APP_GROUP" "$ENV_FILE"; chmod 640 "$ENV_FILE"
  missing=$(grep -cE '^[A-Z0-9_]+=$' "$ENV_FILE" || true)
  [ "$missing" = 0 ] || say "NOTE: $missing setting(s) in $ENV_FILE are empty."
fi

# ── Run-time files ──────────────────────────────────────────────────────────
for entry in ${SHARED_LINKS:-}; do
  target=${entry#*=}
  case "$target" in "$SHARED_DIR"/*) [ -e "$target" ] || install -d -m 755 -o "$APP_USER" -g "$APP_GROUP" "$target" ;; esac
done
if [ -n "$CHECKOUT" ] && [ -n "$CHECKOUT_UPLOADS" ] && [ -d "$CHECKOUT/$CHECKOUT_UPLOADS" ]; then
  step "Run-time files"
  dest="$SHARED_DIR/$(basename "$CHECKOUT_UPLOADS")"
  install -d -m 755 -o "$APP_USER" -g "$APP_GROUP" "$dest"
  cp -Rpn "$CHECKOUT/$CHECKOUT_UPLOADS/." "$dest/"   # copies what is missing; never overwrites or deletes
  chown -R "$APP_USER:$APP_GROUP" "$dest"
  say "Copied from $CHECKOUT/$CHECKOUT_UPLOADS to $dest."
fi

# ── The release manager and the backup helper ───────────────────────────────
step "Release manager ($MANAGER)"
install -m 755 -o root -g root "$KIT/$APP_NAME-deploy" "$MANAGER"
say "Installed."
if [ -f "$KIT/$APP_NAME-db-backup" ]; then
  install -m 755 -o root -g root "$KIT/$APP_NAME-db-backup" "$BACKUP_HELPER"
  say "Installed $BACKUP_HELPER."
fi

# ── The database login (ADAPT or delete) ────────────────────────────────────
if [ -n "${ENV_FILE:-}" ] && [ -f "$ENV_FILE" ]; then
  step "Database login"
  value() { awk -v key="$1" 'index($0, key "=") == 1 { v = substr($0, length(key) + 2); if (v ~ /^".*"$/ || v ~ /^\047.*\047$/) v = substr(v, 2, length(v) - 2); print v; exit }' "$ENV_FILE"; }
  db_user=$(value DB_USER); db_name=$(value DB_NAME)
  if [ -z "$db_user" ] || [ -z "$db_name" ]; then
    say "DB_USER or DB_NAME is empty in $ENV_FILE; checked on the next run."
  elif command -v psql >/dev/null 2>&1; then
    if PGPASSWORD=$(value DB_PASSWORD) psql -h "$(value DB_HOST)" -p "$(value DB_PORT | grep . || echo 5432)" \
      -U "$db_user" -d "$db_name" -tAc 'select current_user' >/dev/null 2>&1; then
      say "$db_user can sign in to $db_name."
    else
      stop "$db_user cannot sign in to $db_name with the settings in $ENV_FILE. Plesk may have prefixed the names: check Databases in Plesk."
    fi
  elif command -v mysql >/dev/null 2>&1; then
    if MYSQL_PWD=$(value DB_PASSWORD) mysql -h "$(value DB_HOST)" -P "$(value DB_PORT | grep . || echo 3306)" \
      -u "$db_user" "$db_name" -e 'select current_user()' >/dev/null 2>&1; then
      say "$db_user can sign in to $db_name."
    else
      stop "$db_user cannot sign in to $db_name with the settings in $ENV_FILE. Plesk may have prefixed the names: check Databases in Plesk."
    fi
  else
    say "No psql or mysql client here, so the login was not checked. The pre-migration dump needs one."
  fi
fi

step "Done"
say "Nothing in the old checkout was changed; the site keeps running from it until the first deploy."
say "Check: sudo -l -U $DEPLOY_USER   (only $MANAGER)"
say "Check: sudo $MANAGER --status"
if [ "$PROCESS_MANAGER" = pm2 ]; then
  say "PM2 must start on boot for $APP_USER: sudo env PATH=$NODE_BIN_DIR:\$PATH pm2 startup systemd -u $APP_USER --hp $(getent passwd "$APP_USER" | cut -d: -f6)"
fi
say "Next (deploy/plesk/README.md): the GitHub environment, secrets and variables, then the first deploy."
