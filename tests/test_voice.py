import asyncio
import json
import threading
import unittest
from pathlib import Path

import httpx
from fastapi.testclient import TestClient

from backend.server import create_app, speech_payload

ROOT = Path(__file__).resolve().parents[1]
VOICE = json.loads((ROOT / "config/voice.json").read_text(encoding="utf-8"))
INSTRUCTIONS = (ROOT / "prompts/voice.txt").read_text(encoding="utf-8")


class PCMStream(httpx.AsyncByteStream):
    def __init__(self, stalled=False, release=None):
        self.stalled = stalled
        self.release = release

    async def __aiter__(self):
        if self.stalled:
            await asyncio.sleep(3600)
        yield b"\x00\x00\x01"
        if self.release is not None and not await asyncio.to_thread(self.release.wait, 2):
            raise httpx.ReadTimeout("First PCM sample was buffered instead of forwarded")
        yield b"\x00\x02\x00"


class VoiceTests(unittest.TestCase):
    def setUp(self):
        self.requests = []
        self.release = threading.Event()

        async def handler(request):
            if request.url.path == "/health":
                return httpx.Response(200, json={"status": "ok"})
            self.requests.append(json.loads(request.content))
            stalled = self.requests[-1]["input"] == "待機"
            release = self.release if self.requests[-1]["input"] == "ストリーム検証" else None
            return httpx.Response(200, headers={"x-sample-rate": "48000"}, stream=PCMStream(stalled, release))

        self.client = TestClient(create_app("internal-secret", VOICE, INSTRUCTIONS, httpx.MockTransport(handler)))

    def test_payload_validation(self):
        for text in [None, "", " ", "あ" * 4001]:
            with self.assertRaises(ValueError):
                speech_payload(text, VOICE, INSTRUCTIONS)
        data = speech_payload("もしもし。", VOICE, INSTRUCTIONS)
        self.assertNotIn("model", data)
        self.assertEqual(data["steps"], 4)
        self.assertEqual(data["response_format"], "pcm")
        self.assertEqual(data["stream_format"], "audio")

    def test_health_is_authenticated_and_requires_speech_server(self):
        with self.client as client:
            self.assertEqual(client.get("/health").status_code, 401)
            self.assertEqual(client.get("/health", headers={"Authorization": "Bearer internal-secret"}).json(), {"status": "ready"})

    def test_unauthorized_socket(self):
        with self.client as client:
            with self.assertRaises(Exception):
                with client.websocket_connect("/ws") as ws:
                    ws.receive_json()

    def test_pcm_stream_and_heartbeat(self):
        with self.client as client, client.websocket_connect("/ws", headers={"Authorization": "Bearer internal-secret"}) as ws:
            self.assertEqual(ws.receive_json(), {"type": "ready"})
            ws.send_json({"type": "ping"})
            self.assertEqual(ws.receive_json(), {"type": "pong"})
            ws.send_json({"type": "speak", "id": "one", "text": "もしもし。"})
            self.assertEqual(ws.receive_json(), {"type": "audio.start", "id": "one", "sample_rate": 48000})
            self.assertEqual(ws.receive_bytes() + ws.receive_bytes(), b"\x00\x00\x01\x00\x02\x00")
            self.assertEqual(ws.receive_json(), {"type": "audio.done", "id": "one"})
            self.assertEqual(self.requests[0]["instructions"], INSTRUCTIONS.strip())
            self.assertNotIn("model", self.requests[0])

    def test_cancel_releases_synthesis_and_socket_stays_connected(self):
        with self.client as client, client.websocket_connect("/ws", headers={"Authorization": "Bearer internal-secret"}) as ws:
            ws.receive_json()
            ws.send_json({"type": "speak", "id": "first", "text": "待機"})
            self.assertEqual(ws.receive_json()["type"], "audio.start")
            ws.send_json({"type": "ping"})
            self.assertEqual(ws.receive_json(), {"type": "pong"})
            ws.send_json({"type": "cancel"})
            self.assertEqual(ws.receive_json(), {"type": "audio.cancelled"})
            ws.send_json({"type": "speak", "id": "second", "text": "次の文。"})
            self.assertEqual(ws.receive_json()["id"], "second")
            self.assertEqual(len(ws.receive_bytes() + ws.receive_bytes()), 6)
            self.assertEqual(ws.receive_json(), {"type": "audio.done", "id": "second"})

    def test_stream_forwards_first_sample_before_upstream_finishes(self):
        with self.client as client, client.websocket_connect("/ws", headers={"Authorization": "Bearer internal-secret"}) as ws:
            ws.receive_json()
            ws.send_json({"type": "speak", "id": "stream", "text": "ストリーム検証"})
            self.assertEqual(ws.receive_json()["type"], "audio.start")
            self.assertEqual(ws.receive_bytes(), b"\x00\x00")
            self.release.set()
            self.assertEqual(ws.receive_bytes(), b"\x01\x00\x02\x00")
            self.assertEqual(ws.receive_json(), {"type": "audio.done", "id": "stream"})

    def test_complete_reply_is_one_upstream_request(self):
        text = "全文をそのまま渡します。文の区切りは音声サーバーに任せます。😊" * 30
        self.assertGreater(len(text), 200)
        with self.client as client, client.websocket_connect("/ws", headers={"Authorization": "Bearer internal-secret"}) as ws:
            ws.receive_json()
            ws.send_json({"type": "speak", "id": "full", "text": text})
            self.assertEqual(ws.receive_json()["type"], "audio.start")
            self.assertEqual(ws.receive_bytes() + ws.receive_bytes(), b"\x00\x00\x01\x00\x02\x00")
            self.assertEqual(ws.receive_json(), {"type": "audio.done", "id": "full"})
            self.assertEqual(len(self.requests), 1)
            self.assertEqual(self.requests[0]["input"], text)


if __name__ == "__main__":
    unittest.main()
