#!/bin/sh
set -eu

mkdir -p /run/clamav /var/log/clamav
chown -R clamav:clamav /run/clamav /var/log/clamav /var/lib/clamav
freshclam || true
clamd --config-file=/etc/clamav/clamd.conf &

i=0
while [ ! -S /run/clamav/clamd.ctl ] && [ "$i" -lt 60 ]; do
  i=$((i + 1))
  sleep 1
done

exec node /app/server.mjs
