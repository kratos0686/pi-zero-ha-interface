# Raspberry Pi Zero 2W — Home Assistant interface

A lightweight touch dashboard that turns a Raspberry Pi Zero 2W (plus any HDMI
or DSI touchscreen) into a wall panel for an existing Home Assistant server.

The Zero 2W's 512 MB of RAM is too little to run Home Assistant itself
comfortably. This project keeps Home Assistant on your main server and runs
only a thin client on the Pi:

```
┌──────────── Pi Zero 2W ─────────────┐          ┌──── Home Assistant ────┐
│ cage + Chromium (kiosk, tty1)       │ WebSocket│                        │
│   └─ dashboard (static HTML/JS) ────┼─────────►│  /api/websocket        │
│ server.py (127.0.0.1:8080)          │          │                        │
│   └─ serves page + config.json      │          └────────────────────────┘
└─────────────────────────────────────┘
```

- **No dependencies**: the server uses only the Python 3 standard library, and the page is plain JS with no framework or build step.
- **Live updates** over the Home Assistant WebSocket API, with automatic reconnect.
- **Tiles** for lights (tap to toggle, with a brightness slider), switches, fans,
  input booleans, automations, media players (play/pause), scenes, scripts,
  buttons, climate (± target temperature), sensors and binary sensors.
- **Locks and covers need two taps**, so an accidental tap can't unlock the door or open the garage.
- Light/dark theme and a clock in the header.

## Setup

1. Flash **Raspberry Pi OS Lite (64-bit, Bookworm or later)** with Raspberry Pi
   Imager. Set Wi-Fi, a user and SSH in the imager's settings.
2. In Home Assistant, open your profile → **Security** → **Long-lived access
   tokens** → *Create token*. Consider creating a dedicated non-admin HA user
   for the panel first and generating the token as that user.
3. On the Pi:

   ```sh
   sudo apt-get install -y git
   git clone https://github.com/kratos0686/hello-github-actions.git
   cd hello-github-actions/pi-ha-interface
   sudo ./install.sh            # or: sudo ./install.sh --no-kiosk
   sudo nano /opt/ha-dashboard/config.json
   sudo reboot
   ```

With the default install, the dashboard starts full-screen on the attached
display after boot. `--no-kiosk` installs only the dashboard server (and turns
off the kiosk if an earlier install set it up). Re-running the installer applies
updated files and restarts both services.

## Configuration

`/opt/ha-dashboard/config.json` (see [`config.example.json`](config.example.json)):

| key      | description                                                                 |
|----------|-----------------------------------------------------------------------------|
| `ha_url` | Base URL of Home Assistant, e.g. `https://homeassistant.local:8123` (see below) |
| `token`  | Long-lived access token                                                      |
| `title`  | Header text                                                                  |
| `theme`  | `auto`, `light` or `dark`                                                    |
| `tiles`  | List of `{ "entity": "light.kitchen", "name": "...", "icon": "💡" }` or plain entity id strings |

The config is re-read on every page load, so after editing it just reload the
page. On the kiosk you can do that with `sudo systemctl restart ha-kiosk`.

## Tips for the Zero 2W

- **Screen rotation / touch**: configure your display per its vendor docs
  (usually a `dtoverlay=` line in `/boot/firmware/config.txt`).
- **Memory**: Chromium is the heaviest part. The kiosk flags already limit it to
  one renderer and a minimal cache. If you still run short, enable zram:
  `sudo apt-get install -y zram-tools`.
- **Use HTTPS for Home Assistant**: the access token is sent over the
  WebSocket connection. With an `https://` `ha_url` the page connects with
  `wss://` (encrypted). A plain `http://` URL also works, but then the token
  crosses your network unencrypted, so only do that on a network you trust.
  Enable TLS in Home Assistant (for example with its Let's Encrypt or NGINX
  add-ons) to use `https://`.
- **Using a tablet or phone instead of a screen on the Pi**: edit
  `/etc/systemd/system/ha-dashboard.service`, change `--host 127.0.0.1` to
  `--host 0.0.0.0`, then run `sudo systemctl daemon-reload && sudo systemctl
  restart ha-dashboard` and open `http://<pi-address>:8080/`. Be aware that this
  exposes the access token to anyone on your network who can reach the port.

## Troubleshooting

```sh
journalctl -u ha-dashboard -f   # web server
journalctl -u ha-kiosk -f       # browser / compositor
curl http://127.0.0.1:8080/config.json
```

- **Red dot in the header**: the page can't reach Home Assistant. Check `ha_url` from the Pi.
- **"rejected the access token"**: the token is wrong or was revoked.
- **"Not found in HA: …"**: the entity id in `tiles` doesn't exist.

## Development

```sh
python3 server.py --config config.example.json   # http://127.0.0.1:8080/
python3 -m unittest discover -s tests -v
```
