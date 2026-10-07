from __future__ import annotations

import http.client
import http.server
import json
import os
import pathlib
import socket
import struct
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request

from egress_test_support import PROTOCOL, SHIM_DIR, TRACE_HEADER, protected_headers


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


class QuietThreadingHttpServer(http.server.ThreadingHTTPServer):
    def handle_error(self, _request: object, _client_address: object) -> None:
        return


class ResetAfterHeadersUpstream(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_POST(self) -> None:
        body_size = int(self.headers.get("Content-Length", "0"))
        self.rfile.read(body_size)
        partial = b"event: response.created\ndata: {}\n\n"
        response_head = (
            "HTTP/1.1 200 OK\r\n"
            "Content-Type: text/event-stream\r\n"
            "Content-Length: 1048576\r\n"
            "Connection: close\r\n\r\n"
        ).encode()
        self.connection.sendall(response_head + partial)
        self.connection.setsockopt(
            socket.SOL_SOCKET,
            socket.SO_LINGER,
            struct.pack("ii", 1, 0),
        )
        self.close_connection = True
        self.connection.close()

    def log_message(self, _format: str, *_args: object) -> None:
        return


class EgressTransportFailureTest(unittest.TestCase):
    def test_classifies_connection_failure_before_upstream_headers(self) -> None:
        upstream_port = unused_port()
        trace_id = "33333333-3333-4333-8333-333333333333"
        shim, shim_port, stderr_path, stderr_writer = self._start_shim(upstream_port)
        try:
            with self.assertRaises(urllib.error.HTTPError) as caught:
                urllib.request.urlopen(self._request(shim_port, trace_id), timeout=5)
            self.assertEqual(caught.exception.code, 502)
            self.assertEqual(caught.exception.read(), b"")
            caught.exception.close()
            outcome = self._wait_for_outcome(stderr_path, stderr_writer, trace_id)
        finally:
            self._stop_shim(shim, stderr_path, stderr_writer)

        self._assert_safe_outcome(outcome)
        self.assertEqual(outcome["transport_outcome"], "upstream_request_failed")
        self.assertEqual(outcome["transport_stage"], "upstream_connect")
        self.assertIsNone(outcome["status"])
        self.assertIsNone(outcome["upstream_headers_ms"])
        self.assertEqual(outcome["upstream_read_bytes"], 0)
        self.assertEqual(outcome["downstream_submit_bytes"], 0)

    def test_classifies_upstream_reset_after_headers_without_rewriting_bytes(self) -> None:
        upstream = QuietThreadingHttpServer(("127.0.0.1", 0), ResetAfterHeadersUpstream)
        upstream_thread = threading.Thread(target=upstream.serve_forever, daemon=True)
        upstream_thread.start()
        trace_id = "44444444-4444-4444-8444-444444444444"
        shim, shim_port, stderr_path, stderr_writer = self._start_shim(upstream.server_port)
        received = b""
        try:
            try:
                with urllib.request.urlopen(self._request(shim_port, trace_id), timeout=5) as response:
                    self.assertEqual(response.status, 200)
                    self.assertEqual(response.headers.get_content_type(), "text/event-stream")
                    received = response.read()
            except (http.client.IncompleteRead, ConnectionError) as error:
                received = getattr(error, "partial", b"")
            outcome = self._wait_for_outcome(stderr_path, stderr_writer, trace_id)
        finally:
            self._stop_shim(shim, stderr_path, stderr_writer)
            upstream.shutdown()
            upstream.server_close()
            upstream_thread.join(timeout=5)

        self._assert_safe_outcome(outcome)
        self.assertEqual(outcome["transport_outcome"], "upstream_read_failed")
        self.assertEqual(outcome["transport_stage"], "response_read")
        self.assertEqual(outcome["status"], 200)
        self.assertEqual(outcome["upstream_read_bytes"], len(received))
        self.assertEqual(outcome["downstream_submit_bytes"], len(received))
        self.assertEqual(outcome["upstream_read_chunks"], outcome["downstream_submit_chunks"])

    def _start_shim(
        self,
        upstream_port: int,
    ) -> tuple[subprocess.Popen[str], int, pathlib.Path, object]:
        shim_port = unused_port()
        stderr_file = tempfile.NamedTemporaryFile(prefix="egress-failure-", suffix=".log", delete=False)
        stderr_path = pathlib.Path(stderr_file.name)
        stderr_file.close()
        stderr_writer = stderr_path.open("w")
        shim = subprocess.Popen(
            ["node", str(SHIM_DIR / "server.mjs")],
            env={
                **os.environ,
                "BIND_HOST": "127.0.0.1",
                "PORT": str(shim_port),
                "CODEX_EGRESS_SECRET": "transport-failure-secret",
                "CODEX_ALLOW_INSECURE_LOCAL_UPSTREAM": "1",
                "CODEX_UPSTREAM_BASE_URL": f"http://127.0.0.1:{upstream_port}",
            },
            stdout=subprocess.DEVNULL,
            stderr=stderr_writer,
            text=True,
        )
        wait_until_healthy(shim_port)
        return shim, shim_port, stderr_path, stderr_writer

    def _stop_shim(
        self,
        shim: subprocess.Popen[str],
        stderr_path: pathlib.Path,
        stderr_writer: object,
    ) -> None:
        shim.terminate()
        shim.wait(timeout=5)
        stderr_writer.close()  # type: ignore[attr-defined]
        stderr_path.unlink(missing_ok=True)

    def _request(self, shim_port: int, trace_id: str) -> urllib.request.Request:
        return urllib.request.Request(
            f"http://127.0.0.1:{shim_port}/responses",
            data=b'{"model":"fixture"}',
            headers=protected_headers(
                "transport-failure-secret",
                {
                    "Authorization": "Bearer shared-token",
                    "Content-Type": "application/json",
                },
                {TRACE_HEADER: trace_id},
            ),
            method="POST",
        )

    def _wait_for_outcome(
        self,
        stderr_path: pathlib.Path,
        stderr_writer: object,
        trace_id: str,
    ) -> dict[str, object]:
        deadline = time.monotonic() + 5
        matches: list[dict[str, object]] = []
        while time.monotonic() < deadline:
            stderr_writer.flush()  # type: ignore[attr-defined]
            matches = [
                event
                for line in stderr_path.read_text().splitlines()
                if line.startswith("{")
                for event in [json.loads(line)]
                if event.get("event") == "egress_transport_outcome"
                and event.get("transport_trace_id") == trace_id
            ]
            if matches:
                break
            time.sleep(0.02)
        self.assertEqual(len(matches), 1, stderr_path.read_text())
        return matches[0]

    def _assert_safe_outcome(self, outcome: dict[str, object]) -> None:
        self.assertEqual(
            set(outcome),
            set(PROTOCOL["transportTrace"]["eventFields"]["egressOutcome"]),
        )
        self.assertNotIn("error", outcome)
        self.assertNotIn("stack", outcome)
        self.assertNotIn("body", outcome)


if __name__ == "__main__":
    unittest.main()
