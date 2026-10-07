from __future__ import annotations

import http.client
import http.server
import json
import os
import pathlib
import socket
import subprocess
import tempfile
import threading
import time
import unittest


from egress_test_support import PROTOCOL, SHIM_DIR

MANIFEST_HEADER = PROTOCOL["manifestHeader"]
SECRET_HEADER = PROTOCOL["secretHeader"]


class HeaderCaptureUpstream(http.server.BaseHTTPRequestHandler):
    requests: list[dict[str, str | None]] = []

    def do_GET(self) -> None:
        self.__class__.requests.append({
            "authorization": self.headers.get("Authorization"),
            "end_to_end": self.headers.get("X-End-To-End"),
            "transport_added": self.headers.get("X-Transport-Added"),
            "manifest": self.headers.get(MANIFEST_HEADER),
            "secret": self.headers.get(SECRET_HEADER),
        })
        body = b"ok"
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
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
            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=0.2)
            connection.request("GET", "/healthz")
            response = connection.getresponse()
            ready = response.status == 200
            response.read()
            connection.close()
            if ready:
                return
        except OSError:
            time.sleep(0.02)
    raise AssertionError("egress shim did not become healthy")


class ManifestIsolationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        HeaderCaptureUpstream.requests = []
        cls.upstream = http.server.ThreadingHTTPServer(("127.0.0.1", 0), HeaderCaptureUpstream)
        cls.upstream_thread = threading.Thread(target=cls.upstream.serve_forever, daemon=True)
        cls.upstream_thread.start()
        cls.secret = "manifest-fixture-secret"
        cls.shim_port = unused_port()
        stderr_file = tempfile.NamedTemporaryFile(prefix="egress-manifest-", suffix=".log", delete=False)
        cls.stderr_path = pathlib.Path(stderr_file.name)
        stderr_file.close()
        cls.stderr_writer = cls.stderr_path.open("w")
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
            stderr=cls.stderr_writer,
        )
        wait_until_healthy(cls.shim_port)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.shim.terminate()
        cls.shim.wait(timeout=5)
        cls.stderr_writer.close()
        cls.stderr_path.unlink(missing_ok=True)
        cls.upstream.shutdown()
        cls.upstream.server_close()
        cls.upstream_thread.join(timeout=5)

    def test_selects_exact_manifest_set_and_removes_dynamic_transport_name(self) -> None:
        before = len(HeaderCaptureUpstream.requests)
        log_offset = len(self._logs())
        connection = http.client.HTTPConnection("127.0.0.1", self.shim_port, timeout=5)
        connection.request("GET", "/models", headers={
            "Authorization": "Bearer shared-token",
            "X-End-To-End": "preserve-me",
            "X-Transport-Added": "remove-me",
            SECRET_HEADER: self.secret,
            MANIFEST_HEADER: json.dumps(["authorization", "x-end-to-end"], separators=(",", ":")),
        })
        response = connection.getresponse()
        self.assertEqual(response.status, 200)
        self.assertEqual(response.read(), b"ok")
        connection.close()

        self.assertEqual(len(HeaderCaptureUpstream.requests), before + 1)
        self.assertEqual(HeaderCaptureUpstream.requests[-1], {
            "authorization": "Bearer shared-token",
            "end_to_end": "preserve-me",
            "transport_added": None,
            "manifest": None,
            "secret": None,
        })
        evidence_line = next(line for line in self._logs()[log_offset:] if '"event":"header_isolation"' in line)
        evidence = json.loads(evidence_line)
        self.assertEqual(evidence["selected_names"], evidence["manifest_names"])
        self.assertIn("x-transport-added", evidence["received_names"])
        self.assertIn("x-transport-added", evidence["removed_names"])
        for value in (self.secret, "Bearer shared-token", "preserve-me", "remove-me"):
            self.assertNotIn(value, evidence_line)

    def test_manifest_failures_are_typed_and_never_reach_backend(self) -> None:
        cases = [
            ([], PROTOCOL["errors"]["missingManifest"]),
            ([(MANIFEST_HEADER, "not-json")], PROTOCOL["errors"]["invalidManifest"]),
            ([(MANIFEST_HEADER, json.dumps([]))], PROTOCOL["errors"]["invalidManifest"]),
            ([(MANIFEST_HEADER, json.dumps(["x-end-to-end", "authorization"]))], PROTOCOL["errors"]["invalidManifest"]),
            ([(MANIFEST_HEADER, json.dumps(["authorization", "authorization"]))], PROTOCOL["errors"]["invalidManifest"]),
            ([(MANIFEST_HEADER, json.dumps([SECRET_HEADER]))], PROTOCOL["errors"]["internalManifest"]),
            ([("Connection", "X-Hop"), ("X-Hop", "hop-local-value"), (MANIFEST_HEADER, json.dumps(["authorization", "x-hop"]))], PROTOCOL["errors"]["internalManifest"]),
            ([(MANIFEST_HEADER, json.dumps(["authorization", "x-missing"]))], PROTOCOL["errors"]["unsatisfiedManifest"]),
            ([(MANIFEST_HEADER, json.dumps(["authorization"])), (MANIFEST_HEADER, json.dumps(["authorization"]))], PROTOCOL["errors"]["duplicateManifest"]),
        ]
        for manifest_headers, expected_code in cases:
            with self.subTest(code=expected_code):
                before = len(HeaderCaptureUpstream.requests)
                status, body = self._raw_request(manifest_headers)
                self.assertEqual(status, 400)
                self.assertEqual(json.loads(body)["error"]["code"], expected_code)
                self.assertEqual(len(HeaderCaptureUpstream.requests), before)

    def _raw_request(self, manifest_headers: list[tuple[str, str]]) -> tuple[int, bytes]:
        headers = [
            "GET /models HTTP/1.1",
            "Host: 127.0.0.1",
            f"{SECRET_HEADER}: {self.secret}",
            "Authorization: Bearer shared-token",
            *[f"{name}: {value}" for name, value in manifest_headers],
            "Connection: close",
            "",
            "",
        ]
        with socket.create_connection(("127.0.0.1", self.shim_port), timeout=5) as client:
            client.sendall("\r\n".join(headers).encode())
            response = http.client.HTTPResponse(client)
            response.begin()
            status = response.status
            body = response.read()
            response.close()
            return status, body

    def _logs(self) -> list[str]:
        self.stderr_writer.flush()
        return self.stderr_path.read_text().splitlines()


if __name__ == "__main__":
    unittest.main()
