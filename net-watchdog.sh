#!/bin/sh
# Wi-Fi watchdog: the Zero 2 W's onboard Wi-Fi sometimes drops off the
# network and never comes back. Run every minute by ha-net-watchdog.timer;
# escalates the longer the gateway stays unreachable:
#   2 min  -> ask NetworkManager to reconnect wlan0
#   5 min  -> turn the Wi-Fi radio off and on
#   8 min  -> reload the brcmfmac Wi-Fi driver
#   15 min -> reboot
set -u
STATE=/run/ha-net-watchdog.count
IFACE="${HA_NET_IFACE:-wlan0}"

gw=$(ip -4 route show default 2>/dev/null | awk '{print $3; exit}')
if [ -n "$gw" ] && ping -c 3 -W 3 -q "$gw" >/dev/null 2>&1; then
  echo 0 > "$STATE"
  exit 0
fi

# Actions are also logged (newest last) for the dashboard's status tile.
log() { echo "$*"; echo "$(date '+%Y-%m-%d %H:%M') $*" >> /run/ha-net-watchdog.log; tail -n 20 /run/ha-net-watchdog.log > /run/ha-net-watchdog.log.tmp && mv /run/ha-net-watchdog.log.tmp /run/ha-net-watchdog.log; chmod 644 /run/ha-net-watchdog.log; }
n=$(( $(cat "$STATE" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$STATE"
echo "gateway ${gw:-<none>} unreachable for $n min"

case "$n" in
  2|3)
    log "reconnecting $IFACE"
    nmcli device connect "$IFACE" ;;
  5)
    log "toggled the Wi-Fi radio"
    nmcli radio wifi off; sleep 5; nmcli radio wifi on ;;
  8)
    log "reloaded the Wi-Fi driver"
    modprobe -r brcmfmac_wcc brcmfmac 2>/dev/null; sleep 3; modprobe brcmfmac
    sleep 10; nmcli device connect "$IFACE" ;;
  15)
    log "offline 15 min: rebooted"
    systemctl reboot ;;
esac
