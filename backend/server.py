"""A call holds one Modal invocation; synthesis uses the same loaded speech.cpp process."""

import asyncio
import hmac
import json
import uuid
from contextlib import asynccontextmanager, suppress

import httpx
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, Response

from backend.settings import MAX_RECORDING_BYTES, VoiceSettings, validate_options, validate_recording


def speech_payload(text: str, voice: dict, instructions: str, overrides=None) -> dict:
    if not isinstance(text, str) or not text.strip() or len(text) > 4000:
        raise ValueError("Speech text must contain 1 to 4000 characters")
    # The catalog alias is not the HTTP model id; the server already holds exactly one TTS model.
    options = {key: value for key, value in voice.items() if key != "model"}
    options["instructions"] = instructions.strip()
    options.update(validate_options(overrides) if overrides is not None else {})
    options = {key: value for key, value in options.items() if value is not None}
    if "seconds" in options:
        options.pop("duration_scale", None)
    if options.get("keep_tail"):
        for key in ("tail_window_size", "tail_std_threshold", "tail_mean_threshold"):
            options.pop(key, None)
    return {**options, "input": text.strip(), "response_format": "pcm", "stream_format": "audio"}


def create_app(token: str, voice: dict, instructions: str, transport=None, data_dir="/data", commit=None) -> FastAPI:
    if not token:
        raise ValueError("MODAL_API_TOKEN must be configured")
    synthesis_lock = asyncio.Lock()
    settings_lock = asyncio.Lock()
    settings = VoiceSettings(data_dir, voice, instructions)
    loaded_voices = set()

    async def load_reference(name, recording):
        response = await app.state.speech.post("/speech/voices", data={"name": name}, files={"file": ("reference.wav", recording, "audio/wav")})
        response.raise_for_status()
        loaded_voices.add(name)

    @asynccontextmanager
    async def lifespan(app):
        async with httpx.AsyncClient(base_url="http://127.0.0.1:8080", timeout=90, transport=transport) as client:
            app.state.speech = client
            yield

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    def authorized(headers):
        return hmac.compare_digest(headers.get("authorization", ""), f"Bearer {token}")

    async def read_limited(request, limit):
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > limit:
                raise ValueError("送信データが大きすぎます。")
        return bytes(body)

    async def persist(state):
        settings.write(state)
        if commit:
            await asyncio.to_thread(commit)

    def view(state):
        return {**state, "defaults": settings.defaults, "model": voice["model"]}

    @app.api_route("/settings", methods=["GET", "PUT"])
    @app.api_route("/references", methods=["POST"])
    @app.api_route("/references/{reference_id}", methods=["GET", "DELETE"])
    async def manage_settings(request: Request, reference_id: str = ""):
        if not authorized(request.headers):
            return JSONResponse({"error": "Unauthorized"}, status_code=401)
        try:
            body = None
            if request.method == "PUT":
                body = json.loads(await read_limited(request, 16_000))
                if not isinstance(body, dict) or set(body) != {"options", "reference_id"}:
                    raise ValueError("設定の形式が不正です。")
                validate_options(body["options"])
            elif request.method == "POST":
                name = request.query_params.get("name", "").strip()
                if not name or len(name) > 60 or any(ord(c) < 32 for c in name):
                    raise ValueError("参照音声の名前は1〜60文字で指定してください。")
                body = await read_limited(request, MAX_RECORDING_BYTES)
                duration = validate_recording(body)
            async with settings_lock:
                state = settings.read()
                if request.method == "GET":
                    if reference_id:
                        return Response(settings.recording(state, reference_id).read_bytes(), media_type="audio/wav", headers={"Cache-Control": "no-store"})
                    return JSONResponse(view(state), headers={"Cache-Control": "no-store"})
                if request.headers.get("if-match") != state["revision"]:
                    return JSONResponse({"error": "別の画面で設定が変更されました。「読み直す」で最新の状態を取得してください。"}, status_code=409)
                if request.method == "PUT":
                    if body["reference_id"] != "":
                        settings.recording(state, body["reference_id"])
                    state["options"] = {**settings.defaults, **body["options"]}
                    validate_options(state["options"])
                    state["reference_id"] = body["reference_id"]
                elif request.method == "POST":
                    if len(state["references"]) >= 32:
                        raise ValueError("参照音声は32件までです。不要な音声を削除してください。")
                    reference_id = uuid.uuid4().hex
                    settings.directory.mkdir(parents=True, exist_ok=True)
                    (settings.directory / f"{reference_id}.wav").write_bytes(body)
                    state["references"].append({"id": reference_id, "name": name, "duration": duration})
                else:
                    recording = settings.recording(state, reference_id)
                    state["references"] = [item for item in state["references"] if item["id"] != reference_id]
                    if state["reference_id"] == reference_id:
                        state["reference_id"] = ""
                await persist(state)
                if request.method == "DELETE":
                    recording.unlink(missing_ok=True)
                    if commit:
                        await asyncio.to_thread(commit)
                return JSONResponse(view(state), headers={"Cache-Control": "no-store"})
        except (ValueError, TypeError) as error:
            # JSON/option errors contain no paths, credentials, or upstream diagnostics.
            return JSONResponse({"error": str(error) if isinstance(error, ValueError) and not isinstance(error, json.JSONDecodeError) else "設定の形式が不正です。"}, status_code=400)
        except OSError:
            return JSONResponse({"error": "保存データを読み書きできませんでした。時間をおいて読み直してください。"}, status_code=503)

    @app.get("/health")
    async def health(request: Request):
        if not authorized(request.headers):
            return JSONResponse({"error": "Unauthorized"}, status_code=401)
        try:
            result = await app.state.speech.get("/health")
            result.raise_for_status()
            return {"status": "ready"}
        except httpx.HTTPError:
            return JSONResponse({"status": "unavailable"}, status_code=503)

    @app.websocket("/ws")
    async def call(ws: WebSocket):
        if not authorized(ws.headers):
            await ws.close(code=1008)
            return
        await ws.accept()
        queue = asyncio.Queue(maxsize=16)
        snapshot = settings.read()
        snapshot_recording = settings.recording(snapshot, snapshot["reference_id"]).read_bytes() if snapshot["reference_id"] else None

        async def speak_loop():
            while True:
                item = await queue.get()
                try:
                    async with synthesis_lock:
                        payload = item["payload"]
                        if item["reference_id"]:
                            name = f"saved_{item['reference_id']}"
                            if name not in loaded_voices:
                                # shortcut: speech.cpp cannot unload voices; bound the cache until the container idles out.
                                if len(loaded_voices) >= 64:
                                    raise ValueError("音声の読み込み上限です。通話を終了し、2分ほど待ってから再接続してください。")
                                loading = asyncio.create_task(load_reference(name, item["recording"]))
                                try:
                                    await asyncio.shield(loading)
                                except asyncio.CancelledError:
                                    # Keep the cache consistent if speech is cancelled while native registration finishes.
                                    with suppress(httpx.HTTPError):
                                        await loading
                                    raise
                            payload["voice"] = name
                        async with app.state.speech.stream("POST", "/v1/audio/speech", json=payload) as response:
                            response.raise_for_status()
                            rate = int(response.headers.get("x-sample-rate", "48000"))
                            if rate not in (24000, 48000):
                                raise ValueError("Unexpected sample rate")
                            await ws.send_json({"type": "audio.start", "id": item["id"], "sample_rate": rate})
                            carry = b""
                            async for data in response.aiter_bytes():
                                data = carry + data
                                aligned = len(data) - len(data) % 2
                                if aligned:
                                    await ws.send_bytes(data[:aligned])
                                carry = data[aligned:]
                            if carry:
                                raise ValueError("Truncated PCM sample")
                            await ws.send_json({"type": "audio.done", "id": item["id"]})
                except (httpx.HTTPError, ValueError):
                    await ws.send_json({"type": "error", "id": item["id"], "message": "音声を生成できませんでした。設定値や参照音声を確認してください。"})
                finally:
                    queue.task_done()

        producer = asyncio.create_task(speak_loop())
        await ws.send_json({"type": "ready"})
        try:
            while True:
                raw = await asyncio.wait_for(ws.receive_text(), timeout=90)
                if len(raw) > 64_000:
                    await ws.close(code=1008)
                    break
                data = json.loads(raw)
                if not isinstance(data, dict):
                    raise ValueError("Invalid event")
                if data.get("type") == "ping":
                    await ws.send_json({"type": "pong"})
                elif data.get("type") == "cancel":
                    producer.cancel()
                    with suppress(asyncio.CancelledError):
                        await producer
                    while not queue.empty():
                        queue.get_nowait()
                        queue.task_done()
                    await ws.send_json({"type": "audio.cancelled"})
                    producer = asyncio.create_task(speak_loop())
                elif data.get("type") == "speak":
                    if not isinstance(data.get("id"), str) or len(data["id"]) > 80:
                        raise ValueError("Invalid id")
                    try:
                        payload = speech_payload(data.get("text"), voice, instructions, data.get("options", snapshot["options"]))
                        reference_id = data.get("reference_id", snapshot["reference_id"])
                        recording = snapshot_recording
                        if "reference_id" in data:
                            recording = settings.recording(settings.read(), reference_id).read_bytes() if reference_id != "" else None
                    except (ValueError, OSError):
                        await ws.send_json({"type": "error", "id": data["id"], "message": "音声設定または参照音声が無効です。設定を読み直してください。"})
                        continue
                    try:
                        queue.put_nowait({"id": data["id"], "payload": payload, "reference_id": reference_id, "recording": recording})
                    except asyncio.QueueFull:
                        await ws.send_json({"type": "error", "id": data["id"], "message": "音声の生成が混み合っています。"})
                else:
                    raise ValueError("Invalid event")
        except (WebSocketDisconnect, asyncio.TimeoutError):
            pass
        except (ValueError, TypeError):
            await ws.close(code=1008, reason="Invalid message")
        finally:
            producer.cancel()
            with suppress(asyncio.CancelledError, WebSocketDisconnect, RuntimeError):
                await producer
            with suppress(RuntimeError):
                await ws.close()

    return app
