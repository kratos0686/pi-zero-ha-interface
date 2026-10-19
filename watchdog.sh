#!/bin/sh
# Restart the kiosk when the dashboard has had no connection to Home
# Assistant for several minutes in a row (e.g. Chromium stuck on a blank
# screen after boot). Run every minute by ha-watchdog.timer.
set -eu
CONFIG="${HA_DASH_CONFIG:-/opt/ha-dashboard/config.json}"
STATE=/run/ha-watchdog.count
LIMIT="${HA_WATCHDOG_MINUTES:-4}"

systemctl is-active --quiet ha-kiosk.service || exit 0
# Give a freshly started kiosk time to come up.
started=$(systemctl show -p ActiveEnterTimestampMonotonic --value ha-kiosk.service)
now=$(cut -d' ' -f1 /proc/uptime | cut -d. -f1)
[ $((now - started / 1000000)) -lt 180 ] && { echo 0 > "$STATE"; exit 0; }

hostport=$(python3 -c 'import json,sys
from urllib.parse import urlsplit
u = urlsplit(json.load(open(sys.argv[1]))["ha_url"].strip())
print("%s:%d" % (u.hostname, u.port or (443 if u.scheme == "https" else 80)))' "$CONFIG")
# Is Home Assistant itself up? If not, restarting the browser won't help.
host=${hostport%:*}; port=${hostport##*:}
if ! python3 -c 'import socket, sys
socket.create_connection((sys.argv[1], int(sys.argv[2])), 5).close()' "$host" "$port" 2>/dev/null; then
  echo 0 > "$STATE"
  exit 0
fi

if ss -Htn state established "dst $host" | grep -q ":$port\b"; then
  echo 0 > "$STATE"
  exit 0
fi
n=$(( $(cat "$STATE" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$STATE"
if [ "$n" -ge "$LIMIT" ]; then
  echo "no connection to Home Assistant for $n min: restarting ha-kiosk"
  echo 0 > "$STATE"
  systemctl restart ha-kiosk.service
fi
