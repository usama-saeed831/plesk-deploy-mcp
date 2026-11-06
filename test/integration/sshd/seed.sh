#!/usr/bin/env bash
# Deploys two releases (c1111111, then c2222222) with the real release manager,
# as root, while the image is built. The log ends up root-only, as on a server.
set -euo pipefail
work=$(mktemp -d)
for commit in c1111111 c2222222; do
  mkdir -p "$work/$commit/$commit"
  printf 'commit=%s\n' "$commit" > "$work/$commit/$commit/RELEASE.txt"
  echo ok > "$work/$commit/$commit/HEALTH"
  tar -czf "/home/acme-deploy/incoming/$commit.tgz" -C "$work/$commit" "$commit"
  /usr/local/bin/acme-deploy "/home/acme-deploy/incoming/$commit.tgz"
  sleep 1
done
chmod 640 /var/log/acme-deploy.log
rm -rf "$work"
/usr/local/bin/acme-deploy --status
