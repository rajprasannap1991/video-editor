# CLAUDE.md — Video Editor Project Guide

## What this is
A browser-based video editor with a FastAPI/FFmpeg Python backend and a vanilla-JS frontend (no build step). Users drag clips into a timeline, trim them, add transitions and styled captions, overlay a custom audio track, and export a finished MP4.

## How to run

```bash
# Install system dependency
sudo apt install -y ffmpeg

# Install Python dependencies
pip3 install -r requirements.txt --break-system-packages

# Start the server (hot-reload enabled)
uvicorn server:app --host 0.0.0.0 --port 8765 --reload

# Open http://localhost:8765
```

## Directory layout

```
video-editor/
├── server.py           # FastAPI app — all API routes and FFmpeg render pipeline
├── requirements.txt
├── static/
│   ├── index.html      # Single-page app shell + modals
│   ├── editor.js       # All frontend logic (vanilla JS, no build)
│   └── style.css       # Dark-theme CSS
│
# Runtime-generated (gitignored):
├── media/              # User-uploaded mp4/jpg/png files
├── thumbnails/         # Auto-generated JPEG thumbnails (FFmpeg, 320px wide)
├── uploads/            # User-uploaded audio tracks (mp3/wav/etc.)
├── exports/            # Rendered output videos
└── config.json         # Persisted settings (Anthropic API key) — never commit
```

## Architecture

### Backend (`server.py`)
- **FastAPI** serves both the REST API (`/api/*`) and the static frontend (`/`).
- **In-memory job dict** (`jobs`) tracks background render progress keyed by a short UUID.
- **`find_media_file(name)`** — always use this to resolve clip filenames; it searches both `VIDEOS_DIR` (root) and `MEDIA_DIR` (`media/`) so user uploads and original files work uniformly.
- **`ensure_thumbnail(name)`** — lazy-generates a 320px JPEG thumbnail via FFmpeg on first request; images return themselves as their own thumbnail.
- **`_render(job_id, config)`** runs in a `threading.Thread`. Three phases:
  1. Per-clip: trim/loop + scale/pad to target resolution + drawtext captions → temp MP4s (all at 30 fps)
  2. Concatenate: xfade chain (mixed transitions) or fast `concat` demuxer (all cuts)
  3. Audio mux: `ffmpeg -map 0:v -map 1:a -shortest` if an audio file was provided

### Frontend (`editor.js`)
- All state lives in the `state` object (videos, timeline, transitions, audio, fonts, apiKeySet).
- No framework — DOM is rebuilt by `render*()` functions whenever state changes.
- Sortable.js (CDN) handles drag-to-reorder on the timeline.
- Caption objects carry all style fields (`fontsize`, `fontcolor`, `fontfile`, `box`, `boxcolor`, `boxalpha`, `boxborderw`). The `_aiPrompt` field is UI-only and stripped before the export POST.

## Known FFmpeg quirks (important)

### xfade filter
- **All clips must be normalized to the same framerate before xfade.** Use `fps=30` as the first `vf` filter in step 1, and `-r 30` on the encoder. Mismatched framerates cause exit code 234.
- **Stream label collision**: pre-label every input with `[k:v]setpts=PTS-STARTPTS[sk]` before chaining xfade. Skipping this causes "already used" errors.
- **"none" transitions inside a xfade chain** are handled as `fade` with `duration=0.001` (imperceptible one-frame blend), not by breaking the chain.
- **Valid xfade type names** are in `XFADE_TRANSITIONS`. "dissolve" is NOT valid — use "fade" for crossfade/dissolve.

### Super resolution
Implemented as Lanczos upscale + `unsharp` sharpening, all within FFmpeg. No GPU or external library required:
```
scale=1920:1080:flags=lanczos+accurate_rnd+full_chroma_int:force_original_aspect_ratio=decrease,
pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,
unsharp=5:5:1.0:5:5:0.0
```

### drawtext escaping
FFmpeg drawtext uses `:` as a delimiter inside filter strings. Escape caption text with:
```python
text.replace("\\", "\\\\").replace("'", "\\'").replace(":", "\\:")
```

### Thumbnails for user uploads
`ensure_thumbnail` calls `find_media_file` first — do NOT check `VIDEOS_DIR / name` directly, or thumbnails for files in `MEDIA_DIR` will 404.

## API key / config
- Stored in `config.json` (gitignored).
- Loaded/saved via `load_config()` / `save_config()`.
- The `GET /api/config` endpoint only returns `has_key: bool` — the actual key is never sent to the frontend.
- The Anthropic API is used only for caption generation (`POST /api/generate-caption`): sends a video frame or image to Claude's vision API and returns the generated text.

## Adding new transition types
1. Add the FFmpeg xfade name to `XFADE_TRANSITIONS` in `server.py`.
2. Add a `<option value="...">` in the transition `<select>` in `index.html`.
3. Add a short label in `TR_LABELS` in `editor.js`.
