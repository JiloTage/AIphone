"""Deploy with: uv run modal deploy backend/modal_app.py"""

import json
import os
import subprocess
import time
from pathlib import Path

import modal

ROOT = Path(__file__).resolve().parents[1] if modal.is_local() else Path("/app")
SPEECH_REV = "03555100287c118b41d1b475044e5ab1e07baa8c"  # speech.cpp v0.10.1
VOICE = json.loads((ROOT / "config/voice.json").read_text(encoding="utf-8"))

image = (
    modal.Image.from_registry("nvidia/cuda:12.8.1-devel-ubuntu24.04", add_python="3.11")
    .apt_install("git", "cmake", "build-essential", "curl", "ca-certificates")
    .pip_install("fastapi==0.162.4", "httpx==0.28.1")
    .run_commands(
        "git clone https://github.com/nyosegawa/speech.cpp.git /opt/speech",
        f"git -C /opt/speech checkout {SPEECH_REV}",
        "git -C /opt/speech submodule update --init --recursive",
        "cmake -S /opt/speech -B /opt/speech/build -DCMAKE_BUILD_TYPE=Release "
        "-DGGML_CUDA=ON -DGGML_NATIVE=OFF -DCMAKE_CUDA_ARCHITECTURES=89",
        "cmake --build /opt/speech/build --target speech -j 4",
    )
    .run_commands("cmake --build /opt/speech/build --target speech-cli -j 4")
    .env({"SPEECH_MODEL_DIR": "/opt/models", "SPEECH_NO_UPDATE_CHECK": "1"})
    .run_commands(f"/opt/speech/build/speech pull {VOICE['model']}", gpu="L4")
    .add_local_dir(ROOT / "backend", "/app/backend", ignore=["__pycache__", "*.pyc"])
    .add_local_dir(ROOT / "config", "/app/config")
    .add_local_dir(ROOT / "prompts", "/app/prompts")
)

app = modal.App("voice-chat-example", image=image)


@app.cls(
    gpu=["L4", "L40S"], cpu=(1, 4), memory=8192,
    min_containers=0, max_containers=1, scaledown_window=120,
    timeout=86400,
    secrets=[modal.Secret.from_name("voice-chat-example")],
)
@modal.concurrent(max_inputs=16)
class VoiceServer:
    @modal.enter()
    def start(self):
        import httpx

        self.voice = json.loads(Path("/app/config/voice.json").read_text(encoding="utf-8"))
        self.instructions = Path("/app/prompts/voice.txt").read_text(encoding="utf-8")
        command = ["/opt/speech/build/speech", "serve", self.voice["model"],
                   "--host", "127.0.0.1", "--port", "8080", "--device", "gpu", "--threads", "4"]
        reference = Path("/app/backend/voices/reference.voice.gguf")
        # shortcut: voice=none can vary between sentences; supply a reference voice to fix the speaker.
        if reference.exists():
            command += ["--add-voice", f"reference={reference}"]
        self.process = subprocess.Popen(command)
        deadline = time.monotonic() + 240
        with httpx.Client(base_url="http://127.0.0.1:8080", timeout=120) as client:
            while time.monotonic() < deadline:
                if self.process.poll() is not None:
                    raise RuntimeError("speech.cpp exited during startup; inspect Modal logs")
                try:
                    if client.get("/health").is_success:
                        break
                except httpx.HTTPError:
                    pass
                time.sleep(0.5)
            else:
                self.process.terminate()
                raise RuntimeError("speech.cpp startup timed out")
            # Finish GPU initialization before the caller hears the connected sound.
            options = {key: value for key, value in self.voice.items() if key != "model"}
            response = client.post("/v1/audio/speech", json={
                **options, "input": "もしもし。", "instructions": self.instructions.strip(), "response_format": "wav",
            })
            response.raise_for_status()

    @modal.exit()
    def stop(self):
        if hasattr(self, "process"):
            self.process.terminate()

    @modal.asgi_app()
    def web(self):
        import sys
        sys.path.insert(0, "/app")
        from backend.server import create_app
        return create_app(os.environ["MODAL_API_TOKEN"], self.voice, self.instructions)
