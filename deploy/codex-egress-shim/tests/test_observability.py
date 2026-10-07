from __future__ import annotations

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
import urllib.request

from egress_test_support import PROTOCOL, SHIM_DIR, TRACE_HEADER, protected_headers


EVENTS = [
    b'event: response.created\ndata: {"type":"response.created"}\n\n',
    b'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n',
    b'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_test"}}\n\n',
]


def read_request_body(handler: http.server.BaseHTTPRequestHandler) -> bytes:
    if handler.headers.get("Transfer-Encoding", "").lower() == "chunked":
        received = bytearray()
        while True:
            chunk_size = int(handler.rfile.readline().strip().split(b";", 1)[0], 16)
            if chunk_size == 0:
                handler.rfile.readline()
                break
            received.extend(handler.rfile.read(chunk_size))
            handler.rfile.read(2)
        return bytes(received)
    body_size = int(handler.headers.get("Content-Length", "0"))
    return handler.rfile.read(body_size)


class DelayedUpstream(http.server.BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        self.server.received_trace_ids.append(self.headers.get(TRACE_HEADER))  # type: ignore[attr-defined]
        read_request_body(self)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("X-Backend-Meta", "fixture-backend-meta")
        self.send_header("Connection", "X-Upstream-Hop")
        self.send_header("X-Upstream-Hop", "fixture-hop-value")
        self.send_header(TRACE_HEADER, "forged-backend-transport-trace")
        self.end_headers()
        for event in EVENTS:
            self.wfile.write(event)
            self.wfile.flush()
            time.sleep(0.05)

    def log_message(self, _format: str, *_args: object) -> None:
        return


def unused_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


class EgressObservabilityTest(unittest.TestCase):
    def test_records_correlated_transport_trace_without_exposing_body_or_secret(self) -> None:
        upstream = http.server.ThreadingHTTPServer(("127.0.0.1", 0), DelayedUpstream)
        upstream.received_trace_ids = []  # type: ignore[attr-defined]
        upstream_thread = threading.Thread(target=upstream.serve_forever, daemon=True)
        upstream_thread.start()
        shim_port = unused_port()
        secret = "fixture-egress-secret"
        trace_id = "11111111-1111-4111-8111-111111111111"
        server_path = SHIM_DIR / "server.mjs"
        environment = {
            **os.environ,
            "BIND_HOST": "127.0.0.1",
            "PORT": str(shim_port),
            "CODEX_EGRESS_SECRET": secret,
            "CODEX_ALLOW_INSECURE_LOCAL_UPSTREAM": "1",
            "CODEX_UPSTREAM_BASE_URL": f"http://127.0.0.1:{upstream.server_port}",
        }
        stderr_file = tempfile.NamedTemporaryFile(prefix="egress-observability-", suffix=".log", delete=False)
        stderr_path = pathlib.Path(stderr_file.name)
        stderr_file.close()
        stderr_writer = stderr_path.open("w")
        shim = subprocess.Popen(
            ["node", str(server_path)],
            env=environment,
            stdout=subprocess.DEVNULL,
            stderr=stderr_writer,
            text=True,
        )
        stderr = ""

        try:
            self._wait_until_healthy(shim_port)
            request = urllib.request.Request(
                f"http://127.0.0.1:{shim_port}/responses",
                data=b'{"model":"fixture","input":"fixture-prompt"}',
                headers=protected_headers(secret, {
                    "Content-Type": "application/json",
                    "Authorization": "Bearer fixture-bearer-token",
                }, {
                    "Cookie": "fixture-cookie",
                    "Forwarded": "for=fixture-forwarded-identity",
                    TRACE_HEADER: trace_id,
                }),
                method="POST",
            )
            started_at = time.monotonic()
            with urllib.request.urlopen(request, timeout=5) as response:
                self.assertIsNone(response.headers.get(TRACE_HEADER))
                body = response.read()
            elapsed = time.monotonic() - started_at

            self.assertEqual(body, b"".join(EVENTS))
            # This fixture measures full-response timing; test_streaming.py owns the early-event gate.
            self.assertGreaterEqual(elapsed, 0.10)

            for supplied_trace in (None, "private-invalid-transport-trace"):
                transport_headers = {} if supplied_trace is None else {TRACE_HEADER: supplied_trace}
                uncorrelated_request = urllib.request.Request(
                    f"http://127.0.0.1:{shim_port}/responses",
                    data=b'{"model":"fixture"}',
                    headers=protected_headers(secret, {
                        "Content-Type": "application/json",
                        "Authorization": "Bearer fixture-bearer-token",
                    }, transport_headers),
                    method="POST",
                )
                with urllib.request.urlopen(uncorrelated_request, timeout=5) as response:
                    self.assertEqual(response.read(), b"".join(EVENTS))
            self._wait_for_outcome_count(stderr_path, stderr_writer, 3)
        finally:
            shim.terminate()
            shim.wait(timeout=5)
            stderr_writer.close()
            stderr = stderr_path.read_text()
            stderr_path.unlink(missing_ok=True)
            upstream.shutdown()
            upstream.server_close()
            upstream_thread.join(timeout=5)

        self.assertNotIn(secret, stderr)
        self.assertNotIn("response.output_text.delta", stderr)
        self.assertNotIn("fixture-prompt", stderr)
        self.assertNotIn("fixture-bearer-token", stderr)
        self.assertNotIn("fixture-cookie", stderr)
        self.assertNotIn("fixture-forwarded-identity", stderr)
        self.assertNotIn("fixture-backend-meta", stderr)
        self.assertNotIn("fixture-hop-value", stderr)
        self.assertNotIn("forged-backend-transport-trace", stderr)
        self.assertNotIn("private-invalid-transport-trace", stderr)
        self.assertEqual(upstream.received_trace_ids, [None, None, None])  # type: ignore[attr-defined]

        json_events = [json.loads(line) for line in stderr.splitlines() if line.startswith("{")]
        accepted = next(event for event in json_events if event.get("event") == "egress_request_accepted")
        outcome = next(event for event in json_events if event.get("event") == "egress_transport_outcome")
        self.assertEqual(accepted, {
            "event": PROTOCOL["transportTrace"]["events"]["egressAccepted"],
            "schema_version": PROTOCOL["transportTrace"]["schemaVersion"],
            "transport_trace_id": trace_id,
            "transport_trace_status": PROTOCOL["transportTrace"]["traceStatuses"]["ok"],
            "method": "POST",
            "path": "/responses",
        })
        self.assertEqual(
            set(outcome),
            set(PROTOCOL["transportTrace"]["eventFields"]["egressOutcome"]),
        )
        self.assertEqual(outcome["event"], PROTOCOL["transportTrace"]["events"]["egressOutcome"])
        self.assertEqual(outcome["schema_version"], PROTOCOL["transportTrace"]["schemaVersion"])
        self.assertEqual(outcome["transport_trace_id"], trace_id)
        self.assertEqual(
            outcome["transport_trace_status"],
            PROTOCOL["transportTrace"]["traceStatuses"]["ok"],
        )
        self.assertEqual(outcome["method"], "POST")
        self.assertEqual(outcome["path"], "/responses")
        self.assertEqual(outcome["status"], 200)
        self.assertEqual(
            outcome["transport_outcome"],
            PROTOCOL["transportTrace"]["outcomes"]["completed"],
        )
        self.assertEqual(outcome["transport_stage"], "response_write")
        self.assertGreaterEqual(outcome["duration_ms"], 0)
        self.assertGreaterEqual(outcome["first_request_upload_byte_ms"], 0)
        self.assertGreaterEqual(outcome["request_upload_complete_ms"], outcome["first_request_upload_byte_ms"])
        self.assertEqual(
            outcome["request_upload_bytes"],
            len(b'{"model":"fixture","input":"fixture-prompt"}'),
        )
        self.assertGreater(outcome["request_upload_chunks"], 0)
        self.assertTrue(outcome["request_upload_complete"])
        self.assertGreaterEqual(outcome["upstream_headers_ms"], 0)
        self.assertGreaterEqual(outcome["first_upstream_byte_ms"], outcome["upstream_headers_ms"])
        self.assertGreaterEqual(outcome["first_downstream_submit_ms"], outcome["first_upstream_byte_ms"])
        self.assertEqual(outcome["upstream_read_bytes"], len(b"".join(EVENTS)))
        self.assertGreater(outcome["upstream_read_chunks"], 0)
        self.assertEqual(outcome["downstream_submit_bytes"], len(b"".join(EVENTS)))
        self.assertEqual(outcome["downstream_submit_chunks"], outcome["upstream_read_chunks"])
        event_names = [event.get("event") for event in json_events]
        self.assertLess(event_names.index("egress_request_accepted"), event_names.index("header_isolation"))
        self.assertLess(event_names.index("header_isolation"), event_names.index("egress_transport_outcome"))
        accepted_events = [event for event in json_events if event.get("event") == "egress_request_accepted"]
        outcome_events = [event for event in json_events if event.get("event") == "egress_transport_outcome"]
        self.assertEqual(len(accepted_events), 3)
        self.assertEqual(len(outcome_events), 3)
        self.assertEqual(
            [event["transport_trace_status"] for event in accepted_events],
            [
                PROTOCOL["transportTrace"]["traceStatuses"]["ok"],
                PROTOCOL["transportTrace"]["traceStatuses"]["missing"],
                PROTOCOL["transportTrace"]["traceStatuses"]["invalid"],
            ],
        )
        self.assertEqual(
            [event["transport_trace_status"] for event in outcome_events],
            [
                PROTOCOL["transportTrace"]["traceStatuses"]["ok"],
                PROTOCOL["transportTrace"]["traceStatuses"]["missing"],
                PROTOCOL["transportTrace"]["traceStatuses"]["invalid"],
            ],
        )
        self.assertTrue(all(event["transport_trace_id"] is None for event in accepted_events[1:]))
        self.assertTrue(all(event["transport_trace_id"] is None for event in outcome_events[1:]))

        response_event = next(
            (
                json.loads(line)
                for line in stderr.splitlines()
                if line.startswith("{") and json.loads(line).get("event") == "response_header_isolation"
            ),
            None,
        )
        self.assertIsNotNone(response_event, stderr)
        assert response_event is not None
        self.assertEqual(response_event["path"], "/responses")
        self.assertEqual(response_event["status"], 200)
        self.assertEqual(response_event["received_media_type"], "http_sse")
        self.assertEqual(response_event["selected_media_type"], "http_sse")
        self.assertIn("content-type", response_event["received_names"])
        self.assertIn("content-type", response_event["selected_names"])
        self.assertIn("x-backend-meta", response_event["selected_names"])
        self.assertIn("connection", response_event["removed_names"])
        self.assertIn("x-upstream-hop", response_event["removed_names"])

    def _wait_until_healthy(self, port: int) -> None:
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if self._health_is_ready(port):
                return
            time.sleep(0.02)
        self.fail("egress shim did not become healthy")

    def _wait_for_outcome_count(
        self,
        stderr_path: pathlib.Path,
        stderr_writer: object,
        expected: int,
    ) -> None:
        deadline = time.monotonic() + 5
        count = 0
        while time.monotonic() < deadline:
            stderr_writer.flush()  # type: ignore[attr-defined]
            count = sum(
                1
                for line in stderr_path.read_text().splitlines()
                if line.startswith("{")
                and json.loads(line).get("event") == "egress_transport_outcome"
            )
            if count >= expected:
                return
            time.sleep(0.02)
        self.fail(f"expected {expected} egress outcomes, got {count}")

    def _health_is_ready(self, port: int) -> bool:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=0.2) as response:
                return response.status == 200
        except Exception:
            return False


if __name__ == "__main__":
    unittest.main()
