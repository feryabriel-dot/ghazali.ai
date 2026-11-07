# Local FFmpeg Renderer Smoke Test

**Result: PASS**
**Date:** 2026-11-07
**Renderer:** FFmpeg/FFprobe 6.1.1, with libass subtitles and FFmpeg Flite enabled

## Procedure

Ran the actual `renderer.render_video()` pipeline through a temporary loopback HTTP server. The manifest used two 30-second scenes, two offline Flite narration WAVs, a five-second generated sine-wave music WAV (looped by the renderer), and scene-level text for ASS karaoke captions. The loopback server was used only to satisfy the renderer's same-origin `/api/media/` URL validation. No external API or paid provider was called.

Top-level command:

```sh
python -m renderer._smoke_test
```

Synthetic fixture commands included:

```sh
ffmpeg -y -hide_banner -loglevel error -f lavfi -i "color=c=0x93443d:s=640x360:d=1" -vf "drawbox=x=120:y=65:w=400:h=230:color=0xd7bd82:t=fill,drawbox=x=300:y=65:w=20:h=230:color=0x29343b:t=fill" -frames:v 1 scene-1.png
ffmpeg -y -hide_banner -loglevel error -f lavfi -i "color=c=0x315e68:s=640x360:d=1" -vf "drawbox=x=95:y=75:w=450:h=210:color=0xc2a766:t=fill,drawbox=x=420:y=75:w=24:h=210:color=0x202a30:t=fill" -frames:v 1 scene-2.png
ffmpeg -y -hide_banner -loglevel error -f lavfi -i "flite=text='A letter arrived before sunrise.':voice=kal" -ar 48000 -ac 2 -c:a pcm_s16le speech-1.wav
ffmpeg -y -hide_banner -loglevel error -f lavfi -i "flite=text='The old story finally makes sense.':voice=kal" -ar 48000 -ac 2 -c:a pcm_s16le speech-2.wav
ffmpeg -y -hide_banner -loglevel error -f lavfi -i "sine=frequency=220:sample_rate=48000:duration=5" -af volume=0.25 -ac 2 -c:a pcm_s16le music.wav
```

The renderer's FFmpeg graph exercised `zoompan`, a 0.35-second scene crossfade, ASS `subtitles` burn-in, music fade-in/fade-out and volume control, delayed speech inputs, `amix`, and an audio limiter. The production music gain is now `0.65` (previously `0.16`); speech timing, music timing, and the 0.95 limiter ceiling are unchanged. Limiter auto-level compensation is disabled so the ceiling remains effective.

## Results

| Check | Result |
|---|---|
| Container | MP4 (`mov,mp4,m4a,3gp,3g2,mj2`) |
| Video | H.264, 1280×720, 1,800 decoded frames |
| Audio | AAC stream; full FFmpeg decode succeeded |
| Duration | 60.0 seconds, matching the renderer's minimum accepted duration |
| Black frames | 0 regions detected by `blackdetect=d=0.10:pix_th=0.10` |
| Subtitles | Burn-in succeeded; sampled lower-middle frame had 1,045 yellow and 4,266 white subtitle pixels |
| Speech/music mix before change | Speech interval mean: −21.0 dB; music-only interval mean: −51.6 dB |
| Speech/music mix after change | Speech interval mean: −21.4 dB; music-only interval mean: −39.9 dB |

With the same synthetic fixtures and sample windows, the music-only level increased by 11.7 dB while the speech interval changed by 0.4 dB. Speech remained 18.5 dB above the background bed, preserving intelligibility while making the music clearly audible. The 0.95 limiter remains in the final mix graph with auto-level compensation disabled; an automated near-full-scale speech test verifies its output stays below clipping.

Validation commands included:

```sh
ffmpeg -hide_banner -v error -i production.mp4 -f null -
ffmpeg -hide_banner -i production.mp4 -vf "blackdetect=d=0.10:pix_th=0.10" -an -f null -
ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames -of json production.mp4
```

The smoke-test driver, PNG/WAV fixtures, captions, and rendered MP4 were all stored under a `TemporaryDirectory` and removed after verification. This report is the only preserved smoke-test artifact. The audio integration test exercises the same production audio-filter helper with synthetic signals, including a near-full-scale speech input, and checks bed audibility, speech-over-music separation, fade timing, and a limited output peak below clipping.