"""Shared application settings and reference recordings, kept on a Modal Volume."""

import io
import json
import math
import uuid
import wave
from pathlib import Path

MAX_RECORDING_BYTES = 5_760_044  # 120 seconds of 24 kHz mono PCM16 WAV.
LIMITS = {
    "speed": (0.25, 4, False), "steps": (1, 64, True),
    "seed": (0, 9007199254740991, True), "seconds": (0.5, 30, False),
    "duration_scale": (0.1, 4, False), "tail_window_size": (1, 750, True),
    "tail_std_threshold": (1.1754943508222875e-38, 3.4028234663852886e38, False),
    "tail_mean_threshold": (1.1754943508222875e-38, 3.4028234663852886e38, False),
}


def validate_options(options):
    if not isinstance(options, dict):
        raise ValueError("音声設定の形式が不正です。")
    for key, value in options.items():
        if key in LIMITS:
            if value is None and key in ("seed", "seconds"):
                continue
            low, high, integer = LIMITS[key]
            if type(value) not in (int, float) or not low <= value <= high or not math.isfinite(value) or (integer and type(value) is not int):
                raise ValueError(f"{key} は {low:g}〜{high:g} の{'整数' if integer else '数値'}を指定してください。")
        elif key == "instructions":
            if not isinstance(value, str) or len(value) > 1000:
                raise ValueError("声の指示は1000文字以内で指定してください。")
        elif key == "keep_tail":
            if type(value) is not bool:
                raise ValueError("keep_tail は真偽値で指定してください。")
        elif key == "language":
            if value not in ("auto", "ja"):
                raise ValueError("言語は auto または ja を指定してください。")
        else:
            raise ValueError("対応していない音声設定です。")
    if options.get("seconds") is not None and options.get("duration_scale", 1) != 1:
        raise ValueError("秒数を固定するときは、長さの倍率を1にしてください。")
    return dict(options)


def validate_recording(data):
    if not 44 < len(data) <= MAX_RECORDING_BYTES:
        raise ValueError("参照音声は0.5〜120秒の音声を指定してください。")
    try:
        with wave.open(io.BytesIO(data)) as recording:
            frames = recording.getnframes()
            if recording.getnchannels() != 1 or recording.getsampwidth() != 2 or recording.getframerate() != 24000:
                raise ValueError("参照音声は24 kHz・モノラル・16 bitのWAVが必要です。")
            duration = frames / 24000
            if not 0.5 <= duration <= 120 or len(recording.readframes(frames)) != frames * 2:
                raise ValueError("参照音声の長さ、またはデータが不正です。")
            return duration
    except (wave.Error, EOFError) as error:
        raise ValueError("WAV音声を読み込めませんでした。") from error


class VoiceSettings:
    def __init__(self, directory, voice, instructions):
        self.directory = Path(directory)
        self.defaults = {
            "speed": 1, "steps": 4, "seed": None, "seconds": None,
            "duration_scale": 1, "instructions": instructions.strip(), "language": "auto",
            "keep_tail": False, "tail_window_size": 20, "tail_std_threshold": 0.05, "tail_mean_threshold": 0.1,
            **{k: v for k, v in voice.items() if k not in ("model", "voice")},
        }

    def read(self):
        try:
            return json.loads((self.directory / "settings.json").read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {"revision": "initial", "options": dict(self.defaults), "reference_id": "", "references": []}

    def write(self, state):
        self.directory.mkdir(parents=True, exist_ok=True)
        state["revision"] = uuid.uuid4().hex
        temporary = self.directory / "settings.tmp"
        temporary.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
        temporary.replace(self.directory / "settings.json")

    def recording(self, state, reference_id):
        if not isinstance(reference_id, str) or not any(item["id"] == reference_id for item in state["references"]):
            raise ValueError("参照音声が見つかりません。設定を読み直してください。")
        return self.directory / f"{reference_id}.wav"
