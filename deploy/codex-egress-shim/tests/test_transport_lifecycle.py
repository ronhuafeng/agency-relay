from __future__ import annotations

import json
import subprocess
import textwrap
import unittest

from egress_test_support import SHIM_DIR


def run_lifecycle_script(source: str) -> object:
    completed = subprocess.run(
        ["node", "--input-type=module", "--eval", textwrap.dedent(source)],
        cwd=SHIM_DIR,
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(completed.stdout)


class TransportLifecycleTest(unittest.TestCase):
    def test_upload_observer_preserves_pipe_backpressure_and_bytes(self) -> None:
        result = run_lifecycle_script("""
            import { once } from "node:events";
            import { PassThrough, Writable } from "node:stream";
            import { attachRequestRuntime } from "./node-transport-adapter.mjs";
            import { createTransportLifecycle } from "./transport-lifecycle.mjs";

            const request = new PassThrough({ highWaterMark: 1 });
            request.complete = false;
            let releaseFirstWrite;
            let destinationBytes = 0;
            const destination = new Writable({
              highWaterMark: 1,
              write(chunk, _encoding, callback) {
                destinationBytes += chunk.length;
                if (!releaseFirstWrite) {
                  releaseFirstWrite = callback;
                } else {
                  callback();
                }
              }
            });
            const lifecycle = createTransportLifecycle({
              traceMetadata: {}, method: "POST", path: "/responses", now: () => 10
            });
            attachRequestRuntime({ request, lifecycle, cancelUpstream: () => {} });
            request.pipe(destination);
            request.write(Buffer.alloc(7));
            await new Promise((resolve) => setImmediate(resolve));
            const pausedWhileBlocked = request.isPaused();
            releaseFirstWrite();
            request.complete = true;
            request.end(Buffer.alloc(5));
            await once(destination, "finish");
            const outcome = lifecycle.finish("completed");
            request.emit("close");
            console.log(JSON.stringify({ pausedWhileBlocked, destinationBytes, outcome }));
        """)

        self.assertTrue(result["pausedWhileBlocked"])
        self.assertEqual(result["destinationBytes"], 12)
        self.assertEqual(result["outcome"]["request_upload_bytes"], 12)
        self.assertEqual(result["outcome"]["request_upload_chunks"], 2)
        self.assertTrue(result["outcome"]["request_upload_complete"])

    def test_node_adapter_cleanup_is_first_wins_for_error_then_close(self) -> None:
        result = run_lifecycle_script("""
            import { EventEmitter } from "node:events";
            import { attachDownstreamRuntime } from "./node-transport-adapter.mjs";
            import { createTransportLifecycle } from "./transport-lifecycle.mjs";

            const response = new EventEmitter();
            response.writableFinished = false;
            let cancelCount = 0;
            let prematureCloseCount = 0;
            let outcome;
            const lifecycle = createTransportLifecycle({
              traceMetadata: {},
              method: "POST",
              path: "/responses",
              onFinish: (finalOutcome) => { outcome = finalOutcome; }
            });
            lifecycle.recordRequestUploadComplete();
            lifecycle.recordUpstreamHeaders(200);
            attachDownstreamRuntime({
              response,
              lifecycle,
              onPrematureClose: () => { prematureCloseCount += 1; },
              cancelUpstream: () => { cancelCount += 1; }
            });
            response.emit("error", new Error("write failed"));
            response.emit("close");
            console.log(JSON.stringify({ outcome, cancelCount, prematureCloseCount }));
        """)

        self.assertEqual(result["outcome"]["transport_outcome"], "downstream_write_failed")
        self.assertEqual(result["cancelCount"], 1)
        self.assertEqual(result["prematureCloseCount"], 0)

    def test_end_called_but_unflushed_socket_close_is_not_lost(self) -> None:
        result = run_lifecycle_script("""
            import { EventEmitter } from "node:events";
            import { attachDownstreamRuntime } from "./node-transport-adapter.mjs";
            import { createTransportLifecycle } from "./transport-lifecycle.mjs";

            const response = new EventEmitter();
            response.writableEnded = true;
            response.writableFinished = false;
            let cancelCount = 0;
            let outcome;
            const lifecycle = createTransportLifecycle({
              traceMetadata: {},
              method: "GET",
              path: "/responses",
              onFinish: (finalOutcome) => { outcome = finalOutcome; }
            });
            lifecycle.recordRequestUploadComplete();
            lifecycle.recordUpstreamHeaders(200);
            attachDownstreamRuntime({
              response,
              lifecycle,
              cancelUpstream: () => { cancelCount += 1; }
            });
            response.emit("close");
            response.emit("error", new Error("induced after close"));
            console.log(JSON.stringify({
              outcome,
              writableEnded: response.writableEnded,
              writableFinished: response.writableFinished,
              cancelCount
            }));
        """)

        self.assertEqual(result["outcome"]["transport_outcome"], "downstream_closed")
        self.assertEqual(result["outcome"]["transport_stage"], "response_write")
        self.assertTrue(result["writableEnded"])
        self.assertFalse(result["writableFinished"])
        self.assertEqual(result["cancelCount"], 1)

    def test_freezes_progress_and_emits_the_first_terminal_outcome_once(self) -> None:
        result = run_lifecycle_script("""
            import { createTransportLifecycle } from "./transport-lifecycle.mjs";

            let now = 100;
            const emitted = [];
            const lifecycle = createTransportLifecycle({
              traceMetadata: { transport_trace_id: "trace", transport_trace_status: "ok" },
              method: "POST",
              path: "/responses",
              now: () => now,
              onFinish: (outcome) => emitted.push(outcome)
            });
            now = 102;
            lifecycle.recordRequestUpload(4);
            now = 104;
            lifecycle.recordRequestUploadComplete();
            now = 105;
            lifecycle.recordUpstreamHeaders(200);
            now = 107;
            lifecycle.recordUpstreamRead(11);
            now = 109;
            lifecycle.recordDownstreamSubmit(7);
            now = 120;
            const first = lifecycle.finish("upstream_error");
            lifecycle.recordUpstreamRead(99);
            lifecycle.recordDownstreamSubmit(99);
            const repeated = lifecycle.finish("downstream_close");
            console.log(JSON.stringify({
              state: lifecycle.state,
              frozen: Object.isFrozen(first),
              same: first === repeated,
              emitted,
              outcome: first
            }));
        """)

        self.assertEqual(result["state"], "finished")
        self.assertTrue(result["frozen"])
        self.assertTrue(result["same"])
        self.assertEqual(len(result["emitted"]), 1)
        self.assertEqual(result["outcome"], {
            "transport_trace_id": "trace",
            "transport_trace_status": "ok",
            "method": "POST",
            "path": "/responses",
            "status": 200,
            "transport_outcome": "upstream_read_failed",
            "transport_stage": "response_read",
            "duration_ms": 20,
            "first_request_upload_byte_ms": 2,
            "request_upload_complete_ms": 4,
            "request_upload_bytes": 4,
            "request_upload_chunks": 1,
            "request_upload_complete": True,
            "upstream_headers_ms": 5,
            "first_upstream_byte_ms": 7,
            "first_downstream_submit_ms": 9,
            "upstream_read_bytes": 11,
            "upstream_read_chunks": 1,
            "downstream_submit_bytes": 7,
            "downstream_submit_chunks": 1,
        })

    def test_maps_each_terminal_signal_from_lifecycle_state(self) -> None:
        result = run_lifecycle_script("""
            import { createTransportLifecycle } from "./transport-lifecycle.mjs";

            const cases = [
              ["completed", false, true],
              ["upstream_error", false, true],
              ["upstream_error", true, true],
              ["downstream_close", false, true],
              ["downstream_error", false, true],
              ["request_abort", false, false],
              ["request_abort", false, true],
              ["downstream_error", false, false],
              ["runtime_unknown", false, false]
            ];
            const outcomes = [];
            for (const [signal, streaming, uploadComplete] of cases) {
              const lifecycle = createTransportLifecycle({
                traceMetadata: {},
                method: "GET",
                path: "/models",
                now: () => 10
              });
              if (uploadComplete) {
                lifecycle.recordRequestUploadComplete();
              }
              if (streaming) {
                lifecycle.recordUpstreamHeaders(200);
              }
              outcomes.push({
                initialState: lifecycle.state,
                final: lifecycle.finish(signal),
                finalState: lifecycle.state
              });
            }
            console.log(JSON.stringify(outcomes));
        """)

        expected = [
            ("pending", "completed", "response_write", None),
            ("pending", "upstream_request_failed", "upstream_connect", None),
            ("streaming", "upstream_read_failed", "response_read", 200),
            ("pending", "downstream_closed", "response_write", None),
            ("pending", "downstream_write_failed", "response_write", None),
            ("pending", "request_upload_aborted", "request_upload", None),
            ("pending", "indeterminate", "unknown", None),
            ("pending", "indeterminate", "unknown", None),
            ("pending", "indeterminate", "unknown", None),
        ]
        for item, (initial_state, outcome, stage, status) in zip(result, expected, strict=True):
            with self.subTest(outcome=outcome):
                self.assertEqual(item["initialState"], initial_state)
                self.assertEqual(item["finalState"], "finished")
                self.assertEqual(item["final"]["transport_outcome"], outcome)
                self.assertEqual(item["final"]["transport_stage"], stage)
                self.assertEqual(item["final"]["status"], status)
                self.assertEqual(item["final"]["upstream_read_bytes"], 0)
                self.assertEqual(item["final"]["downstream_submit_bytes"], 0)

    def test_contains_sink_failure_and_preserves_both_race_orders(self) -> None:
        result = run_lifecycle_script("""
            import { createTransportLifecycle } from "./transport-lifecycle.mjs";

            function race(first, second) {
              let emissions = 0;
              const lifecycle = createTransportLifecycle({
                traceMetadata: {},
                method: "POST",
                path: "/responses",
                now: () => 50,
                onFinish: () => {
                  emissions += 1;
                  throw new Error("sink unavailable");
                }
              });
              lifecycle.recordRequestUploadComplete();
              lifecycle.recordUpstreamHeaders(200);
              const firstOutcome = lifecycle.finish(first);
              const secondOutcome = lifecycle.finish(second);
              return {
                emissions,
                same: firstOutcome === secondOutcome,
                outcome: secondOutcome.transport_outcome
              };
            }

            function incompleteUploadRace(first, second) {
              const lifecycle = createTransportLifecycle({
                traceMetadata: {}, method: "POST", path: "/responses", now: () => 50
              });
              const firstOutcome = lifecycle.finish(first);
              const secondOutcome = lifecycle.finish(second);
              return {
                same: firstOutcome === secondOutcome,
                outcome: secondOutcome.transport_outcome
              };
            }

            console.log(JSON.stringify({
              upstreamFirst: race("upstream_error", "downstream_close"),
              downstreamFirst: race("downstream_close", "upstream_error"),
              uploadFirst: incompleteUploadRace("request_abort", "upstream_error"),
              connectFirst: incompleteUploadRace("upstream_error", "request_abort")
            }));
        """)

        self.assertEqual(result["upstreamFirst"], {
            "emissions": 1,
            "same": True,
            "outcome": "upstream_read_failed",
        })
        self.assertEqual(result["downstreamFirst"], {
            "emissions": 1,
            "same": True,
            "outcome": "downstream_closed",
        })
        self.assertEqual(result["uploadFirst"], {
            "same": True,
            "outcome": "request_upload_aborted",
        })
        self.assertEqual(result["connectFirst"], {
            "same": True,
            "outcome": "upstream_request_failed",
        })

    def test_request_adapter_counts_upload_and_contains_abort_races(self) -> None:
        result = run_lifecycle_script("""
            import { EventEmitter } from "node:events";
            import { attachRequestRuntime } from "./node-transport-adapter.mjs";
            import { createTransportLifecycle } from "./transport-lifecycle.mjs";

            function makeRequest() {
              const request = new EventEmitter();
              request.complete = false;
              return request;
            }

            let abortedOutcome;
            let abortCleanup = 0;
            const abortedRequest = makeRequest();
            const abortedLifecycle = createTransportLifecycle({
              traceMetadata: {}, method: "POST", path: "/responses",
              now: () => 10,
              onFinish: (outcome) => { abortedOutcome = outcome; }
            });
            attachRequestRuntime({
              request: abortedRequest,
              lifecycle: abortedLifecycle,
              cancelUpstream: () => { abortCleanup += 1; }
            });
            abortedRequest.emit("data", Buffer.alloc(7));
            abortedRequest.emit("data", Buffer.alloc(5));
            abortedRequest.emit("aborted");
            abortedRequest.emit("error", new Error("induced reset"));
            abortedRequest.emit("data", Buffer.alloc(99));
            abortedRequest.emit("close");
            const abortedListeners = abortedRequest.eventNames().reduce(
              (count, name) => count + abortedRequest.listenerCount(name), 0
            );

            let unknownOutcome;
            let unknownCleanup = 0;
            const completedRequest = makeRequest();
            const completedLifecycle = createTransportLifecycle({
              traceMetadata: {}, method: "POST", path: "/responses",
              now: () => 20,
              onFinish: (outcome) => { unknownOutcome = outcome; }
            });
            attachRequestRuntime({
              request: completedRequest,
              lifecycle: completedLifecycle,
              cancelUpstream: () => { unknownCleanup += 1; }
            });
            completedRequest.emit("data", Buffer.alloc(3));
            completedRequest.complete = true;
            completedRequest.emit("error", new Error("complete before end callback"));
            completedRequest.emit("close");
            const completedListeners = completedRequest.eventNames().reduce(
              (count, name) => count + completedRequest.listenerCount(name), 0
            );

            console.log(JSON.stringify({
              abortedOutcome, abortCleanup, abortedListeners,
              unknownOutcome, unknownCleanup, completedListeners
            }));
        """)

        self.assertEqual(result["abortedOutcome"]["transport_outcome"], "request_upload_aborted")
        self.assertEqual(result["abortedOutcome"]["transport_stage"], "request_upload")
        self.assertEqual(result["abortedOutcome"]["request_upload_bytes"], 12)
        self.assertEqual(result["abortedOutcome"]["request_upload_chunks"], 2)
        self.assertFalse(result["abortedOutcome"]["request_upload_complete"])
        self.assertEqual(result["abortCleanup"], 1)
        self.assertEqual(result["abortedListeners"], 0)
        self.assertEqual(result["unknownOutcome"]["transport_outcome"], "indeterminate")
        self.assertEqual(result["unknownOutcome"]["transport_stage"], "unknown")
        self.assertTrue(result["unknownOutcome"]["request_upload_complete"])
        self.assertEqual(result["unknownCleanup"], 1)
        self.assertEqual(result["completedListeners"], 0)


if __name__ == "__main__":
    unittest.main()
