"""A call holds one Modal invocation; synthesis uses the same loaded speech.cpp process."""

import asyncio
import hmac
import json
from contextlib import asynccontextmanager, suppress

import httpx
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse


def speech_payload(text: str, voice: dict, instructions: str) -> dict:
    if not isinstance(text, str) or not text.strip() or len(text) > 4000:
        raise ValueError("Speech text must contain 1 to 4000 characters")
    # The catalog alias is not the HTTP model id; the server already holds exactly one TTS model.
    options = {key: value for key, value in voice.items() if key != "model"}
    return {**options, "input": text.strip(), "instructions": instructions.strip(), "response_format": "pcm", "stream_format": "audio"}


def create_app(token: str, voice: dict, instructions: str, transport=None) -> FastAPI:
    if not token:
        raise ValueError("MODAL_API_TOKEN must be configured")
    synthesis_lock = asyncio.Lock()

    @asynccontextmanager
    async def lifespan(app):
        async with httpx.AsyncClient(base_url="http://127.0.0.1:8080", timeout=90, transport=transport) as client:
            app.state.speech = client
            yield

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    def authorized(headers):
        return hmac.compare_digest(headers.get("authorization", ""), f"Bearer {token}")

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

        async def speak_loop():
            while True:
                item = await queue.get()
                try:
                    async with synthesis_lock:
                        payload = speech_payload(item["text"], voice, instructions)
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
                    await ws.send_json({"type": "error", "id": item["id"], "message": "音声を生成できませんでした。"})
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
                    speech_payload(data.get("text"), voice, instructions)
                    if not isinstance(data.get("id"), str) or len(data["id"]) > 80:
                        raise ValueError("Invalid id")
                    try:
                        queue.put_nowait({"id": data["id"], "text": data["text"]})
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
