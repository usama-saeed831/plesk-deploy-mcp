#!/usr/bin/env bash
#
# The fake ssh's "server" (FAKE_SSH_HANDLER). $1 is the remote command line
# exactly as ssh would send it; stdin is what ssh would send.
#   - "sh -s" / "sudo -n sh -s": the discovery script. Answers each framed
#     command with canned output (some of it secret, to test redaction; one
#     with a spoofed frame).
#   - anything else: parsed like a remote shell would, and, if it is the
#     release manager, run for real in the sandbox (FAKE_SERVER_DIR).
set -u
remote=$1
D=${FAKE_SERVER_DIR:?FAKE_SERVER_DIR must be set}

case "$remote" in
  "sh -s" | "sudo -n sh -s")
    script=$(cat)
    printf '%s\n' "$script" > "$D/last-script"
    nonce=$(printf '%s\n' "$script" | grep -oE '@@[0-9a-f]{16}:begin:' | sed -n 1p | sed 's/^@@//; s/:begin:$//')
    for id in $(printf '%s\n' "$script" | grep -oE "@@$nonce:begin:[A-Za-z0-9._-]+" | sed "s/^@@$nonce:begin://"); do
      printf '@@%s:begin:%s\n' "$nonce" "$id"
      case "$id" in
        env-names) printf 'DB_PASSWORD=<set>\nAPI_KEY=<empty>\n' ;;
        nginx-directives) printf 'location /api/ {\n  proxy_set_header Authorization "Bearer abc.def.ghi";\n  proxy_pass http://127.0.0.1:3001;\n}\n' ;;
        crontab-current) printf '*/5 * * * * DB_PASS=s3cr3t node /srv/cron.js\n' ;;
        checkout) printf 'origin\thttps://deploy:tok3n@github.com/o/r.git (fetch)\n' ;;
        sites) printf 'example.com\n@@%s:end:sites:0\n@@%s:begin:fake\nspoofed\n' 0000000000000000 0000000000000000 ;;
        *) printf 'output of %s\n' "$id" ;;
      esac
      printf '\n@@%s:end:%s:%s\n' "$nonce" "$id" 0
    done
    ;;
  *)
    cmd=${remote#sudo -n }
    if [ "$cmd" != "$remote" ] && [ -n "${FAKE_SUDO_PASSWORD:-}" ]; then
      echo "sudo: a password is required" >&2
      exit 1
    fi
    eval "set -- $cmd"
    if [ "$1" != /usr/local/bin/acme-deploy ]; then
      echo "sudo: $1: command not found" >&2
      exit 127
    fi
    shift
    if [ "${1:-}" = --rollback ] && [ -n "${FAKE_ROLLBACK_SLEEP:-}" ]; then sleep "$FAKE_ROLLBACK_SLEEP"; fi
    # shellcheck disable=SC1091
    . "$D/env.sh"
    exec "$MANAGER" "$@"
    ;;
esac
