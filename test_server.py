import json
import socket
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import server  # noqa: E402


_tmpdir = None


def setUpModule():
    global _tmpdir
    _tmpdir = tempfile.TemporaryDirectory()


def tearDownModule():
    _tmpdir.cleanup()


def write_config(data):
    f = tempfile.NamedTemporaryFile("w", suffix=".json", dir=_tmpdir.name, delete=False)
    json.dump(data, f)
    f.close()
    return f.name


class LoadConfigTests(unittest.TestCase):
    def test_valid_config(self):
        path = write_config({
            "ha_url": "http://ha.local:8123/",
            "token": "abc",
            "tiles": ["light.kitchen", {"entity": "sensor.temp", "name": "Temp"}],
        })
        cfg = server.load_config(path)
        self.assertEqual(cfg["haUrl"], "http://ha.local:8123")
        self.assertEqual(cfg["title"], "Home")
        self.assertEqual(cfg["tiles"][0], {"entity": "light.kitchen"})
        self.assertEqual(cfg["tiles"][1]["name"], "Temp")

    def test_missing_token(self):
        path = write_config({"ha_url": "http://ha.local:8123"})
        with self.assertRaisesRegex(server.ConfigError, "token"):
            server.load_config(path)

    def test_bad_url_scheme(self):
        path = write_config({"ha_url": "ha.local:8123", "token": "x"})
        with self.assertRaisesRegex(server.ConfigError, "http"):
            server.load_config(path)

    def test_malformed_urls(self):
        for url in ("http://", "https://?x", "https://:8123", "http://h:notaport", "http://[",
                    "ws://h:8123", "http://h:8123/?a=1", "http://h:8123/#x",
                    "http://user:pass@h:8123", "http://user@h", "http://@h"):
            with self.subTest(url=url):
                with self.assertRaisesRegex(server.ConfigError, "ha_url"):
                    server.load_config(write_config({"ha_url": url, "token": "x"}))
        cfg = server.load_config(write_config({"ha_url": " https://[::1]:8123/ ", "token": "x"}))
        self.assertEqual(cfg["haUrl"], "https://[::1]:8123")
        cfg = server.load_config(write_config({"ha_url": "HTTPS://ha.local:8123", "token": "x"}))
        self.assertEqual(cfg["haUrl"], "https://ha.local:8123")

    def test_duplicate_entities(self):
        path = write_config({"ha_url": "http://h", "token": "x",
                             "tiles": ["light.a", {"entity": "light.a", "name": "Again"}]})
        with self.assertRaisesRegex(server.ConfigError, r"tiles\[1\].*light\.a"):
            server.load_config(path)

    def test_bad_tile(self):
        path = write_config({"ha_url": "http://h", "token": "x", "tiles": [{"name": "no entity"}]})
        with self.assertRaisesRegex(server.ConfigError, r"tiles\[0\]"):
            server.load_config(path)

    def test_wrong_types(self):
        cases = [
            (["not", "an", "object"], "JSON object"),
            ({"ha_url": 8123, "token": "x"}, "ha_url must be a string"),
            ({"ha_url": "http://h", "token": ["x"]}, "token must be a string"),
            ({"ha_url": "http://h", "token": "x", "tiles": [{"entity": 42}]}, r"tiles\[0\]"),
            ({"ha_url": "http://h", "token": "x", "tiles": [7]}, r"tiles\[0\]"),
        ]
        for data, message in cases:
            with self.subTest(data=data):
                with self.assertRaisesRegex(server.ConfigError, message):
                    server.load_config(write_config(data))

    def test_missing_file(self):
        with self.assertRaisesRegex(server.ConfigError, "not found"):
            server.load_config("/nonexistent/config.json")

    def test_unreadable_file(self):
        with self.assertRaisesRegex(server.ConfigError, "unable to read"):
            server.load_config(_tmpdir.name)  # a directory: IsADirectoryError
        path = write_config({})
        with open(path, "wb") as f:
            f.write(b'{"ha_url": "\xff"}')
        with self.assertRaisesRegex(server.ConfigError, "unable to read"):
            server.load_config(path)

    def test_example_config_is_valid(self):
        cfg = server.load_config(Path(server.BASE_DIR) / "config.example.json")
        self.assertTrue(cfg["tiles"])


class HandlerTests(unittest.TestCase):
    def serve(self, config_path):
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.make_handler(config_path))
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)
        return f"http://127.0.0.1:{httpd.server_address[1]}"

    def get(self, url, **headers):
        return urllib.request.urlopen(urllib.request.Request(url, headers=headers))

    def test_config_json_and_static(self):
        base = self.serve(write_config({"ha_url": "http://h:8123", "token": "tok"}))
        with self.get(base + "/config.json", **{"Sec-Fetch-Site": "same-origin"}) as r:
            body = json.load(r)
            self.assertEqual(r.headers["Cache-Control"], "no-store")
            self.assertTrue(r.headers["Content-Type"].startswith("application/json"))
        self.assertEqual(body["token"], "tok")
        with urllib.request.urlopen(base + "/") as r:
            self.assertIn(b"app.js", r.read())

    def test_config_error_is_reported_to_page(self):
        base = self.serve("/nonexistent/config.json")
        with self.get(base + "/config.json") as r:
            self.assertIn("not found", json.load(r)["error"])

    def test_config_refused_to_other_sites(self):
        base = self.serve(write_config({"ha_url": "http://h:8123", "token": "tok"}))
        for headers in ({"Sec-Fetch-Site": "cross-site"},     # <script src> from another site
                        {"Sec-Fetch-Site": "same-site"},
                        {"Host": "attacker.example:8080"}):  # DNS rebinding
            with self.subTest(headers=headers):
                with self.assertRaises(urllib.error.HTTPError) as ctx:
                    self.get(base + "/config.json", **headers)
                self.assertEqual(ctx.exception.code, 403)

    def test_ipv6_loopback(self):
        try:
            with socket.socket(socket.AF_INET6) as probe:
                probe.bind(("::1", 0))
        except OSError:
            self.skipTest("IPv6 not available")
        httpd = server.make_server("::1", 0, server.make_handler(write_config({"ha_url": "http://h", "token": "t"})))
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)
        port = httpd.server_address[1]
        with self.get(f"http://[::1]:{port}/config.json", **{"Sec-Fetch-Site": "same-origin"}) as r:
            self.assertEqual(json.load(r)["token"], "t")

    def test_env_port(self):
        from unittest import mock
        for value, expected in (("9090", 9090), ("", 8080), ("abc", 8080), ("70000", 8080), (" 81 ", 81)):
            with self.subTest(value=value), mock.patch.dict(server.os.environ, {"HA_DASH_PORT": value}):
                self.assertEqual(server._env_port(), expected)

    def test_host_name(self):
        self.assertEqual(server._host_name("127.0.0.1:8080"), "127.0.0.1")
        self.assertEqual(server._host_name("[::1]:8080"), "::1")
        self.assertEqual(server._host_name("LocalHost"), "localhost")


if __name__ == "__main__":
    unittest.main()
