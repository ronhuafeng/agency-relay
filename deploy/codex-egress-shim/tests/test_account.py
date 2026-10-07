from __future__ import annotations

import http.server
import json
import os
import socket
import subprocess
import threading
import time
import unittest
import urllib.error
import urllib.request

from egress_test_support import SHIM_DIR, protected_headers

RESPONSES = {
    "/backend-api/wham/usage": {"plan_type": "business"},
    "/backend-api/wham/profiles/me": {"stats": {"lifetime_tokens": 123}},
    "/backend-api/wham/rate-limit-reset-credits": {"available_count": 1, "credits": []},
}


class AccountUpstream(http.server.BaseHTTPRequestHandler):
    requests: list[dict[str, str | None]] = []

    def do_GET(self) -> None:
        self.__class__.requests.append({
            "path": self.path,
            "authorization": self.headers.get("Authorization"),
            "account": self.headers.get("Chatgpt-Account-Id"),
            "secret": self.headers.get("X-Codex-Egress-Secret"),
            "manifest": self.headers.get("X-Mini-Header-Manifest"),
        })
        body = json.dumps(RESPONSES[self.path], separators=(",", ":")).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Set-Cookie", "backend-secret=value")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format: str, *_args: object) -> None:
        return


def unused_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def wait_until_healthy(port: int) -> None:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=0.2) as response:
                if response.status == 200:
                    return
        except Exception:
            time.sleep(0.02)
    raise AssertionError("egress shim did not become healthy")


class AccountReadMappingTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        AccountUpstream.requests = []
        cls.upstream = http.server.ThreadingHTTPServer(("127.0.0.1", 0), AccountUpstream)
        cls.upstream_thread = threading.Thread(target=cls.upstream.serve_forever, daemon=True)
        cls.upstream_thread.start()
        cls.secret = "account-fixture-secret"
        cls.shim_port = unused_port()
        cls.shim = subprocess.Popen(
            ["node", str(SHIM_DIR / "server.mjs")],
            env={
                **os.environ,
                "BIND_HOST": "127.0.0.1",
                "PORT": str(cls.shim_port),
                "CODEX_EGRESS_SECRET": cls.secret,
                "CODEX_ALLOW_INSECURE_LOCAL_UPSTREAM": "1",
                "CODEX_UPSTREAM_BASE_URL": (
                    f"http://127.0.0.1:{cls.upstream.server_port}/backend-api/codex"
                ),
            },
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        wait_until_healthy(cls.shim_port)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.shim.terminate()
        cls.shim.wait(timeout=5)
        cls.upstream.shutdown()
        cls.upstream.server_close()
        cls.upstream_thread.join(timeout=5)

    def test_maps_only_the_three_read_routes_to_fixed_wham_paths(self) -> None:
        cases = {
            "/account/usage": "/backend-api/wham/usage",
            "/account/profile": "/backend-api/wham/profiles/me",
            "/account/rate-limit-reset-credits": "/backend-api/wham/rate-limit-reset-credits",
        }
        for local_path, upstream_path in cases.items():
            with self.subTest(path=local_path):
                request = urllib.request.Request(
                    f"http://127.0.0.1:{self.shim_port}{local_path}",
                    headers=protected_headers(self.secret, {
                        "Authorization": "Bearer shared-token",
                        "Chatgpt-Account-Id": "acct-shared",
                        "Accept": "application/json",
                    }),
                    method="GET",
                )
                with urllib.request.urlopen(request, timeout=5) as response:
                    self.assertEqual(response.status, 200)
                    self.assertEqual(response.headers.get("Content-Type"), "application/json")
                    self.assertIsNone(response.headers.get("Set-Cookie"))
                    json.loads(response.read())
                self.assertEqual(AccountUpstream.requests[-1], {
                    "path": upstream_path,
                    "authorization": "Bearer shared-token",
                    "account": "acct-shared",
                    "secret": None,
                    "manifest": None,
                })

    def test_rejects_unknown_mutating_or_query_routes_without_reaching_wham(self) -> None:
        cases = [
            ("GET", "/account/unknown"),
            ("GET", "/account/usage?future=true"),
            ("POST", "/account/usage"),
            ("POST", "/account/rate-limit-reset-credits/consume"),
        ]
        for method, path in cases:
            with self.subTest(method=method, path=path):
                before = len(AccountUpstream.requests)
                request = urllib.request.Request(
                    f"http://127.0.0.1:{self.shim_port}{path}",
                    headers=protected_headers(self.secret, {
                        "Authorization": "Bearer shared-token",
                    }),
                    method=method,
                )
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    urllib.request.urlopen(request, timeout=5)
                self.assertEqual(caught.exception.code, 404)
                caught.exception.close()
                self.assertEqual(len(AccountUpstream.requests), before)


if __name__ == "__main__":
    unittest.main()
