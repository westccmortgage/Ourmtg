#!/bin/sh
set -eu

mkdir -p /run/clamav /var/log/clamav
chown -R clamav:clamav /run/clamav /var/log/clamav /var/lib/clamav
freshclam || true
freshclam -d -c 12 || true
clamd --config-file=/etc/clamav/clamd.conf &

i=0
while [ ! -S /run/clamav/clamd.ctl ] && [ "$i" -lt 60 ]; do
  i=$((i + 1))
  sleep 1
done

if [ ! -S /run/clamav/clamd.ctl ]; then
  echo "ClamAV socket did not become ready" >&2
  exit 1
fi

if ! command -v clamdscan >/dev/null 2>&1; then
  echo "clamdscan executable is missing" >&2
  exit 1
fi

exec node /app/server.mjs
