# Video Editor

A browser-based video editor that runs entirely on your local machine. Built with a Python/FastAPI backend and a plain vanilla-JS frontend — no Node.js, no build step, no cloud uploads.

![Editor layout: clip library on the left, preview top center, timeline bottom center, inspector on the right](https://placehold.co/900x400/1a1a2e/ffffff?text=Video+Editor+UI)

## Features

- **Clip library** — drag-and-drop or browse to add MP4, JPG, and PNG files
- **Timeline** — drag to reorder clips; remove clips individually
- **Trim** — per-clip start/end trim with live preview seek
- **30+ transitions** — FFmpeg xfade: dissolve, wipes, slides, radial, pixelize, zoom, and more
- **Rich captions** — per-clip text overlays with custom font, size, color, background card, and precise position/timing
- **AI captions** — one-click caption generation via Claude (Anthropic API) using the clip's visual content
- **Custom audio track** — strip native audio and replace with any MP3/WAV/AAC/FLAC file
- **Super resolution** — optional Lanczos upscale + sharpening from 720p → 1080p (pure FFmpeg, no GPU required)
- **Export** — background render with a live progress bar; download the finished MP4 when done

## Requirements

- Python 3.10+
- FFmpeg (including `ffprobe`)

## Setup

```bash
# 1. Install FFmpeg
sudo apt install -y ffmpeg          # Debian/Ubuntu
# brew install ffmpeg               # macOS

# 2. Install Python dependencies
pip3 install -r requirements.txt

# 3. Start the server
uvicorn server:app --host 0.0.0.0 --port 8765 --reload

# 4. Open the editor
open http://localhost:8765
```

## Usage

### Basic workflow

1. **Add clips** — drop MP4/JPG/PNG files onto the upload zone in the clip library, or click Browse
2. **Build timeline** — click "Add to Timeline" on any library card; drag cards to reorder
3. **Trim clips** — click a timeline clip to open the inspector; drag the Start/End sliders
4. **Set transitions** — click the pill between any two clips to choose type and duration
5. **Add captions** — in the inspector, click "+ Add Caption"; position with X%/Y% and set in/out times
6. **AI captions** — open Settings (⚙), save your Anthropic API key, then click "✦ Generate" on any caption
7. **Audio** — drop an audio file onto the Audio Track zone in the footer
8. **Export** — click "▶ Export Video"; a download link appears when rendering is complete

### Caption styling

Each caption supports:
- **Font** — any `.ttf` installed on the system (auto-detected)
- **Size** — font size in pixels
- **Color** — color picker
- **Card BG** — solid background box behind the text, with adjustable color, opacity, and padding
- **Position** — X% and Y% as percentage of the output frame
- **Timing** — In/Out seconds relative to the start of that clip

### Super resolution

Toggle "Super Resolution" in the footer to upscale the output from 1280×720 → 1920×1080 using Lanczos resampling + unsharp masking. No GPU required — render time increases roughly 2×.

## Project structure

```
video-editor/
├── server.py          # FastAPI backend — API routes, FFmpeg render pipeline
├── requirements.txt
├── static/
│   ├── index.html     # App shell, modals, transition select
│   ├── editor.js      # All frontend logic
│   └── style.css      # Dark theme
├── media/             # User-uploaded clips (gitignored)
├── thumbnails/        # Auto-generated thumbnails (gitignored)
├── uploads/           # Uploaded audio tracks (gitignored)
└── exports/           # Rendered outputs (gitignored)
```

## API overview

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/videos` | List all clips in the library |
| `POST` | `/api/upload-media` | Upload an mp4/jpg/png to the library |
| `DELETE` | `/api/media/{name}` | Remove a clip from the library |
| `GET` | `/thumbnails/{name}` | Serve (or generate) a clip thumbnail |
| `GET` | `/media/{name}` | Stream a clip for preview |
| `GET` | `/api/fonts` | List installed `.ttf` fonts |
| `GET/POST` | `/api/config` | Get/set persisted settings (API key) |
| `POST` | `/api/generate-caption` | Generate a caption with Claude vision |
| `POST` | `/api/upload-audio` | Upload an audio track |
| `POST` | `/api/export` | Start a background render; returns `job_id` |
| `GET` | `/api/export/{job_id}` | Poll render progress (0–100) and status |
| `GET` | `/exports/{filename}` | Download the finished MP4 |

## AI captions

Caption generation uses the [Anthropic Claude API](https://docs.anthropic.com/) (`claude-opus-4-6` with vision). To enable it:

1. Get an API key from [console.anthropic.com](https://console.anthropic.com)
2. Click ⚙ Settings in the editor and paste your key
3. The key is saved locally to `config.json` (gitignored) and never sent to any third party

For video clips, a frame at t=1s is extracted and sent. For image clips, the image itself is sent.

## License

MIT
