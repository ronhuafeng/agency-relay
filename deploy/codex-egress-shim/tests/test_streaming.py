from __future__ import annotations

import http.server
import json
import os
import pathlib
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request

from egress_test_support import MANIFEST_HEADER, PROTOCOL, SECRET_HEADER, SHIM_DIR, TRACE_HEADER, manifest_value, protected_headers

CREATED = b'event: response.created\ndata: {"type":"response.created"}\n\n'
DELTA = b'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"early"}\n\n'
COMPLETED = b'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_stream"}}\n\n'


class QuietResetServer(http.server.ThreadingHTTPServer):
    def handle_error(self, request: object, client_address: object) -> None:
        if isinstance(sys.exc_info()[1], ConnectionResetError):
            return
        super().handle_error(request, client_address)


def read_request_body(handler: http.server.BaseHTTPRequestHandler) -> bytes:
    if handler.headers.get("Transfer-Encoding", "").lower() == "chunked":
        received = bytearray()
        while True:
            size_line = handler.rfile.readline()
            if not size_line:
                break
            chunk_size = int(size_line.strip().split(b";", 1)[0], 16)
            if chunk_size == 0:
                handler.rfile.readline()
                break
            received.extend(handler.rfile.read(chunk_size))
            handler.rfile.read(2)
        return bytes(received)
    body_size = int(handler.headers.get("Content-Length", "0"))
    return handler.rfile.read(body_size)


class DelayedEventUpstream(http.server.BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        read_request_body(self)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        self.wfile.write(CREATED)
        self.wfile.flush()
        time.sleep(0.2)
        self.wfile.write(DELTA)
        self.wfile.flush()
        time.sleep(0.2)
        self.server.completed_sent.set()  # type: ignore[attr-defined]
        self.wfile.write(COMPLETED)
        self.wfile.flush()

    def log_message(self, _format: str, *_args: object) -> None:
        return


class ScenarioUpstream(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_POST(self) -> None:
        payload = json.loads(read_request_body(self) or b"{}")
        case = payload.get("case")
        if case == "error":
            status = int(payload["status"])
            body = json.dumps({"error": {"type": "fixture_error", "code": f"fixture_{status}", "message": "structured"}}).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if case == "large":
            chunks = [b"x" * (512 * 1024)]
        elif case in {"disconnect", "write_failure"}:
            chunks = [b"event: response.created\ndata: {}\n\n"] + [b"x" * (64 * 1024) for _ in range(16)]
        else:
            chunks = [bytes.fromhex(value) for value in payload.get("chunks", [])]
        body_length = sum(len(chunk) for chunk in chunks)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(body_length))
        self.end_headers()
        for index, chunk in enumerate(chunks):
            try:
                self.wfile.write(chunk)
                self.wfile.flush()
                if case == "disconnect" and index == 0:
                    time.sleep(0.2)
            except (BrokenPipeError, ConnectionResetError):
                self.close_connection = True
                break

    def log_message(self, _format: str, *_args: object) -> None:
        return


class StreamingRequestUpstream(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_POST(self) -> None:
        received = bytearray()
        if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
            while True:
                chunk_size = int(self.rfile.readline().strip().split(b";", 1)[0], 16)
                if chunk_size == 0:
                    self.rfile.readline()
                    break
                received.extend(self.rfile.read(chunk_size))
                self.rfile.read(2)
                self.server.first_request_bytes.set()  # type: ignore[attr-defined]
        else:
            body_size = int(self.headers.get("Content-Length", "0"))
            first = self.rfile.read(min(1024, body_size))
            received.extend(first)
            self.server.first_request_bytes.set()  # type: ignore[attr-defined]
            received.extend(self.rfile.read(body_size - len(first)))
        self.server.request_body = bytes(received)  # type: ignore[attr-defined]
        response = b"ok"
        self.send_response(200)
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)

    def log_message(self, _format: str, *_args: object) -> None:
        return


class InterruptedUploadUpstream(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_POST(self) -> None:
        with self.server.counter_lock:  # type: ignore[attr-defined]
            self.server.request_count += 1  # type: ignore[attr-defined]
            if self.server.request_count >= self.server.expected_requests:  # type: ignore[attr-defined]
                self.server.all_requests_started.set()  # type: ignore[attr-defined]
        self.server.request_started.set()  # type: ignore[attr-defined]
        received = 0
        completed = False
        try:
            if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
                while True:
                    size_line = self.rfile.readline()
                    if not size_line:
                        break
                    chunk_size = int(size_line.strip().split(b";", 1)[0], 16)
                    if chunk_size == 0:
                        self.rfile.readline()
                        completed = True
                        break
                    remaining = chunk_size
                    while remaining > 0:
                        chunk = self.rfile.read(min(1024, remaining))
                        if not chunk:
                            break
                        received += len(chunk)
                        remaining -= len(chunk)
                        time.sleep(0.002)
                    if remaining > 0:
                        break
                    self.rfile.read(2)
            else:
                expected = int(self.headers.get("Content-Length", "0"))
                while received < expected:
                    chunk = self.rfile.read(min(1024, expected - received))
                    if not chunk:
                        break
                    received += len(chunk)
                    time.sleep(0.002)
                completed = received == expected
        except (BrokenPipeError, ConnectionResetError):
            pass
        self.server.received_bytes = received  # type: ignore[attr-defined]
        if not completed:
            with self.server.counter_lock:  # type: ignore[attr-defined]
                self.server.cancelled_count += 1  # type: ignore[attr-defined]
                if self.server.cancelled_count >= self.server.expected_requests:  # type: ignore[attr-defined]
                    self.server.upload_cancelled.set()  # type: ignore[attr-defined]

    def log_message(self, _format: str, *_args: object) -> None:
        return


class PausedRequestUpstream(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_POST(self) -> None:
        self.server.request_started.set()  # type: ignore[attr-defined]
        self.server.allow_read.wait(5)  # type: ignore[attr-defined]
        received = 0
        if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
            while True:
                chunk_size = int(self.rfile.readline().strip().split(b";", 1)[0], 16)
                if chunk_size == 0:
                    self.rfile.readline()
                    break
                remaining = chunk_size
                while remaining > 0:
                    chunk = self.rfile.read(min(64 * 1024, remaining))
                    if not chunk:
                        break
                    received += len(chunk)
                    remaining -= len(chunk)
                self.rfile.read(2)
        else:
            expected = int(self.headers.get("Content-Length", "0"))
            while received < expected:
                chunk = self.rfile.read(min(64 * 1024, expected - received))
                if not chunk:
                    break
                received += len(chunk)
        self.server.received_bytes = received  # type: ignore[attr-defined]
        response = b"ok"
        self.send_response(200)
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)

    def log_message(self, _format: str, *_args: object) -> None:
        return


def unused_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def start_shim(upstream_port: int, secret: str, stderr: object) -> tuple[subprocess.Popen[str], int]:
    shim_port = unused_port()
    shim = subprocess.Popen(
        ["node", str(SHIM_DIR / "server.mjs")],
        env={
            **os.environ,
            "BIND_HOST": "127.0.0.1",
            "PORT": str(shim_port),
            "CODEX_EGRESS_SECRET": secret,
            "CODEX_ALLOW_INSECURE_LOCAL_UPSTREAM": "1",
            "CODEX_UPSTREAM_BASE_URL": f"http://127.0.0.1:{upstream_port}",
        },
        stdout=subprocess.DEVNULL,
        stderr=stderr,
        text=True,
    )
    wait_until_healthy(shim_port)
    return shim, shim_port


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


class EgressStreamingTest(unittest.TestCase):
    def test_small_delta_arrives_before_upstream_completed_event(self) -> None:
        upstream = http.server.ThreadingHTTPServer(("127.0.0.1", 0), DelayedEventUpstream)
        upstream.completed_sent = threading.Event()  # type: ignore[attr-defined]
        upstream_thread = threading.Thread(target=upstream.serve_forever, daemon=True)
        upstream_thread.start()
        secret = "streaming-fixture-secret"
        shim, shim_port = start_shim(upstream.server_port, secret, subprocess.PIPE)

        try:
            request = urllib.request.Request(
                f"http://127.0.0.1:{shim_port}/responses",
                data=b'{"model":"fixture"}',
                headers=protected_headers(secret, {
                    "Authorization": "Bearer shared-token",
                    "Content-Type": "application/json",
                }),
                method="POST",
            )
            with urllib.request.urlopen(request, timeout=5) as response:
                received = b""
                while DELTA not in received:
                    line = response.readline()
                    self.assertTrue(line, "stream ended before delta")
                    received += line
                self.assertFalse(upstream.completed_sent.is_set())  # type: ignore[attr-defined]
                received += response.read()
            self.assertEqual(received, CREATED + DELTA + COMPLETED)
        finally:
            shim.terminate()
            shim.communicate(timeout=5)
            upstream.shutdown()
            upstream.server_close()
            upstream_thread.join(timeout=5)

    def test_streams_request_bytes_before_client_finishes_uploading(self) -> None:
        upstream = http.server.ThreadingHTTPServer(("127.0.0.1", 0), StreamingRequestUpstream)
        upstream.daemon_threads = True
        upstream.first_request_bytes = threading.Event()  # type: ignore[attr-defined]
        upstream.request_body = b""  # type: ignore[attr-defined]
        upstream_thread = threading.Thread(target=upstream.serve_forever, daemon=True)
        upstream_thread.start()
        secret = "request-streaming-secret"
        shim, shim_port = start_shim(upstream.server_port, secret, subprocess.PIPE)
        body = bytes(range(256)) * 512
        first = body[:1024]
        remainder = body[1024:]
        client = socket.create_connection(("127.0.0.1", shim_port), timeout=5)

        try:
            headers = (
                f"POST /responses HTTP/1.1\r\nHost: 127.0.0.1\r\n"
                f"{SECRET_HEADER}: {secret}\r\n{MANIFEST_HEADER}: "
                f"{manifest_value(['authorization', 'content-type'])}\r\n"
                f"Authorization: Bearer shared-token\r\nContent-Type: application/octet-stream\r\n"
                f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n"
            ).encode()
            client.sendall(headers + first)
            reached_upstream_before_upload_finished = upstream.first_request_bytes.wait(0.25)  # type: ignore[attr-defined]
            client.sendall(remainder)
            response = bytearray()
            while True:
                chunk = client.recv(4096)
                if not chunk:
                    break
                response.extend(chunk)

            self.assertTrue(reached_upstream_before_upload_finished)
            self.assertIn(b"\r\nok\r\n", response)
            self.assertEqual(upstream.request_body, body)  # type: ignore[attr-defined]
        finally:
            client.close()
            shim.terminate()
            shim.communicate(timeout=5)
            upstream.shutdown()
            upstream.server_close()
            upstream_thread.join(timeout=5)

    def test_content_length_upload_disconnect_has_one_upload_abort_outcome(self) -> None:
        self._assert_upload_abort("content-length", "66666666-6666-4666-8666-666666666666")

    def test_chunked_upload_disconnect_has_one_upload_abort_outcome(self) -> None:
        self._assert_upload_abort("chunked", "77777777-7777-4777-8777-777777777777")

    def _assert_upload_abort(self, framing: str, trace_id: str) -> None:
        upstream = http.server.ThreadingHTTPServer(("127.0.0.1", 0), InterruptedUploadUpstream)
        upstream.daemon_threads = True
        upstream.request_started = threading.Event()  # type: ignore[attr-defined]
        upstream.all_requests_started = threading.Event()  # type: ignore[attr-defined]
        upstream.upload_cancelled = threading.Event()  # type: ignore[attr-defined]
        upstream.counter_lock = threading.Lock()  # type: ignore[attr-defined]
        upstream.expected_requests = 1  # type: ignore[attr-defined]
        upstream.request_count = 0  # type: ignore[attr-defined]
        upstream.cancelled_count = 0  # type: ignore[attr-defined]
        upstream.received_bytes = 0  # type: ignore[attr-defined]
        upstream_thread = threading.Thread(target=upstream.serve_forever, daemon=True)
        upstream_thread.start()
        secret = "cancel-upload-secret"
        shim, shim_port = start_shim(upstream.server_port, secret, subprocess.PIPE)
        declared_size = 8 * 1024 * 1024
        private_marker = b"private-upload-marker-"
        uploaded = (private_marker * (64 * 1024 // len(private_marker) + 1))[:64 * 1024]
        client = socket.create_connection(("127.0.0.1", shim_port), timeout=5)
        stderr = ""

        try:
            framing_header = (
                f"Content-Length: {declared_size}\r\n"
                if framing == "content-length"
                else "Transfer-Encoding: chunked\r\n"
            )
            headers = (
                f"POST /responses HTTP/1.1\r\nHost: 127.0.0.1\r\n"
                f"{SECRET_HEADER}: {secret}\r\n{MANIFEST_HEADER}: "
                f"{manifest_value(['authorization', 'content-type'])}\r\n"
                f"{TRACE_HEADER}: {trace_id}\r\n"
                f"Authorization: Bearer shared-token\r\nContent-Type: application/octet-stream\r\n"
                f"{framing_header}Connection: close\r\n\r\n"
            ).encode()
            encoded_upload = uploaded if framing == "content-length" else f"{len(uploaded):x}\r\n".encode() + uploaded + b"\r\n"
            client.sendall(headers + encoded_upload)
            self.assertTrue(upstream.request_started.wait(1))  # type: ignore[attr-defined]
            client.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
            client.close()

            self.assertTrue(upstream.upload_cancelled.wait(5))  # type: ignore[attr-defined]
            self.assertEqual(upstream.request_count, 1)  # type: ignore[attr-defined]
            self.assertLess(upstream.received_bytes, declared_size)  # type: ignore[attr-defined]
        finally:
            client.close()
            shim.terminate()
            _, stderr = shim.communicate(timeout=5)
            upstream.shutdown()
            upstream.server_close()
            upstream_thread.join(timeout=5)

        events = [json.loads(line) for line in stderr.splitlines() if line.startswith("{")]
        accepted = [
            event for event in events
            if event.get("event") == "egress_request_accepted"
            and event.get("transport_trace_id") == trace_id
        ]
        outcomes = [
            event for event in events
            if event.get("event") == "egress_transport_outcome"
            and event.get("transport_trace_id") == trace_id
        ]
        self.assertEqual(len(accepted), 1, stderr)
        self.assertEqual(len(outcomes), 1, stderr)
        self.assertEqual(
            set(outcomes[0]),
            set(PROTOCOL["transportTrace"]["eventFields"]["egressOutcome"]),
        )
        self.assertEqual(outcomes[0]["transport_outcome"], "request_upload_aborted")
        self.assertEqual(outcomes[0]["transport_stage"], "request_upload")
        self.assertFalse(outcomes[0]["request_upload_complete"])
        self.assertGreater(outcomes[0]["request_upload_bytes"], 0)
        self.assertGreater(outcomes[0]["request_upload_chunks"], 0)
        self.assertIsNone(outcomes[0]["request_upload_complete_ms"])
        self.assertGreaterEqual(outcomes[0]["first_request_upload_byte_ms"], 0)
        self.assertEqual(outcomes[0]["upstream_read_bytes"], 0)
        self.assertEqual(outcomes[0]["downstream_submit_bytes"], 0)
        self.assertNotIn(secret, stderr)
        self.assertNotIn(private_marker.decode(), stderr)

    def test_concurrent_upload_aborts_emit_once(self) -> None:
        request_count = 12
        upstream = http.server.ThreadingHTTPServer(("127.0.0.1", 0), InterruptedUploadUpstream)
        upstream.daemon_threads = True
        upstream.request_started = threading.Event()  # type: ignore[attr-defined]
        upstream.all_requests_started = threading.Event()  # type: ignore[attr-defined]
        upstream.upload_cancelled = threading.Event()  # type: ignore[attr-defined]
        upstream.counter_lock = threading.Lock()  # type: ignore[attr-defined]
        upstream.expected_requests = request_count  # type: ignore[attr-defined]
        upstream.request_count = 0  # type: ignore[attr-defined]
        upstream.cancelled_count = 0  # type: ignore[attr-defined]
        upstream.received_bytes = 0  # type: ignore[attr-defined]
        upstream_thread = threading.Thread(target=upstream.serve_forever, daemon=True)
        upstream_thread.start()
        secret = "concurrent-cancel-secret"
        shim, shim_port = start_shim(upstream.server_port, secret, subprocess.PIPE)
        clients: list[socket.socket] = []
        trace_ids: list[str] = []
        stderr = ""

        try:
            for index in range(request_count):
                trace_id = f"88888888-8888-4888-8{index:03x}-888888888888"
                trace_ids.append(trace_id)
                client = socket.create_connection(("127.0.0.1", shim_port), timeout=5)
                clients.append(client)
                headers = (
                    f"POST /responses HTTP/1.1\r\nHost: 127.0.0.1\r\n"
                    f"{SECRET_HEADER}: {secret}\r\n{MANIFEST_HEADER}: "
                    f"{manifest_value(['authorization', 'content-type'])}\r\n"
                    f"{TRACE_HEADER}: {trace_id}\r\n"
                    f"Authorization: Bearer shared-token\r\nContent-Type: application/octet-stream\r\n"
                    f"Content-Length: {8 * 1024 * 1024}\r\nConnection: close\r\n\r\n"
                ).encode()
                client.sendall(headers + b"z" * (64 * 1024))

            self.assertTrue(upstream.all_requests_started.wait(5))  # type: ignore[attr-defined]
            for client in clients:
                client.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
                client.close()
            self.assertTrue(upstream.upload_cancelled.wait(5))  # type: ignore[attr-defined]
            self.assertEqual(upstream.request_count, request_count)  # type: ignore[attr-defined]
            self.assertEqual(upstream.cancelled_count, request_count)  # type: ignore[attr-defined]
        finally:
            for client in clients:
                client.close()
            shim.terminate()
            _, stderr = shim.communicate(timeout=5)
            upstream.shutdown()
            upstream.server_close()
            upstream_thread.join(timeout=5)

        outcomes = [
            json.loads(line)
            for line in stderr.splitlines()
            if line.startswith("{")
            and json.loads(line).get("event") == "egress_transport_outcome"
            and json.loads(line).get("transport_trace_id") in trace_ids
        ]
        self.assertEqual(len(outcomes), request_count, stderr)
        self.assertEqual({event["transport_trace_id"] for event in outcomes}, set(trace_ids))
        self.assertTrue(all(event["transport_outcome"] == "request_upload_aborted" for event in outcomes))
        self.assertNotIn(secret, stderr)

class EgressStreamingMatrixTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.upstream = QuietResetServer(("127.0.0.1", 0), ScenarioUpstream)
        cls.upstream_thread = threading.Thread(target=cls.upstream.serve_forever, daemon=True)
        cls.upstream_thread.start()
        cls.secret = "matrix-fixture-secret"
        stderr_file = tempfile.NamedTemporaryFile(prefix="egress-streaming-", suffix=".log", delete=False)
        cls.stderr_path = pathlib.Path(stderr_file.name)
        stderr_file.close()
        cls.stderr_writer = cls.stderr_path.open("w")
        cls.shim, cls.shim_port = start_shim(cls.upstream.server_port, cls.secret, cls.stderr_writer)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.shim.terminate()
        cls.shim.wait(timeout=5)
        cls.stderr_writer.close()
        cls.stderr_path.unlink(missing_ok=True)
        cls.upstream.shutdown()
        cls.upstream.server_close()
        cls.upstream_thread.join(timeout=5)

    def test_preserves_lf_crlf_utf8_and_one_byte_through_32kib_upstream_writes(self) -> None:
        utf8 = "跨界🙂".encode()
        expected = (
            b"event: response.created\r\ndata: {}\r\n\r\n"
            + b"event: response.output_text.delta\ndata: "
            + utf8
            + b"\n\n"
            + b"x" * (32 * 1024)
        )
        chunks = [expected[:1], expected[1:37], expected[37:40], expected[40:41], expected[41:4096], expected[4096:]]
        self.assertEqual(self._post({"case": "bytes", "chunks": [chunk.hex() for chunk in chunks]}), expected)

    def test_forwards_429_500_and_structured_json_error_bytes(self) -> None:
        for status in (429, 500):
            with self.subTest(status=status):
                request = self._request({"case": "error", "status": status})
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    urllib.request.urlopen(request, timeout=5)
                self.assertEqual(caught.exception.code, status)
                body = caught.exception.read()
                caught.exception.close()
                self.assertEqual(json.loads(body)["error"]["code"], f"fixture_{status}")

    def test_slow_client_receives_identical_bytes(self) -> None:
        request = self._request({"case": "large"})
        received = bytearray()
        with urllib.request.urlopen(request, timeout=10) as response:
            while True:
                chunk = response.read(1024)
                if not chunk:
                    break
                received.extend(chunk)
                time.sleep(0.0005)
        self.assertEqual(received, b"x" * (512 * 1024))

    def test_classifies_downstream_close(self) -> None:
        offset = len(self._logs())
        trace_id = "22222222-2222-4222-8222-222222222222"
        payload = json.dumps({"case": "disconnect"}).encode()
        raw_request = (
            f"POST /responses HTTP/1.1\r\nHost: 127.0.0.1\r\n"
            f"{SECRET_HEADER}: {self.secret}\r\n{MANIFEST_HEADER}: "
            f"{manifest_value(['authorization', 'content-type'])}\r\n"
            f"{TRACE_HEADER}: {trace_id}\r\n"
            f"Authorization: Bearer shared-token\r\nContent-Type: application/json\r\n"
            f"Content-Length: {len(payload)}\r\nConnection: close\r\n\r\n"
        ).encode() + payload
        client = socket.create_connection(("127.0.0.1", self.shim_port), timeout=5)
        client.sendall(raw_request)
        received = b""
        while b"event: response.created" not in received:
            received += client.recv(4096)
        client.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
        client.close()

        outcome_events = []
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            outcome_events = [
                json.loads(line)
                for line in self._logs()[offset:]
                if line.startswith("{")
                and json.loads(line).get("event") == "egress_transport_outcome"
                and json.loads(line).get("transport_trace_id") == trace_id
            ]
            if outcome_events:
                break
            time.sleep(0.02)
        self.assertEqual(len(outcome_events), 1)
        self.assertEqual(outcome_events[0]["transport_outcome"], "downstream_closed")
        self.assertEqual(outcome_events[0]["transport_stage"], "response_write")
        self.assertGreater(outcome_events[0]["upstream_read_bytes"], 0)
        self.assertGreater(outcome_events[0]["downstream_submit_bytes"], 0)
        outcome_logs = self._logs()[offset:]
        self.assertFalse(any(self.secret in line for line in outcome_logs))
        self.assertFalse(any("response.created" in line for line in outcome_logs))

    def test_classifies_downstream_write_or_drain_failure_from_real_socket(self) -> None:
        offset = len(self._logs())
        trace_id = "55555555-5555-4555-8555-555555555555"
        payload = json.dumps({"case": "write_failure"}).encode()
        raw_request = (
            f"POST /responses HTTP/1.1\r\nHost: 127.0.0.1\r\n"
            f"{SECRET_HEADER}: {self.secret}\r\n{MANIFEST_HEADER}: "
            f"{manifest_value(['authorization', 'content-type'])}\r\n"
            f"{TRACE_HEADER}: {trace_id}\r\n"
            f"Authorization: Bearer shared-token\r\nContent-Type: application/json\r\n"
            f"Content-Length: {len(payload)}\r\nConnection: close\r\n\r\n"
        ).encode() + payload
        client = socket.create_connection(("127.0.0.1", self.shim_port), timeout=5)
        client.sendall(raw_request)
        received = b""
        while b"\r\n\r\n" not in received:
            received += client.recv(4096)
        client.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
        client.close()

        outcome_events = []
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            outcome_events = [
                json.loads(line)
                for line in self._logs()[offset:]
                if line.startswith("{")
                and json.loads(line).get("event") == "egress_transport_outcome"
                and json.loads(line).get("transport_trace_id") == trace_id
            ]
            if outcome_events:
                break
            time.sleep(0.02)
        self.assertEqual(len(outcome_events), 1)
        self.assertEqual(outcome_events[0]["transport_outcome"], "downstream_write_failed")
        self.assertEqual(outcome_events[0]["transport_stage"], "response_write")
        self.assertGreater(outcome_events[0]["upstream_read_bytes"], 0)
        self.assertGreater(outcome_events[0]["downstream_submit_bytes"], 0)

    def _post(self, payload: dict[str, object]) -> bytes:
        with urllib.request.urlopen(self._request(payload), timeout=10) as response:
            return response.read()

    def _request(self, payload: dict[str, object]) -> urllib.request.Request:
        return urllib.request.Request(
            f"http://127.0.0.1:{self.shim_port}/responses",
            data=json.dumps(payload).encode(),
            headers=protected_headers(self.secret, {
                "Authorization": "Bearer shared-token",
                "Content-Type": "application/json",
            }),
            method="POST",
        )

    def _logs(self) -> list[str]:
        self.stderr_writer.flush()
        return self.stderr_path.read_text().splitlines()


if __name__ == "__main__":
    unittest.main()
