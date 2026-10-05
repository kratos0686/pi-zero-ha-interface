#!/bin/sh
# Install the Home Assistant dashboard on a Raspberry Pi Zero 2W
# running Raspberry Pi OS Lite (Bookworm or later).
#
#   sudo ./install.sh            # dashboard server + full-screen kiosk
#   sudo ./install.sh --no-kiosk # dashboard server only
set -eu

if [ "$#" -gt 1 ] || { [ "$#" -eq 1 ] && [ "$1" != "--no-kiosk" ]; }; then
  echo "usage: $0 [--no-kiosk]" >&2
  exit 2
fi
KIOSK=1
[ "${1:-}" = "--no-kiosk" ] && KIOSK=0

if [ "$(id -u)" -ne 0 ]; then
  echo "run with sudo" >&2
  exit 1
fi

# The service runs as the (non-root) user who invoked sudo, or HA_DASH_USER.
RUN_USER="${HA_DASH_USER:-${SUDO_USER:-}}"
if [ -z "$RUN_USER" ] || [ "$RUN_USER" = "root" ]; then
  echo "run as your normal user via sudo, or set HA_DASH_USER=<user>" >&2
  exit 1
fi
if ! id "$RUN_USER" >/dev/null 2>&1; then
  echo "user '$RUN_USER' does not exist" >&2
  exit 1
fi
SRC_DIR="$(cd "$(dirname "$0")" && pwd -P)"
INSTALL_DIR="/opt/ha-dashboard"
# Installing onto itself would delete static/ before copying it.
if [ -d "$INSTALL_DIR" ] && [ "$SRC_DIR" = "$(cd "$INSTALL_DIR" && pwd -P)" ]; then
  echo "run install.sh from the source checkout, not from $INSTALL_DIR" >&2
  exit 1
fi
GROUPS_FILE="$INSTALL_DIR/.kiosk-groups"

echo "==> Installing to $INSTALL_DIR (service user: $RUN_USER)"
mkdir -p "$INSTALL_DIR"
# Replace static/ wholesale so files removed upstream aren't served anymore.
rm -rf "$INSTALL_DIR/static"
cp -r "$SRC_DIR/server.py" "$SRC_DIR/kiosk.sh" "$SRC_DIR/static" "$INSTALL_DIR/"
chmod +x "$INSTALL_DIR/server.py" "$INSTALL_DIR/kiosk.sh"

if [ ! -f "$INSTALL_DIR/config.json" ]; then
  cp "$SRC_DIR/config.example.json" "$INSTALL_DIR/config.json"
  echo "==> Created $INSTALL_DIR/config.json - edit it with your HA URL, token and tiles"
fi
# The config holds an access token: readable by the service user only.
chown "$RUN_USER" "$INSTALL_DIR/config.json"
chmod 600 "$INSTALL_DIR/config.json"

install_unit() {
  sed -e "s|@USER@|$RUN_USER|g" -e "s|@INSTALL_DIR@|$INSTALL_DIR|g" \
    "$SRC_DIR/systemd/$1" > "/etc/systemd/system/$1"
}

install_unit ha-dashboard.service
systemctl daemon-reload
systemctl enable ha-dashboard.service
# Restart (not just start) so a re-run picks up the newly copied files.
systemctl restart ha-dashboard.service

if [ "$KIOSK" -eq 1 ]; then
  # Only touch apt when something is missing, so a re-run works offline.
  if ! command -v cage >/dev/null 2>&1 || \
     ! { command -v chromium || command -v chromium-browser; } >/dev/null 2>&1; then
    echo "==> Installing kiosk packages (cage, chromium)"
    apt-get update
    apt-get install -y --no-install-recommends cage
    apt-get install -y --no-install-recommends chromium || \
      apt-get install -y --no-install-recommends chromium-browser
  fi
  # Give the user access to the display, input and GPU devices. Record the
  # groups the user wasn't already in, so --no-kiosk removes only those.
  # Skip groups this system doesn't have (e.g. no "render" without mesa).
  for g in video render input tty; do
    if ! getent group "$g" >/dev/null; then
      echo "==> Group '$g' does not exist here, skipping"
      continue
    fi
    if ! id -nG "$RUN_USER" | tr ' ' '\n' | grep -qx "$g"; then
      echo "$RUN_USER $g" >> "$GROUPS_FILE"
      usermod -aG "$g" "$RUN_USER"
    fi
  done

  install_unit ha-kiosk.service
  systemctl daemon-reload
  # Enable the kiosk before taking tty1 away, so a failure here can't leave
  # the Pi booting to a blank console.
  systemctl enable ha-kiosk.service
  systemctl set-default graphical.target
  systemctl disable getty@tty1.service || true
  if systemctl is-active --quiet ha-kiosk.service; then
    # Already running from an earlier install: reload the new files now.
    systemctl restart ha-kiosk.service
    echo "==> Kiosk restarted"
  else
    echo "==> Kiosk enabled on tty1 - reboot to start it"
  fi
elif [ -f /etc/systemd/system/ha-kiosk.service ]; then
  # Switching an existing kiosk install to server-only: undo the kiosk setup.
  echo "==> Disabling the kiosk from an earlier install"
  systemctl disable --now ha-kiosk.service || true
  rm -f /etc/systemd/system/ha-kiosk.service
  systemctl daemon-reload
  systemctl enable getty@tty1.service || true
  systemctl start getty@tty1.service || true
  systemctl set-default multi-user.target
  if [ -f "$GROUPS_FILE" ]; then
    while read -r user group; do
      gpasswd -d "$user" "$group" >/dev/null 2>&1 || true
    done < "$GROUPS_FILE"
    rm -f "$GROUPS_FILE"
  fi
fi

echo "==> Done. Dashboard: http://127.0.0.1:8080/ (logs: journalctl -u ha-dashboard -f)"
