#!/usr/bin/env python3
"""Build a cloud-init `user-data` that turns a freshly flashed Raspberry Pi OS
Lite (Trixie, 64-bit) SD card into this dashboard on first boot.

    python3 make_user_data.py --config my-config.json --passwd-hash '$y$...' \
        [--user kratos0686] [--ssh-key ~/.ssh/id_ed25519.pub] > dist/user-data

Flash with Raspberry Pi Imager (set Wi-Fi there), then replace `user-data` on
the boot partition with the generated file. The output embeds the access
token from the config: keep it private.
"""
import argparse, base64, gzip, json, os, sys
import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = "/opt/pi-ha-src"
FILES = ["server.py", "kiosk.sh", "watchdog.sh", "install.sh", "config.example.json",
         "static/app.js", "static/index.html", "static/style.css", "static/bg.jpg",
         "systemd/ha-dashboard.service", "systemd/ha-kiosk.service",
         "systemd/ha-watchdog.service", "systemd/ha-watchdog.timer",
         "net-watchdog.sh", "systemd/ha-net-watchdog.service", "systemd/ha-net-watchdog.timer"]

# Tuning learned the hard way on a 512 MB Zero 2 W.
TEXT_FILES = {
    # Bigger zram (lz4 is fast on the Zero's CPU) with SD writeback for idle pages.
    "/etc/rpi/swap.conf.d/50-bigger.conf":
        "[Main]\nMechanism=zram+file\n\n[File]\nFixedSizeMiB=1024\n\n[Zram]\nRamMultiplier=2\n"
        "WritebackInitialDelay=60min\nWritebackPeriodicInterval=12h\n",
    "/etc/systemd/zram-generator.conf.d/90-lz4.conf": "[zram0]\ncompression-algorithm = lz4\n",
    # 100, not higher: more aggressive settings swapped the dashboard tab out.
    "/etc/sysctl.d/90-zram.conf": "vm.swappiness=100\nvm.watermark_boost_factor=0\n",
    # Wi-Fi power saving made the Pi drop off the network.
    "/etc/NetworkManager/conf.d/99-no-wifi-powersave.conf": "[connection]\nwifi.powersave = 2\n",
}


def packed(data):
    return base64.b64encode(gzip.compress(data, 9)).decode()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", required=True, help="dashboard config.json (ha_url, token, tiles...)")
    ap.add_argument("--passwd-hash", required=True, help="login password hash (mkpasswd / Imager's user-data)")
    ap.add_argument("--user", default="kratos0686")
    ap.add_argument("--hostname", default="pi2w")
    ap.add_argument("--timezone", default="America/Los_Angeles")
    ap.add_argument("--ssh-key", action="append", default=[], help="public key file to authorize (repeatable)")
    a = ap.parse_args()

    with open(a.config) as f:
        config = json.load(f)  # validate it's JSON
    write_files = []
    for rel in FILES:
        with open(os.path.join(HERE, rel), "rb") as f:
            write_files.append({"path": f"{SRC}/{rel}", "encoding": "gz+b64", "content": packed(f.read()),
                                "permissions": "0755" if rel.endswith(".sh") or rel == "server.py" else "0644"})
    for path, text in TEXT_FILES.items():
        write_files.append({"path": path, "content": text, "permissions": "0644"})
    # Written after the user exists, readable only by the service user (holds the token).
    write_files.append({"path": "/opt/ha-dashboard/config.json", "content": json.dumps(config, indent=2) + "\n",
                        "owner": f"{a.user}:{a.user}", "permissions": "0600", "defer": True})

    keys = [open(os.path.expanduser(k)).read().strip() for k in a.ssh_key]
    doc = {
        "manage_resolv_conf": False,
        "hostname": a.hostname,
        "manage_etc_hosts": True,
        "timezone": a.timezone,
        "keyboard": {"model": "pc105", "layout": "us"},
        "apt": {"preserve_sources_list": True, "conf": 'Acquire {\n  Check-Date "false";\n};\n'},
        "package_update": True,
        "packages": ["avahi-daemon", "cage", "chromium", "fonts-noto-color-emoji", "grim"],
        "user": {"name": a.user, "shell": "/bin/bash", "lock_passwd": False, "passwd": a.passwd_hash,
                 **({"ssh_authorized_keys": keys} if keys else {})},
        "ssh_pwauth": True,
        "write_files": write_files,
        "runcmd": [
            ["systemctl", "enable", "--now", "ssh"],
            # Background apt/man-db jobs starved the dashboard of memory: update by hand instead.
            ["systemctl", "disable", "--now", "apt-daily.timer", "apt-daily-upgrade.timer", "man-db.timer"],
            ["sh", "-c", f"cd {SRC} && HA_DASH_USER={a.user} sh ./install.sh"],
        ],
        "power_state": {"mode": "reboot", "message": "Dashboard installed, rebooting into the kiosk",
                        "condition": True},
    }
    sys.stdout.write("#cloud-config\n" + yaml.safe_dump(doc, sort_keys=False, width=10**9))


if __name__ == "__main__":
    main()
