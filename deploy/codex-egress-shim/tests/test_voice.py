from __future__ import annotations

import http.server
import os
import subprocess
import threading
import unittest
import urllib.error
import urllib.request

from egress_test_support import SHIM_DIR, protected_headers
from test_models import unused_port, wait_until_healthy
from test_streaming import read_request_body


class VoiceUpstream(http.server.BaseHTTPRequestHandler):
    requests: list[dict[str, str | None]] = []

    def do_POST(self) -> None:
        body = read_request_body(self)
        self.__class__.requests.append({
            "path": self.path,
            "body": body.decode(),
            "authorization": self.headers.get("Authorization"),
            "type": self.headers.get("Content-Type"),
        })
        payload = b'{"ok":true}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, _format: str, *_args: object) -> None:
        return


class VoicePassthroughTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        VoiceUpstream.requests = []
        cls.upstream = http.server.ThreadingHTTPServer(("127.0.0.1", 0), VoiceUpstream)
        cls.upstream_thread = threading.Thread(target=cls.upstream.serve_forever, daemon=True)
        cls.upstream_thread.start()
        cls.secret = "voice-fixture-secret"
        cls.shim_port = unused_port()
        cls.shim = subprocess.Popen(
            ["node", str(SHIM_DIR / "server.mjs")],
            env={
                **os.environ,
                "BIND_HOST": "127.0.0.1",
                "PORT": str(cls.shim_port),
                "CODEX_EGRESS_SECRET": cls.secret,
                "CODEX_ALLOW_INSECURE_LOCAL_UPSTREAM": "1",
                "CODEX_UPSTREAM_BASE_URL": f"http://127.0.0.1:{cls.upstream.server_port}/backend-api/codex",
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

    def post(self, path: str, body: bytes) -> None:
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.shim_port}{path}",
            data=body,
            headers=protected_headers(self.secret, {
                "Authorization": "Bearer shared-token",
                "Content-Type": "application/json",
            }),
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=5) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.read(), b'{"ok":true}')

    def test_forwards_realtime_live_and_rewrites_transcribe(self) -> None:
        self.post("/realtime/calls?intent=quicksilver", b'{"sdp":"v=0"}')
        self.post("/live", b'{"sdp":"v=0"}')
        self.post("/transcribe", b"audio")
        self.assertEqual(
            [item["path"] for item in VoiceUpstream.requests],
            [
                "/backend-api/codex/realtime/calls?intent=quicksilver",
                "/backend-api/codex/live",
                "/backend-api/transcribe",
            ],
        )
        self.assertEqual(VoiceUpstream.requests[0]["authorization"], "Bearer shared-token")
        self.assertEqual(VoiceUpstream.requests[2]["body"], "audio")

    def test_still_rejects_unknown_post_paths(self) -> None:
        before = len(VoiceUpstream.requests)
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.shim_port}/v1/audio/speech",
            data=b"{}",
            headers=protected_headers(self.secret, {
                "Authorization": "Bearer shared-token",
                "Content-Type": "application/json",
            }),
            method="POST",
        )
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(request, timeout=5)
        self.assertEqual(caught.exception.code, 404)
        caught.exception.close()
        self.assertEqual(len(VoiceUpstream.requests), before)
