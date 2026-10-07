from __future__ import annotations

import http.server
import http.client
import os
import socket
import subprocess
import threading
import time
import unittest
import urllib.error
import urllib.request

from egress_test_support import SHIM_DIR, protected_headers

MODELS_BODY = b'{"models":[{"slug":"future-model"}]}'
OPAQUE_ERROR_BODY = bytes((0, 255, 17, 128, 3, 9))


class ModelsUpstream(http.server.BaseHTTPRequestHandler):
    requests: list[dict[str, str | None]] = []

    def do_GET(self) -> None:
        self.__class__.requests.append(
            {
                "path": self.path,
                "authorization": self.headers.get("Authorization"),
                "account": self.headers.get("Chatgpt-Account-Id"),
                "originator": self.headers.get("Originator"),
                "future": self.headers.get("X-Future-Codex-Header"),
                "accept_encoding": self.headers.get("Accept-Encoding"),
                "user_agent": self.headers.get("User-Agent"),
                "cookie": self.headers.get("Cookie"),
                "forwarded": self.headers.get("Forwarded"),
                "egress_secret": self.headers.get("X-Codex-Egress-Secret"),
            }
        )
        is_error = "status=429" in self.path
        status = 429 if is_error else 200
        body = OPAQUE_ERROR_BODY if is_error else MODELS_BODY
        self.send_response(status, "Future Models Error" if is_error else "Future Models OK")
        self.send_header("Content-Type", "application/octet-stream" if is_error else "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Content-Encoding", "zstd" if is_error else "identity")
        self.send_header("ETag", '"opaque-error"' if is_error else '"upstream-models"')
        self.send_header("X-Future-Codex-Response", "preserve-me")
        self.send_header("Set-Cookie", "backend-secret=value")
        self.send_header("Authorization", "Bearer backend-secret")
        self.send_header("Chatgpt-Account-Id", "acct-internal")
        self.send_header("X-Powered-By", "internal-runtime")
        self.send_header("CF-Ray", "internal-ray")
        self.send_header("Via", "backend-proxy")
        self.send_header("Connection", "X-Hop")
        self.send_header("X-Hop", "hop-local")
        self.end_headers()
        self.wfile.write(body[:2])
        self.wfile.flush()
        self.wfile.write(body[2:])

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


class ModelsPassthroughTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        ModelsUpstream.requests = []
        cls.upstream = http.server.ThreadingHTTPServer(("127.0.0.1", 0), ModelsUpstream)
        cls.upstream_thread = threading.Thread(target=cls.upstream.serve_forever, daemon=True)
        cls.upstream_thread.start()
        cls.secret = "models-fixture-secret"
        cls.shim_port = unused_port()
        cls.shim = subprocess.Popen(
            ["node", str(SHIM_DIR / "server.mjs")],
            env={
                **os.environ,
                "BIND_HOST": "127.0.0.1",
                "PORT": str(cls.shim_port),
                "CODEX_EGRESS_SECRET": cls.secret,
                "CODEX_ALLOW_INSECURE_LOCAL_UPSTREAM": "1",
                "CODEX_UPSTREAM_BASE_URL": f"http://127.0.0.1:{cls.upstream.server_port}",
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

    def test_preserves_query_body_and_end_to_end_headers(self) -> None:
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.shim_port}/models?client_version=0.144.0%2Bdev&channel=future",
            headers=protected_headers(self.secret, {
                "Authorization": "Bearer shared-token",
                "Chatgpt-Account-Id": "acct-shared",
                "Originator": "codex-cli",
                "X-Future-Codex-Header": "preserve-me",
                "Accept-Encoding": "gzip, br",
                "User-Agent": "codex-cli-fixture",
            }, {
                "Cookie": "local-cookie=value",
                "Forwarded": "for=127.0.0.1",
            }),
            method="GET",
        )

        with urllib.request.urlopen(request, timeout=5) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.reason, "Future Models OK")
            self.assertEqual(response.read(), MODELS_BODY)
            self.assertEqual(response.headers.get("ETag"), '"upstream-models"')
            self.assertEqual(response.headers.get("X-Future-Codex-Response"), "preserve-me")
            self.assertIsNone(response.headers.get("Set-Cookie"))
            self.assertIsNone(response.headers.get("Authorization"))
            self.assertIsNone(response.headers.get("Chatgpt-Account-Id"))
            self.assertIsNotNone(response.headers.get("Server"))
            self.assertEqual(response.headers.get("X-Powered-By"), "internal-runtime")
            self.assertEqual(response.headers.get("CF-Ray"), "internal-ray")
            self.assertEqual(response.headers.get("Via"), "backend-proxy")
            self.assertNotIn("x-hop", (response.headers.get("Connection") or "").lower())
            self.assertIsNone(response.headers.get("X-Hop"))

        captured = ModelsUpstream.requests[-1].copy()
        self.assertEqual(captured.pop("user_agent"), "codex-cli-fixture")
        self.assertEqual(
            captured,
            {
                "path": "/models?client_version=0.144.0%2Bdev&channel=future",
                "authorization": "Bearer shared-token",
                "account": "acct-shared",
                "originator": "codex-cli",
                "future": "preserve-me",
                "accept_encoding": "gzip, br",
                "cookie": None,
                "forwarded": None,
                "egress_secret": None,
            },
        )

    def test_requires_egress_secret_before_forwarding(self) -> None:
        before = len(ModelsUpstream.requests)
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.shim_port}/models?client_version=0.144.0",
            method="GET",
        )
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(request, timeout=5)
        self.assertEqual(caught.exception.code, 401)
        self.assertIsNone(caught.exception.headers.get("Server"))
        caught.exception.close()
        self.assertEqual(len(ModelsUpstream.requests), before)

    def test_requires_an_allowed_upstream_target_at_startup(self) -> None:
        cases = [
            ({}, "CODEX_UPSTREAM_BASE_URL is required"),
            ({"CODEX_UPSTREAM_BASE_URL": "https://attacker.example/codex"}, "CODEX_UPSTREAM_BASE_URL is not an allowed target"),
            ({"CODEX_UPSTREAM_BASE_URL": "http://127.0.0.1:8789"}, "CODEX_UPSTREAM_BASE_URL is not an allowed target"),
        ]
        for overrides, expected in cases:
            with self.subTest(expected=expected):
                environment = {
                    **os.environ,
                    "BIND_HOST": "127.0.0.1",
                    "PORT": str(unused_port()),
                    "CODEX_EGRESS_SECRET": "startup-fixture-secret",
                }
                environment.pop("CODEX_UPSTREAM_BASE_URL", None)
                environment.pop("CODEX_ALLOW_INSECURE_LOCAL_UPSTREAM", None)
                environment.update(overrides)
                completed = subprocess.run(
                    ["node", str(SHIM_DIR / "server.mjs")],
                    env=environment,
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
                self.assertNotEqual(completed.returncode, 0)
                self.assertIn(expected, completed.stderr)
                self.assertNotIn("startup-fixture-secret", completed.stderr)

    def test_accepts_the_exact_production_upstream_target_at_startup(self) -> None:
        port = unused_port()
        environment = {
            **os.environ,
            "BIND_HOST": "127.0.0.1",
            "PORT": str(port),
            "CODEX_EGRESS_SECRET": "startup-fixture-secret",
            "CODEX_UPSTREAM_BASE_URL": "https://chatgpt.com/backend-api/codex",
        }
        environment.pop("CODEX_ALLOW_INSECURE_LOCAL_UPSTREAM", None)
        process = subprocess.Popen(
            ["node", str(SHIM_DIR / "server.mjs")],
            env=environment,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            wait_until_healthy(port)
        finally:
            process.terminate()
            process.wait(timeout=5)

    def test_preserves_non_2xx_opaque_chunked_body_and_headers(self) -> None:
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.shim_port}/models?client_version=0.144.0&status=429",
            headers=protected_headers(self.secret, {
                "Authorization": "Bearer shared-token",
                "Accept-Encoding": "zstd",
            }),
            method="GET",
        )
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(request, timeout=5)
        error = caught.exception
        self.assertEqual(error.code, 429)
        self.assertEqual(error.reason, "Future Models Error")
        self.assertEqual(error.read(), OPAQUE_ERROR_BODY)
        self.assertEqual(error.headers.get("Content-Type"), "application/octet-stream")
        self.assertEqual(error.headers.get("Content-Encoding"), "zstd")
        self.assertEqual(error.headers.get("ETag"), '"opaque-error"')
        self.assertEqual(error.headers.get("X-Future-Codex-Response"), "preserve-me")
        self.assertIsNone(error.headers.get("Set-Cookie"))
        error.close()
        self.assertEqual(ModelsUpstream.requests[-1]["accept_encoding"], "zstd")

    def test_does_not_synthesize_user_agent(self) -> None:
        connection = http.client.HTTPConnection("127.0.0.1", self.shim_port, timeout=5)
        connection.request(
            "GET",
            "/models?client_version=0.144.0",
            headers=protected_headers(self.secret, {"Authorization": "Bearer shared-token"}),
        )
        response = connection.getresponse()
        self.assertEqual(response.status, 200)
        self.assertEqual(response.read(), MODELS_BODY)
        connection.close()
        self.assertIsNone(ModelsUpstream.requests[-1]["user_agent"])


if __name__ == "__main__":
    unittest.main()
