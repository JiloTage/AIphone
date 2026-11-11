import io
import asyncio
import json
import tempfile
import unittest
import wave
from pathlib import Path

import httpx
from fastapi.testclient import TestClient

from backend.server import create_app, speech_payload
from backend.settings import VoiceSettings, validate_options, validate_recording
from test_voice import VOICE, INSTRUCTIONS, PCMStream

AUTH = {"Authorization": "Bearer internal-secret"}


def recording(seconds=0.5):
    out = io.BytesIO()
    with wave.open(out, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(24000)
        audio.writeframes(b"\x01\x00" * int(seconds * 24000))
    return out.getvalue()


class SettingsTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.requests = []
        self.commits = 0

        async def upstream(request):
            self.requests.append(request)
            if request.url.path == "/speech/voices":
                return httpx.Response(200, json={"held": {}})
            return httpx.Response(200, headers={"x-sample-rate": "48000"}, stream=PCMStream())

        def commit():
            self.commits += 1

        self.app = create_app("internal-secret", VOICE, INSTRUCTIONS, httpx.MockTransport(upstream), self.directory.name, commit)

    def state(self, client):
        response = client.get("/settings", headers=AUTH)
        self.assertEqual(response.status_code, 200)
        return response.json()

    def upload(self, client, revision, name="声の検証"):
        return client.post("/references", params={"name": name}, headers={**AUTH, "If-Match": revision, "Content-Type": "audio/wav"}, content=recording())

    def test_settings_validation_and_payload_do_not_accept_model_or_voice_injection(self):
        for options in [{"model": "other"}, {"voice": "someone"}, {"response_format": "wav"}, {"steps": True}, {"steps": 65}, {"steps": 1.5}, {"speed": float("nan")}, {"seed": -1}, {"seconds": 31}, {"language": "en"}, {"keep_tail": 1}, {"tail_std_threshold": 0}, {"instructions": "a" * 1001}, {"seconds": 3, "duration_scale": 2}]:
            with self.subTest(options=options), self.assertRaises(ValueError):
                validate_options(options)
        data = speech_payload("もしもし。", VOICE, INSTRUCTIONS, {"seed": None, "seconds": 3, "duration_scale": 1, "keep_tail": True, "tail_window_size": 30, "instructions": "ゆっくり"})
        self.assertNotIn("seed", data)
        self.assertNotIn("duration_scale", data)
        self.assertNotIn("tail_window_size", data)
        self.assertEqual(data["instructions"], "ゆっくり")

    def test_recording_validation_checks_format_duration_and_truncation(self):
        self.assertEqual(validate_recording(recording()), 0.5)
        for data in [b"not audio", recording(0.1), recording(121), recording()[:-2]]:
            with self.assertRaises(ValueError):
                validate_recording(data)
        invalid = bytearray(recording())
        invalid[22] = 2
        with self.assertRaises(ValueError):
            validate_recording(invalid)

    def test_persistence_across_instances_conflicts_and_deletion(self):
        with TestClient(self.app) as client:
            self.assertEqual(client.get("/settings").status_code, 401)
            initial = self.state(client)
            response = self.upload(client, initial["revision"])
            self.assertEqual(response.status_code, 200)
            state = response.json()
            reference_id = state["references"][0]["id"]
            changed = {"options": {"speed": 1.25, "seed": None}, "reference_id": reference_id}
            stale = client.put("/settings", headers={**AUTH, "If-Match": initial["revision"]}, json=changed)
            self.assertEqual(stale.status_code, 409)
            saved = client.put("/settings", headers={**AUTH, "If-Match": state["revision"]}, json=changed)
            self.assertEqual(saved.status_code, 200)
            self.assertEqual(self.commits, 2)
            recovered = VoiceSettings(self.directory.name, VOICE, INSTRUCTIONS).read()
            self.assertEqual(recovered["options"]["speed"], 1.25)
            self.assertIsNone(recovered["options"]["seed"])
            self.assertEqual(recovered["reference_id"], reference_id)
            self.assertEqual(client.get(f"/references/{reference_id}", headers=AUTH).content, recording())
            deleted = client.delete(f"/references/{reference_id}", headers={**AUTH, "If-Match": recovered["revision"]})
            self.assertEqual(deleted.status_code, 200)
            self.assertEqual(deleted.json()["reference_id"], "")
            self.assertEqual(deleted.json()["references"], [])
            self.assertFalse((Path(self.directory.name) / f"{reference_id}.wav").exists())
            self.assertEqual(client.get(f"/references/{reference_id}", headers=AUTH).status_code, 400)

    def test_saved_options_and_reference_reach_native_speech_and_are_cached(self):
        with TestClient(self.app) as client:
            state = self.upload(client, self.state(client)["revision"]).json()
            reference_id = state["references"][0]["id"]
            state = client.put("/settings", headers={**AUTH, "If-Match": state["revision"]}, json={"options": {"speed": 1.3, "steps": 6, "instructions": "優しい声"}, "reference_id": reference_id}).json()
            with client.websocket_connect("/ws", headers=AUTH) as ws:
                ws.receive_json()
                for item in ("first", "second"):
                    if item == "second":
                        removed = client.delete(f"/references/{reference_id}", headers={**AUTH, "If-Match": state["revision"]})
                        self.assertEqual(removed.status_code, 200)
                    ws.send_json({"type": "speak", "id": item, "text": "こんにちは。"})
                    self.assertEqual(ws.receive_json()["type"], "audio.start")
                    self.assertEqual(len(ws.receive_bytes() + ws.receive_bytes()), 6)
                    self.assertEqual(ws.receive_json()["type"], "audio.done")
            self.assertEqual([r.url.path for r in self.requests], ["/speech/voices", "/v1/audio/speech", "/v1/audio/speech"])
            self.assertIn(recording(), self.requests[0].content)
            payload = json.loads(self.requests[1].content)
            self.assertEqual(payload["voice"], f"saved_{reference_id}")
            self.assertEqual(payload["speed"], 1.3)
            self.assertEqual(payload["steps"], 6)
            self.assertEqual(payload["instructions"], "優しい声")
            self.assertEqual(json.loads(self.requests[2].content)["voice"], f"saved_{reference_id}")

    def test_bad_settings_do_not_call_upstream_or_overwrite_storage(self):
        with TestClient(self.app) as client:
            state = self.state(client)
            for body in [None, [], {"options": {"steps": 0}, "reference_id": ""}, {"options": {}, "reference_id": "../../secret"}]:
                response = client.put("/settings", headers={**AUTH, "If-Match": state["revision"]}, json=body)
                self.assertEqual(response.status_code, 400)
            self.assertEqual(self.state(client)["revision"], state["revision"])
            with client.websocket_connect("/ws", headers=AUTH) as ws:
                ws.receive_json()
                ws.send_json({"type": "speak", "id": "invalid", "text": "こんにちは。", "options": {"voice": "saved_other"}})
                self.assertEqual(ws.receive_json()["type"], "error")
                ws.send_json({"type": "ping"})
                self.assertEqual(ws.receive_json()["type"], "pong")
            self.assertEqual(self.requests, [])

    def test_cancelling_reference_load_does_not_register_it_twice(self):
        import threading
        started = threading.Event()
        registrations = []

        async def upstream(request):
            if request.url.path == "/speech/voices":
                registrations.append(request)
                started.set()
                await asyncio.sleep(0.05)
                return httpx.Response(200, json={})
            return httpx.Response(200, headers={"x-sample-rate": "48000"}, stream=PCMStream())

        app = create_app("internal-secret", VOICE, INSTRUCTIONS, httpx.MockTransport(upstream), self.directory.name)
        with TestClient(app) as client:
            state = self.upload(client, self.state(client)["revision"]).json()
            reference_id = state["references"][0]["id"]
            with client.websocket_connect("/ws", headers=AUTH) as ws:
                ws.receive_json()
                ws.send_json({"type": "speak", "id": "first", "text": "こんにちは。", "reference_id": reference_id})
                self.assertTrue(started.wait(2))
                ws.send_json({"type": "cancel"})
                self.assertEqual(ws.receive_json()["type"], "audio.cancelled")
                ws.send_json({"type": "speak", "id": "next", "text": "こんにちは。", "reference_id": reference_id})
                self.assertEqual(ws.receive_json()["type"], "audio.start")
                ws.receive_bytes(); ws.receive_bytes()
                self.assertEqual(ws.receive_json()["type"], "audio.done")
            self.assertEqual(len(registrations), 1)


if __name__ == "__main__":
    unittest.main()
