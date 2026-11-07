import asyncio
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from fastapi import HTTPException
from starlette.requests import Request

from renderer.app import build_audio_mix_filters, build_subtitles, camera_filter, read_json_request, run, validate_request


class RendererTests(unittest.TestCase):
    def test_all_twelve_camera_presets_produce_motion_filters(self):
        movements = [
            "Pan left", "Pan right", "Tilt up", "Tilt down", "Zoom in", "Zoom out", "Dolly in", "Dolly out",
            "Tracking movement", "Orbit-style movement", "Static cinematic framing", "Auto Cinematic",
        ]
        filters = [camera_filter(movement, 12) for movement in movements]
        self.assertEqual(len(set(filters)), len(movements))
        self.assertTrue(all("zoompan=" in value for value in filters))

    def test_subtitles_never_exceed_two_lines_and_highlight_one_word(self):
        text = "This is a deliberately long subtitle which must wrap at two lines and continue without clipping any spoken words in the final render"
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "captions.ass"
            count = build_subtitles([{"sceneIndex": 0, "text": text}], [0], [5], output)
            captions = [line.split(",,")[-1] for line in output.read_text(encoding="utf-8").splitlines() if line.startswith("Dialogue:")]
        self.assertGreater(count, 1)
        self.assertTrue(all(caption.count(r"\N") <= 1 for caption in captions))
        self.assertTrue(all(caption.count(r"\c&H0000FFFF&") == 1 for caption in captions))
        self.assertTrue(all(caption.count(r"\c&H00FFFFFF&") == caption.count(r"{\c&H0000FFFF&}") + caption.count(r"{\c&H00FFFFFF&}") - 1 for caption in captions))

    def test_empty_and_punctuation_captions_are_safe(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "captions.ass"
            count = build_subtitles([
                {"sceneIndex": 0, "text": "   "},
                {"sceneIndex": 0, "text": None},
                {"sceneIndex": 0, "text": "!!! ???"},
            ], [0], [1, 1, 2], output)
            events = [line for line in output.read_text(encoding="utf-8").splitlines() if line.startswith("Dialogue:")]
        self.assertEqual(count, 2)
        self.assertTrue(all(event.split(",,")[-1].count(r"\c&H0000FFFF&") == 1 for event in events))
        self.assertTrue(all(event.split(",,")[-1].count(r"\N") <= 1 for event in events))
        self.assertEqual(events[0].split(",")[1], "0:00:02.24")

    def test_readiness_rejects_missing_music_and_bad_duration(self):
        base = {
            "project": {"durationSeconds": 60},
            "scenes": [{"durationSeconds": 60, "imageUrl": "https://studio.example/api/media/image"}],
            "speech": [{"sceneIndex": 0, "text": "A line", "audioUrl": "https://studio.example/api/media/audio"}],
            "musicUrl": "https://studio.example/api/media/music",
        }
        self.assertEqual(validate_request(base)[2], 60)
        with self.assertRaisesRegex(ValueError, "music"):
            validate_request({**base, "musicUrl": ""})
        with self.assertRaisesRegex(ValueError, "timeline"):
            validate_request({**base, "project": {"durationSeconds": 120}})
        with self.assertRaisesRegex(ValueError, "whole number"):
            validate_request({**base, "project": {"durationSeconds": float("nan")}})

    def test_manifest_size_is_enforced_even_without_content_length(self):
        async def oversized_request():
            body = b" " * (1_000_001)
            sent = False

            async def receive():
                nonlocal sent
                if sent:
                    return {"type": "http.request", "body": b"", "more_body": False}
                sent = True
                return {"type": "http.request", "body": body, "more_body": False}

            request = Request({"type": "http", "headers": []}, receive)
            await read_json_request(request)

        with self.assertRaises(HTTPException) as error:
            asyncio.run(oversized_request())
        self.assertEqual(error.exception.status_code, 413)

    @unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg is required for the audio-mix integration test")
    def test_audio_mix_keeps_music_audible_under_speech_and_limits_peaks(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "mix.wav"
            filters = build_audio_mix_filters(
                music_index=0,
                speech=[{"sceneIndex": 0}],
                speech_input_indices=[1],
                audio_durations=[1.0],
                scene_starts=[0.0],
                target_duration=8.0,
            )
            graph = ";".join(filters)
            self.assertIn("volume=0.65", graph)
            self.assertIn("afade=t=in:st=0:d=1", graph)
            self.assertIn("afade=t=out:st=6.000:d=2", graph)
            self.assertIn("alimiter=limit=0.95:level=0", graph)
            run([
                "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                "-f", "lavfi", "-i", "aevalsrc=0.03125*sin(2*PI*220*t):s=48000:d=8",
                "-f", "lavfi", "-i", "aevalsrc=0.98*sin(2*PI*880*t):s=48000:d=1",
                "-filter_complex", graph, "-map", "[aout]", "-t", "8", "-c:a", "pcm_s16le", str(output),
            ], timeout=60)
            def measure(start: float, duration: float) -> tuple[float, float]:
                result = run([
                    "ffmpeg", "-hide_banner", "-ss", str(start), "-t", str(duration), "-i", str(output),
                    "-af", "volumedetect", "-f", "null", "-",
                ], timeout=30)
                mean = re.search(r"mean_volume:\s*(-?[0-9.]+) dB", result.stderr)
                peak = re.search(r"max_volume:\s*(-?[0-9.]+) dB", result.stderr)
                self.assertIsNotNone(mean)
                self.assertIsNotNone(peak)
                return float(mean.group(1)), float(peak.group(1))

            speech_mean, speech_peak = measure(0.1, 0.8)
            music_mean, _ = measure(3.0, 1.0)
        self.assertGreater(music_mean, -42.0)
        self.assertLess(music_mean, -28.0)
        self.assertGreater(speech_mean, music_mean + 8.0)
        self.assertLessEqual(speech_peak, -0.3)


if __name__ == "__main__":
    unittest.main()