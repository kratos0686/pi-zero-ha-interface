#!/usr/bin/env python3
"""Tiny, dependency-free web server for the Pi Zero 2W Home Assistant dashboard.

Serves the static dashboard and ``/config.json`` containing the Home Assistant
URL, access token and tile layout from the config file.

Because the token is handed to the browser, the server binds to 127.0.0.1 by
default so only the kiosk browser running on the Pi itself can read it. The
config is served as JSON (not script) and only to same-origin requests, so other
web pages open in that browser cannot load it cross-origin.
"""

import argparse
import json
import os
import socket
import sys
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
DEFAULT_CONFIG = BASE_DIR / "config.json"

REQUIRED_KEYS = ("ha_url", "token")
LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1")
VERBOSE = bool(os.environ.get("HA_DASH_VERBOSE"))


class ConfigError(Exception):
    pass


def load_config(path):
    """Load and validate the dashboard config, returning the client-side dict."""
    try:
        with open(path, encoding="utf-8") as f:
            raw = json.load(f)
    except FileNotFoundError:
        raise ConfigError(f"config file not found: {path} (copy config.example.json)")
    except json.JSONDecodeError as e:
        raise ConfigError(f"invalid JSON in {path}: {e}")
    except (OSError, UnicodeDecodeError) as e:
        raise ConfigError(f"unable to read config {path}: {e}")

    if not isinstance(raw, dict):
        raise ConfigError(f"{path} must contain a JSON object")

    missing = [k for k in REQUIRED_KEYS if not raw.get(k)]
    if missing:
        raise ConfigError(f"missing required config keys: {', '.join(missing)}")
    for key in REQUIRED_KEYS:
        if not isinstance(raw[key], str):
            raise ConfigError(f"{key} must be a string")

    ha_url = raw["ha_url"].strip().rstrip("/")
    try:
        parts = urlsplit(ha_url)  # raises ValueError for e.g. "http://["
        parts.port  # raises ValueError for a malformed port
    except ValueError:
        parts = None
    if not parts or parts.scheme not in ("http", "https") or not parts.hostname:
        raise ConfigError("ha_url must be an http:// or https:// URL with a host, "
                          "e.g. https://homeassistant.local:8123")
    if parts.query or parts.fragment:
        raise ConfigError("ha_url must not contain a query string or #fragment")
    # Browsers refuse WebSocket URLs with credentials, so the page could
    # never connect; the access token is what authenticates anyway.
    if "@" in parts.netloc:
        raise ConfigError("ha_url must not contain a username or password")
    # urlsplit lowercases the scheme; do the same so the page's
    # http(s) -> ws(s) rewrite works for e.g. "HTTPS://".
    ha_url = parts.scheme + ha_url[len(parts.scheme):]

    tiles = raw.get("tiles", [])
    if not isinstance(tiles, list):
        raise ConfigError("tiles must be a list")
    seen = set()
    for i, tile in enumerate(tiles):
        if isinstance(tile, str):
            tiles[i] = tile = {"entity": tile}
        entity = tile.get("entity") if isinstance(tile, dict) else None
        if not isinstance(entity, str) or "." not in entity:
            raise ConfigError(f"tiles[{i}] needs an 'entity' like 'light.kitchen'")
        if entity in seen:
            raise ConfigError(f"tiles[{i}]: {entity} is listed more than once")
        seen.add(entity)

    return {
        "haUrl": ha_url,
        "token": raw["token"],
        "title": raw.get("title", "Home"),
        "tiles": tiles,
        "theme": raw.get("theme", "auto"),
    }


def _host_name(host_header):
    """Hostname part of a Host header ("[::1]:8080" -> "::1")."""
    host = (host_header or "").strip().lower()
    if host.startswith("["):
        return host[1:].split("]", 1)[0]
    return host.rsplit(":", 1)[0] if host.count(":") == 1 else host


def make_handler(config_path, loopback_only=True):
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

        def do_GET(self):
            if self.path.split("?", 1)[0] == "/config.json":
                return self._send_config()
            return super().do_GET()

        def _config_request_allowed(self):
            # Browsers label cross-origin subresource requests; refuse them so a
            # page from another site can't pull the token.
            if self.headers.get("Sec-Fetch-Site", "same-origin") not in ("same-origin", "none"):
                return False
            # A DNS-rebinding page would reach us under its own hostname.
            if loopback_only and _host_name(self.headers.get("Host")) not in LOOPBACK_HOSTS:
                return False
            return True

        def _send_config(self):
            if not self._config_request_allowed():
                return self.send_error(HTTPStatus.FORBIDDEN)
            # Re-read on every request so config edits apply on page reload.
            try:
                body = load_config(config_path)
            except ConfigError as e:
                body = {"error": str(e)}  # 200 so the page can render the error
            data = json.dumps(body).encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def end_headers(self):
            self.send_header("X-Content-Type-Options", "nosniff")
            super().end_headers()

        def log_request(self, code="-", size="-"):
            # Errors always reach the journal; successful requests only when verbose.
            if VERBOSE or (isinstance(code, int) and code >= 400):
                super().log_request(code, size)

    return Handler


def _env_port(default=8080):
    """HA_DASH_PORT if it is a valid port number, else the default."""
    value = os.environ.get("HA_DASH_PORT", "").strip()
    if not value:
        return default
    if value.isdigit() and 0 < int(value) < 65536:
        return int(value)
    print(f"warning: ignoring invalid HA_DASH_PORT={value!r}, using {default}", file=sys.stderr)
    return default


def make_server(host, port, handler):
    """Create the HTTP server, using an IPv6 socket for IPv6 hosts such as ::1."""
    class Server(ThreadingHTTPServer):
        address_family = socket.AF_INET6 if ":" in host else socket.AF_INET

    return Server((host, port), handler)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--host", default=os.environ.get("HA_DASH_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=_env_port())
    parser.add_argument("--config", default=os.environ.get("HA_DASH_CONFIG", str(DEFAULT_CONFIG)))
    args = parser.parse_args(argv)

    try:
        load_config(args.config)
    except ConfigError as e:
        print(f"warning: {e}", file=sys.stderr)

    loopback_only = args.host in LOOPBACK_HOSTS
    if not loopback_only:
        print(
            "warning: listening on a non-loopback address exposes your Home Assistant "
            "token to anyone who can reach this port",
            file=sys.stderr,
        )

    server = make_server(args.host, args.port, make_handler(args.config, loopback_only))
    shown = f"[{args.host}]" if ":" in args.host else args.host
    print(f"HA dashboard on http://{shown}:{args.port}/", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
