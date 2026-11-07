import base64
import hmac
import json
import math
import os
import re
import subprocess
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

app = FastAPI(title="Ghazali FFmpeg Renderer", docs_url=None, redoc_url=None)
FADE_SECONDS = 0.35
MUSIC_GAIN = 0.65
MAX_DOWNLOAD_BYTES = 35 * 1024 * 1024
MAX_REQUEST_BYTES = 1_000_000
TRANSITIONS = {"fade", "dissolve", "wipeleft", "wiperight", "slideleft", "slideright", "smoothleft", "smoothright", "circleopen", "circleclose", "cut"}


def run(command: list[str], timeout: int = 180) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(command, capture_output=True, text=True, timeout=timeout, check=False)
    if result.returncode:
        raise RuntimeError((result.stderr or result.stdout)[-1200:])
    return result


def probe(path: Path) -> dict[str, Any]:
    result = run(["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", str(path)])
    return json.loads(result.stdout)


def safe_asset_url(url: str) -> None:
    expected = os.environ.get("ASSET_ORIGIN", "").rstrip("/")
    parsed = urllib.parse.urlparse(url)
    if not expected or f"{parsed.scheme}://{parsed.netloc}" != expected or not parsed.path.startswith("/api/media/"):
        raise ValueError("Asset URL is outside the configured studio media origin")


async def read_json_request(request: Request) -> dict[str, Any]:
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            declared_length = int(content_length)
        except ValueError as error:
            raise ValueError("Render manifest has an invalid Content-Length") from error
        if declared_length < 0:
            raise ValueError("Render manifest has an invalid Content-Length")
        if declared_length > MAX_REQUEST_BYTES:
            raise HTTPException(status_code=413, detail="Render manifest exceeds 1 MB")
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > MAX_REQUEST_BYTES:
            raise HTTPException(status_code=413, detail="Render manifest exceeds 1 MB")
    data = json.loads(body)
    if not isinstance(data, dict):
        raise ValueError("Render manifest must be a JSON object")
    return data


class RejectRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request: urllib.request.Request, response: Any, code: int, message: str, headers: Any, new_url: str) -> None:
        raise ValueError("Signed media URLs must not redirect")


def download(url: str, destination: Path) -> None:
    safe_asset_url(url)
    request = urllib.request.Request(url, headers={"User-Agent": "GhazaliRenderer/1.0"})
    try:
        opener = urllib.request.build_opener(RejectRedirects)
        with opener.open(request, timeout=45) as response:
            if response.status != 200:
                raise ValueError(f"Asset download failed with HTTP {response.status}")
            content_length = int(response.headers.get("content-length", "0"))
            if content_length > MAX_DOWNLOAD_BYTES:
                raise ValueError("Asset exceeds the 35 MB download limit")
            total = 0
            with destination.open("wb") as output:
                while chunk := response.read(1024 * 1024):
                    total += len(chunk)
                    if total > MAX_DOWNLOAD_BYTES:
                        raise ValueError("Asset exceeds the 35 MB download limit")
                    output.write(chunk)
    except (urllib.error.URLError, TimeoutError) as error:
        raise ValueError(f"Asset could not be downloaded: {error}") from error
    if not destination.exists() or destination.stat().st_size < 100:
        raise ValueError("Downloaded media is empty or truncated")


def camera_filter(movement: str, duration: float) -> str:
    frames = max(1, int(duration * 30))
    fraction = f"min(on/{frames},1)"
    movements = {
        "Pan left": ("1.035", f"(iw-iw/zoom)*(1-{fraction})", "ih/2-(ih/zoom/2)"),
        "Pan right": ("1.035", f"(iw-iw/zoom)*{fraction}", "ih/2-(ih/zoom/2)"),
        "Tilt up": ("1.035", "iw/2-(iw/zoom/2)", f"(ih-ih/zoom)*(1-{fraction})"),
        "Tilt down": ("1.035", "iw/2-(iw/zoom/2)", f"(ih-ih/zoom)*{fraction}"),
        "Zoom in": ("min(zoom+0.001,1.10)", "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"),
        "Zoom out": ("if(eq(on,1),1.08,max(zoom-0.0008,1.0))", "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"),
        "Dolly in": ("min(zoom+0.0012,1.12)", "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"),
        "Dolly out": ("if(eq(on,1),1.10,max(zoom-0.001,1.0))", "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"),
        "Tracking movement": ("min(zoom+0.0009,1.09)", f"(iw-iw/zoom)*{fraction}", "ih/2-(ih/zoom/2)"),
        "Orbit-style movement": ("min(zoom+0.0007,1.07)", f"(iw-iw/zoom)*(0.5+0.5*sin(2*PI*{fraction}))", f"(ih-ih/zoom)*(0.5+0.5*cos(2*PI*{fraction}))"),
        "Static cinematic framing": ("1.0", "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"),
        "Auto Cinematic": ("min(zoom+0.0008,1.08)", "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"),
    }
    zoom, x_axis, y_axis = movements.get(movement, ("min(zoom+0.0008,1.08)", "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"))
    return f"scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,zoompan=z='{zoom}':x='{x_axis}':y='{y_axis}':d=1:s=1280x720:fps=30,setsar=1,format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS"


def wrap_words(text: str, limit: int = 42) -> list[list[str]]:
    lines: list[list[str]] = [[]]
    length = 0
    for word in text.split():
        extra = len(word) + (1 if lines[-1] else 0)
        if length + extra > limit and lines[-1]:
            lines.append([])
            length = 0
            extra = len(word)
        lines[-1].append(word)
        length += extra
    return [line for line in lines if line]


def ass_timestamp(seconds: float) -> str:
    centiseconds = max(0, round(seconds * 100))
    hours, centiseconds = divmod(centiseconds, 360000)
    minutes, centiseconds = divmod(centiseconds, 6000)
    whole, centiseconds = divmod(centiseconds, 100)
    return f"{hours}:{minutes:02d}:{whole:02d}.{centiseconds:02d}"


def visible_word(word: str, active: bool) -> str:
    escaped = word.replace("\\", "\\\\").replace("{", "\\{").replace("}", "\\}")
    color = "&H0000FFFF&" if active else "&H00FFFFFF&"
    return f"{{\\c{color}}}{escaped}"


def mean_audio_level(path: Path) -> float:
    result = run(["ffmpeg", "-hide_banner", "-i", str(path), "-vn", "-af", "volumedetect", "-f", "null", "-"], timeout=90)
    match = re.search(r"mean_volume:\s*(-?[0-9.]+) dB", result.stderr)
    if not match:
        raise ValueError(f"Audio level could not be validated for {path.name}")
    return float(match.group(1))


def build_subtitles(segments: list[dict[str, Any]], scene_starts: list[float], audio_durations: list[float], destination: Path) -> int:
    header = "\n".join([
        "[Script Info]", "ScriptType: v4.00+", "PlayResX: 1280", "PlayResY: 720", "WrapStyle: 2", "ScaledBorderAndShadow: yes", "",
        "[V4+ Styles]", "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        "Style: Karaoke,DejaVu Sans,40,&H0000FFFF,&H00FFFFFF,&HCC000000,&H88000000,-1,0,0,0,100,100,0,0,1,3,1,2,70,70,92,1", "",
        "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]) + "\n"
    events: list[str] = []
    cursor_by_scene = [0.0] * len(scene_starts)
    for segment, audio_duration in zip(segments, audio_durations):
        scene_index = int(segment["sceneIndex"])
        if scene_index < 0 or scene_index >= len(scene_starts):
            raise ValueError("Speech segment refers to a missing scene")
        if not math.isfinite(audio_duration) or audio_duration <= 0:
            raise ValueError("Speech segment duration must be positive and finite")
        raw_text = segment.get("text")
        text = raw_text.strip() if isinstance(raw_text, str) else ""
        start = scene_starts[scene_index] + cursor_by_scene[scene_index]
        if not text:
            cursor_by_scene[scene_index] += audio_duration + 0.12
            continue
        end = start + audio_duration
        lines = wrap_words(text)
        words = [word for line in lines for word in line]
        weights = [max(1, len(word.strip(".,!?;:()\"'“”‘’"))) for word in words]
        total_weight = sum(weights)
        elapsed = 0.0
        word_index = 0
        for line_start in range(0, len(lines), 2):
            display_lines = lines[line_start:line_start + 2]
            display_words = [word for line in display_lines for word in line]
            for active_word in range(len(display_words)):
                word = words[word_index]
                word_duration = audio_duration * weights[word_index] / total_weight
                rendered_lines = []
                local_index = 0
                for line in display_lines:
                    rendered_lines.append(" ".join(visible_word(item, local_index + item_index == active_word) for item_index, item in enumerate(line)))
                    local_index += len(line)
                caption = r"\N".join(rendered_lines)
                word_end = min(end, start + elapsed + word_duration)
                events.append(f"Dialogue: 0,{ass_timestamp(start + elapsed)},{ass_timestamp(word_end)},Karaoke,,0,0,0,,{caption}")
                elapsed += word_duration
                word_index += 1
        cursor_by_scene[scene_index] += audio_duration + 0.12
    destination.write_text(header + "\n".join(events) + "\n", encoding="utf-8")
    return len(events)


def validate_request(data: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], float]:
    scenes = data.get("scenes")
    speech = data.get("speech")
    project = data.get("project") or {}
    if not isinstance(project, dict):
        raise ValueError("Project metadata must be an object")
    try:
        duration = float(project.get("durationSeconds", 0))
    except (TypeError, ValueError) as error:
        raise ValueError("Project duration must be numeric") from error
    if not isinstance(scenes, list) or not scenes or len(scenes) > 40:
        raise ValueError("Render requires 1 to 40 scenes")
    if not isinstance(speech, list) or not speech or len(speech) > 500:
        raise ValueError("Render requires 1 to 500 speech segments")
    if not math.isfinite(duration) or not duration.is_integer() or duration < 60 or duration > 1200:
        raise ValueError("Project duration must be a whole number between 60 and 1200 seconds")
    scene_durations: list[float] = []
    for scene in scenes:
        if not isinstance(scene, dict):
            raise ValueError("Every scene must be an object")
        try:
            scene_duration = float(scene.get("durationSeconds", 0))
        except (TypeError, ValueError) as error:
            raise ValueError("Scene duration must be numeric") from error
        if not math.isfinite(scene_duration) or not scene_duration.is_integer() or not 3 <= scene_duration <= 120:
            raise ValueError("Scene duration must be a whole number between 3 and 120 seconds")
        scene_durations.append(scene_duration)
    if abs(sum(scene_durations) - duration) > max(10, duration * 0.1):
        raise ValueError("Scene timeline is invalid or does not match the requested duration")
    if not isinstance(data.get("musicUrl"), str) or not data["musicUrl"]:
        raise ValueError("Required generated background music is missing")
    for scene in scenes:
        if not isinstance(scene.get("imageUrl"), str) or not scene["imageUrl"] or float(scene.get("durationSeconds", 0)) < 3:
            raise ValueError("A scene has no image or valid duration")
        if scene.get("transition", "fade") not in TRANSITIONS:
            raise ValueError("Scene uses an unsupported transition preset")
    for segment in speech:
        if (
            not isinstance(segment, dict)
            or not isinstance(segment.get("audioUrl"), str)
            or not segment["audioUrl"]
            or not isinstance(segment.get("text"), str)
            or not segment["text"].strip()
        ):
            raise ValueError("Every speech segment must include a private audio URL")
        if type(segment.get("sceneIndex")) is not int or not 0 <= segment["sceneIndex"] < len(scenes):
            raise ValueError("Speech segment refers to a missing scene")
    return scenes, speech, duration


def build_audio_mix_filters(
    music_index: int,
    speech: list[dict[str, Any]],
    speech_input_indices: list[int],
    audio_durations: list[float],
    scene_starts: list[float],
    target_duration: float,
) -> list[str]:
    fade_start = max(0, target_duration - 2)
    filters = [
        f"[{music_index}:a]aresample=48000,atrim=duration={target_duration:.3f},volume={MUSIC_GAIN},afade=t=in:st=0:d=1,afade=t=out:st={fade_start:.3f}:d=2[music]"
    ]
    mix_labels = ["music"]
    for index, (segment, input_index) in enumerate(zip(speech, speech_input_indices)):
        scene_index = int(segment["sceneIndex"])
        elapsed_in_scene = sum(audio_durations[i] + 0.12 for i in range(index) if int(speech[i]["sceneIndex"]) == scene_index)
        delay = max(0, round((scene_starts[scene_index] + elapsed_in_scene) * 1000))
        label = f"s{index}"
        filters.append(f"[{input_index}:a]aresample=48000,volume=1.0,adelay={delay}|{delay},atrim=duration={target_duration:.3f}[{label}]")
        mix_labels.append(label)
    mix_inputs = "".join(f"[{label}]" for label in mix_labels)
    filters.append(f"{mix_inputs}amix=inputs={len(mix_labels)}:duration=longest:dropout_transition=2:normalize=0,alimiter=limit=0.95:level=0[aout]")
    return filters


def render_video(data: dict[str, Any], workdir: Path) -> tuple[Path, dict[str, Any]]:
    scenes, speech, target_duration = validate_request(data)
    image_paths: list[Path] = []
    audio_paths: list[Path] = []
    scene_starts: list[float] = []
    scene_cursor = 0.0
    for index, scene in enumerate(scenes):
        path = workdir / f"scene-{index:03d}.img"
        download(str(scene["imageUrl"]), path)
        image_stream = next((stream for stream in probe(path).get("streams", []) if stream.get("codec_type") == "video"), None)
        if not image_stream or int(image_stream.get("width", 0)) < 320 or int(image_stream.get("height", 0)) < 180:
            raise ValueError(f"Scene image {index + 1} cannot be decoded")
        image_paths.append(path)
        scene_starts.append(scene_cursor - FADE_SECONDS * index)
        scene_cursor += float(scene["durationSeconds"])
    for index, segment in enumerate(speech):
        path = workdir / f"speech-{index:03d}.audio"
        download(str(segment["audioUrl"]), path)
        if not any(stream.get("codec_type") == "audio" for stream in probe(path).get("streams", [])):
            raise ValueError(f"Speech segment {index + 1} has no decodable audio stream")
        clip_duration = float(probe(path).get("format", {}).get("duration", 0))
        if clip_duration < 0.1 or mean_audio_level(path) <= -55:
            raise ValueError(f"Speech segment {index + 1} is silent or too short")
        audio_paths.append(path)
    music_path = workdir / "music.audio"
    download(str(data["musicUrl"]), music_path)
    if not any(stream.get("codec_type") == "audio" for stream in probe(music_path).get("streams", [])):
        raise ValueError("Generated music has no decodable audio stream")
    if float(probe(music_path).get("format", {}).get("duration", 0)) < 5 or mean_audio_level(music_path) <= -55:
        raise ValueError("Generated background music is silent or too short")

    audio_durations = [float(probe(path).get("format", {}).get("duration", 0)) for path in audio_paths]
    scene_audio_cursor = [0.0] * len(scenes)
    for segment, clip_duration in zip(speech, audio_durations):
        scene_index = int(segment["sceneIndex"])
        if not 0 <= scene_index < len(scenes):
            raise ValueError("Speech segment refers to a missing scene")
        scene_audio_cursor[scene_index] += clip_duration + 0.12
    for index, scene in enumerate(scenes):
        if scene_audio_cursor[index] > float(scene["durationSeconds"]) + 0.1:
            raise ValueError(f"Speech in scene {index + 1} exceeds its allocated scene duration")

    subtitles_path = workdir / "captions.ass"
    subtitle_count = build_subtitles(speech, scene_starts, audio_durations, subtitles_path)
    output_path = workdir / "production.mp4"
    command = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"]
    clip_durations: list[float] = []
    for index, (scene, path) in enumerate(zip(scenes, image_paths)):
        clip_duration = float(scene["durationSeconds"]) + (FADE_SECONDS if index > 0 else 0)
        clip_durations.append(clip_duration)
        command.extend(["-loop", "1", "-framerate", "30", "-t", f"{clip_duration:.3f}", "-i", str(path)])
    music_index = len(scenes)
    command.extend(["-stream_loop", "-1", "-i", str(music_path)])
    speech_input_indices: list[int] = []
    for path in audio_paths:
        speech_input_indices.append(music_index + 1 + len(speech_input_indices))
        command.extend(["-i", str(path)])

    filters: list[str] = []
    for index, (scene, duration) in enumerate(zip(scenes, clip_durations)):
        filters.append(f"[{index}:v]{camera_filter(str(scene.get('cameraMovement', 'Auto Cinematic')), duration)},trim=duration={duration:.3f}[v{index}]")
    video_label = "v0"
    accumulated = clip_durations[0]
    for index in range(1, len(scenes)):
        output_label = f"vx{index}"
        offset = accumulated - FADE_SECONDS
        transition = str(scenes[index].get("transition", "fade"))
        if transition in {"cut", "dissolve"}:
            transition = "fade"
        filters.append(f"[{video_label}][v{index}]xfade=transition={transition}:duration={FADE_SECONDS}:offset={offset:.3f}[{output_label}]")
        video_label = output_label
        accumulated += clip_durations[index] - FADE_SECONDS

    subtitle_filter = str(subtitles_path).replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")
    filters.append(f"[{video_label}]subtitles='{subtitle_filter}'[finalvideo]")
    filters.extend(build_audio_mix_filters(music_index, speech, speech_input_indices, audio_durations, scene_starts, target_duration))
    command.extend(["-filter_complex", ";".join(filters), "-map", "[finalvideo]", "-map", "[aout]", "-t", f"{target_duration:.3f}", "-r", "30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(output_path)])
    run(command, timeout=max(300, int(target_duration * 4)))
    if output_path.stat().st_size < 10_000:
        raise ValueError("Rendered MP4 is empty or too small")
    info = probe(output_path)
    streams = info.get("streams", [])
    has_video = any(item.get("codec_type") == "video" for item in streams)
    has_audio = any(item.get("codec_type") == "audio" for item in streams)
    format_name = str(info.get("format", {}).get("format_name", ""))
    output_duration = float(info.get("format", {}).get("duration", 0))
    if not has_video or not has_audio or "mp4" not in format_name or abs(output_duration - target_duration) > max(12, target_duration * 0.12):
        raise ValueError("Rendered file did not pass MP4 stream or duration checks")
    run(["ffmpeg", "-v", "error", "-i", str(output_path), "-f", "null", "-"], timeout=max(300, int(target_duration * 4)))
    audio_check = run(["ffmpeg", "-hide_banner", "-i", str(output_path), "-vn", "-af", "volumedetect", "-f", "null", "-"], timeout=90)
    mean = re.search(r"mean_volume:\s*(-?[0-9.]+) dB", audio_check.stderr)
    if not mean or float(mean.group(1)) <= -60:
        raise ValueError("Final audio mix is effectively silent")
    report = {"container": True, "videoDecoded": True, "audioDecoded": True, "subtitles": subtitle_count > 0, "durationSeconds": output_duration, "subtitleTiming": "estimated from decoded speech duration; provider supplied no word timestamps", "motionMode": "image-based cinematic motion"}
    return output_path, report


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ready", "renderer": "ffmpeg", "motionMode": "image-based cinematic motion"}


@app.post("/render")
async def render(request: Request, authorization: str | None = Header(default=None)) -> FileResponse:
    expected_token = os.environ.get("RENDERER_TOKEN", "")
    supplied = (authorization or "").removeprefix("Bearer ")
    if not expected_token or not hmac.compare_digest(supplied, expected_token):
        raise HTTPException(status_code=401, detail="Invalid renderer credentials")
    try:
        data = await read_json_request(request)
        temporary = tempfile.TemporaryDirectory(prefix="ghazali-")
        try:
            output, report = render_video(data, Path(temporary.name))
            encoded = base64.urlsafe_b64encode(json.dumps(report, separators=(",", ":")).encode()).decode().rstrip("=")
            return FileResponse(output, media_type="video/mp4", filename="production.mp4", headers={"x-render-validation": encoded, "cache-control": "no-store"}, background=BackgroundTask(temporary.cleanup))
        except Exception:
            temporary.cleanup()
            raise
    except (ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except subprocess.TimeoutExpired as error:
        raise HTTPException(status_code=504, detail="FFmpeg rendering exceeded its time limit") from error
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"Render failed: {str(error)[:500]}") from error