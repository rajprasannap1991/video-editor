import os
import uuid
import json
import base64
import threading
import subprocess
import tempfile
import shutil
from pathlib import Path
from typing import Optional

import anthropic
from fastapi import FastAPI, UploadFile, File, HTTPException, Body
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

BASE = Path(__file__).parent
VIDEOS_DIR = BASE          # original vid*.mp4 files live here
MEDIA_DIR = BASE / "media" # user-uploaded files go here
THUMBNAILS_DIR = BASE / "thumbnails"
UPLOADS_DIR = BASE / "uploads"
EXPORTS_DIR = BASE / "exports"

VIDEO_EXTS = {".mp4"}
IMAGE_EXTS = {".jpg", ".jpeg", ".png"}
MEDIA_EXTS = VIDEO_EXTS | IMAGE_EXTS

CONFIG_FILE = BASE / "config.json"

for d in (MEDIA_DIR, THUMBNAILS_DIR, UPLOADS_DIR, EXPORTS_DIR):
    d.mkdir(exist_ok=True)


def load_config() -> dict:
    if CONFIG_FILE.exists():
        try:
            return json.loads(CONFIG_FILE.read_text())
        except Exception:
            pass
    return {}


def save_config(data: dict):
    CONFIG_FILE.write_text(json.dumps(data))


def find_media_file(name: str) -> Path | None:
    """Look up a media file in VIDEOS_DIR then MEDIA_DIR."""
    for d in (VIDEOS_DIR, MEDIA_DIR):
        p = d / name
        if p.exists() and p.suffix.lower() in MEDIA_EXTS:
            return p
    return None

app = FastAPI()

# In-memory job tracking
jobs: dict[str, dict] = {}


# ── helpers ──────────────────────────────────────────────────────────────────

def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(cmd, check=True, capture_output=True, **kw)
    except subprocess.CalledProcessError as e:
        stderr = e.stderr.decode(errors="replace") if e.stderr else ""
        raise RuntimeError(f"FFmpeg error (exit {e.returncode}): {stderr[-1000:]}") from None


def video_duration(path: Path) -> float:
    r = run([
        "ffprobe", "-v", "quiet", "-print_format", "json",
        "-show_streams", str(path)
    ])
    data = json.loads(r.stdout)
    for s in data.get("streams", []):
        if s.get("codec_type") == "video":
            dur = s.get("duration")
            if dur:
                return float(dur)
    # fallback: format duration
    r2 = run([
        "ffprobe", "-v", "quiet", "-print_format", "json",
        "-show_format", str(path)
    ])
    return float(json.loads(r2.stdout)["format"]["duration"])


def ensure_thumbnail(name: str) -> Path:
    src = find_media_file(name)
    if not src:
        raise FileNotFoundError(name)
    ext = src.suffix.lower()
    if ext in IMAGE_EXTS:
        return src  # image is its own thumbnail
    thumb = THUMBNAILS_DIR / (src.stem + ".jpg")
    if not thumb.exists():
        run([
            "ffmpeg", "-y", "-ss", "1", "-i", str(src),
            "-frames:v", "1", "-q:v", "3", "-vf", "scale=320:-1",
            str(thumb)
        ])
    return thumb


# ── API routes ────────────────────────────────────────────────────────────────

@app.get("/api/videos")
def list_videos():
    media = []
    seen = set()
    # Scan original videos dir (vid*.mp4 pattern) then user media dir
    sources = list(VIDEOS_DIR.glob("vid*.mp4")) + sorted(MEDIA_DIR.iterdir())
    for f in sources:
        if f.suffix.lower() not in MEDIA_EXTS or f.name in seen:
            continue
        seen.add(f.name)
        is_image = f.suffix.lower() in IMAGE_EXTS
        try:
            dur = 5.0 if is_image else video_duration(f)
        except Exception:
            dur = 0
        media.append({
            "name": f.name,
            "duration": round(dur, 3),
            "size": f.stat().st_size,
            "type": "image" if is_image else "video",
        })
    return media


@app.get("/media/{name}")
def serve_media(name: str):
    if "/" in name or "\\" in name:
        raise HTTPException(400)
    p = find_media_file(name)
    if not p:
        raise HTTPException(404)
    ext = p.suffix.lower()
    mime = "video/mp4" if ext == ".mp4" else ("image/png" if ext == ".png" else "image/jpeg")
    return FileResponse(str(p), media_type=mime)


# keep old route for backward compat
@app.get("/videos/{name}")
def serve_video(name: str):
    return serve_media(name)


@app.get("/thumbnails/{name}")
def serve_thumbnail(name: str):
    if not find_media_file(name):
        raise HTTPException(404)
    try:
        thumb = ensure_thumbnail(name)
    except Exception as e:
        raise HTTPException(500, f"Could not generate thumbnail: {e}")
    ext = thumb.suffix.lower()
    mime = "image/png" if ext == ".png" else "image/jpeg"
    return FileResponse(str(thumb), media_type=mime)


@app.post("/api/upload-media")
async def upload_media(file: UploadFile = File(...)):
    ext = Path(file.filename).suffix.lower()
    if ext not in MEDIA_EXTS:
        raise HTTPException(400, f"Unsupported format. Allowed: mp4, jpg, jpeg, png")
    safe_name = Path(file.filename).name
    dest = MEDIA_DIR / safe_name
    with open(dest, "wb") as f:
        shutil.copyfileobj(file.file, f)
    is_image = ext in IMAGE_EXTS
    dur = 5.0 if is_image else video_duration(dest)
    return {
        "name": safe_name,
        "duration": round(dur, 3),
        "size": dest.stat().st_size,
        "type": "image" if is_image else "video",
    }


@app.delete("/api/media/{name}")
def delete_media(name: str):
    if "/" in name or "\\" in name:
        raise HTTPException(400, "Invalid filename")
    p = find_media_file(name)
    if not p:
        raise HTTPException(404)
    thumb = THUMBNAILS_DIR / (p.stem + ".jpg")
    p.unlink()
    if thumb.exists():
        thumb.unlink()
    return {"deleted": name}


@app.get("/api/config")
def get_config():
    cfg = load_config()
    return {"has_key": bool(cfg.get("anthropic_api_key"))}


@app.post("/api/config")
def set_config(body: dict = Body(...)):
    cfg = load_config()
    if "anthropic_api_key" in body:
        cfg["anthropic_api_key"] = body["anthropic_api_key"]
    save_config(cfg)
    return {"ok": True}


@app.get("/api/fonts")
def list_fonts():
    font_dirs = [
        Path("/usr/share/fonts/truetype"),
        Path("/usr/local/share/fonts"),
        Path.home() / ".fonts",
    ]
    fonts = []
    seen = set()
    for d in font_dirs:
        if not d.exists():
            continue
        for f in sorted(d.rglob("*.ttf")):
            if f.stem in seen:
                continue
            seen.add(f.stem)
            fonts.append({"name": f.stem, "path": str(f)})
    return sorted(fonts, key=lambda x: x["name"].lower())


@app.post("/api/generate-caption")
async def generate_caption(body: dict = Body(...)):
    cfg = load_config()
    api_key = cfg.get("anthropic_api_key", "")
    if not api_key:
        raise HTTPException(400, "Anthropic API key not configured. Open Settings to add it.")

    clip_name = body.get("clip", "")
    prompt = body.get("prompt", "Write a short, punchy caption for this media clip.")

    src = find_media_file(clip_name)
    if not src:
        raise HTTPException(404, f"{clip_name} not found")

    is_image = src.suffix.lower() in IMAGE_EXTS

    # Get image data — either directly or by extracting a video frame
    if is_image:
        img_bytes = src.read_bytes()
        media_type = "image/png" if src.suffix.lower() == ".png" else "image/jpeg"
    else:
        frame_path = Path(tempfile.mktemp(suffix=".jpg"))
        try:
            run(["ffmpeg", "-y", "-ss", "1", "-i", str(src),
                 "-frames:v", "1", "-q:v", "2", str(frame_path)])
            img_bytes = frame_path.read_bytes()
            media_type = "image/jpeg"
        finally:
            frame_path.unlink(missing_ok=True)

    img_b64 = base64.standard_b64encode(img_bytes).decode()

    client = anthropic.Anthropic(api_key=api_key)
    message = client.messages.create(
        model="claude-opus-4-6",
        max_tokens=256,
        messages=[{
            "role": "user",
            "content": [
                {
                    "type": "image",
                    "source": {"type": "base64", "media_type": media_type, "data": img_b64},
                },
                {"type": "text", "text": prompt},
            ],
        }],
    )
    text = next((b.text for b in message.content if b.type == "text"), "")
    return {"text": text.strip()}


@app.post("/api/upload-audio")
async def upload_audio(file: UploadFile = File(...)):
    ext = Path(file.filename).suffix.lower()
    if ext not in (".mp3", ".wav", ".aac", ".ogg", ".m4a", ".flac"):
        raise HTTPException(400, "Unsupported audio format")
    dest = UPLOADS_DIR / file.filename
    with open(dest, "wb") as f:
        shutil.copyfileobj(file.file, f)
    return {"filename": file.filename}


# ── Export ────────────────────────────────────────────────────────────────────

class Caption(BaseModel):
    text: str
    x: float = 50        # percent of width
    y: float = 90        # percent of height
    from_: float = 0     # alias handled below
    to: float = 3

    model_config = {"populate_by_name": True}


class ClipConfig(BaseModel):
    file: str
    start: float = 0
    end: Optional[float] = None
    captions: list[dict] = []


# All valid FFmpeg xfade transition names
XFADE_TRANSITIONS = {
    "fade", "fadeblack", "fadewhite",
    "wipeleft", "wiperight", "wipeup", "wipedown",
    "slideleft", "slideright", "slideup", "slidedown",
    "smoothleft", "smoothright", "smoothup", "smoothdown",
    "circlecrop", "rectcrop", "circleopen", "circleclose",
    "pixelize", "radial", "zoomin", "distance",
    "diagtl", "diagtr", "diagbl", "diagbr",
    "hlslice", "hrslice", "vuslice", "vdslice",
}


class Transition(BaseModel):
    type: str = "none"
    duration: float = 1.0


class AudioConfig(BaseModel):
    file: Optional[str] = None


class ExportConfig(BaseModel):
    clips: list[ClipConfig]
    transitions: list[Transition] = []
    audio: AudioConfig = AudioConfig()
    super_resolution: bool = False


def _css_to_ffmpeg_color(hex_color: str, alpha: float = 1.0) -> str:
    """Convert CSS #rrggbb to FFmpeg 0xRRGGBB or 0xRRGGBBAA."""
    h = hex_color.lstrip("#")
    if len(h) == 6:
        if alpha < 1.0:
            return f"0x{h}{round(alpha * 255):02x}"
        return f"0x{h}"
    return hex_color  # pass through unknown formats


def _drawtext_filter(cap: dict) -> str:
    """Build an FFmpeg drawtext filter string from a caption dict."""
    text     = cap.get("text", "")
    x_pct    = float(cap.get("x", 50))
    y_pct    = float(cap.get("y", 90))
    t_from   = float(cap.get("from", cap.get("from_", 0)))
    t_to     = float(cap.get("to", 3))
    fontsize = int(cap.get("fontsize", 36))
    fontcolor = _css_to_ffmpeg_color(cap.get("fontcolor", "#ffffff"))
    fontfile = cap.get("fontfile", "")
    box       = bool(cap.get("box", False))
    boxcolor  = _css_to_ffmpeg_color(cap.get("boxcolor", "#000000"),
                                      float(cap.get("boxalpha", 0.6)))
    boxborderw = int(cap.get("boxborderw", 12))

    safe = text.replace("\\", "\\\\").replace("'", "\\'").replace(":", "\\:")
    x_expr = f"(w*{x_pct/100:.3f})"
    y_expr = f"(h*{y_pct/100:.3f})"
    enable = f"between(t,{t_from},{t_to})"

    parts = [
        f"text='{safe}'",
        f"x={x_expr}", f"y={y_expr}",
        f"fontsize={fontsize}",
        f"fontcolor={fontcolor}",
        f"enable='{enable}'",
    ]
    if fontfile:
        safe_fp = fontfile.replace("\\", "\\\\").replace("'", "\\'")
        parts.append(f"fontfile='{safe_fp}'")
    if box:
        parts.append(f"box=1:boxcolor={boxcolor}:boxborderw={boxborderw}")
    else:
        # subtle shadow for readability without box
        parts.append("shadowcolor=0x00000088:shadowx=2:shadowy=2")

    return "drawtext=" + ":".join(parts)


def _render(job_id: str, config: ExportConfig):
    job = jobs[job_id]
    try:
        tmp = Path(tempfile.mkdtemp())
        clip_paths: list[Path] = []
        n = len(config.clips)

        # ── Step 1: trim/convert + caption each clip ──────────────────────
        # Every clip is re-encoded to a common framerate and resolution so that
        # the xfade filter (step 2) receives streams with identical parameters.
        # Mismatched framerates are the most common cause of xfade exit-234 errors.
        FPS = 30
        if config.super_resolution:
            W, H = 1920, 1080
            SCALE = (
                f"scale={W}:{H}:flags=lanczos+accurate_rnd+full_chroma_int"
                f":force_original_aspect_ratio=decrease,"
                f"pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color=black,"
                f"unsharp=5:5:1.0:5:5:0.0"
            )
        else:
            W, H = 1280, 720
            SCALE = (
                f"scale={W}:{H}:force_original_aspect_ratio=decrease,"
                f"pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color=black"
            )

        for i, clip in enumerate(config.clips):
            src = find_media_file(clip.file)
            if not src:
                raise FileNotFoundError(f"{clip.file} not found")

            is_image = src.suffix.lower() in IMAGE_EXTS

            # Caption filters (each caption carries all style fields)
            caption_filters = [_drawtext_filter(cap) for cap in clip.captions]

            # fps must come before scale so pad gets correct size
            vf = ",".join([f"fps={FPS}", SCALE] + caption_filters)
            out = tmp / f"clip_{i:02d}.mp4"

            if is_image:
                duration = clip.end or 5.0
                cmd = [
                    "ffmpeg", "-y",
                    "-loop", "1", "-framerate", str(FPS), "-i", str(src),
                    "-t", str(duration),
                    "-vf", vf,
                    "-c:v", "libx264", "-preset", "fast", "-crf", "18",
                    "-r", str(FPS), "-an",
                    str(out)
                ]
            else:
                end = clip.end if clip.end is not None else video_duration(src)
                cmd = [
                    "ffmpeg", "-y",
                    "-ss", str(clip.start), "-to", str(end),
                    "-i", str(src),
                    "-vf", vf,
                    "-c:v", "libx264", "-preset", "fast", "-crf", "18",
                    "-r", str(FPS), "-an",
                    str(out)
                ]

            run(cmd)
            clip_paths.append(out)
            job["progress"] = int((i + 1) / n * 60)

        # ── Step 2: concatenate with transitions ──────────────────────────
        if len(clip_paths) == 1:
            merged = clip_paths[0]
        else:
            # Build xfade chain or simple concat
            transitions = config.transitions
            has_xfade = any(t.type not in ("none", "cut") for t in transitions)

            if has_xfade:
                # Measure the actual duration of each trimmed/encoded clip.
                # We need these to compute xfade offsets (= cumulative duration minus
                # the transition overlap up to that point).
                clip_durs: list[float] = []
                for cp in clip_paths:
                    r = run([
                        "ffprobe", "-v", "quiet", "-print_format", "json",
                        "-show_format", str(cp)
                    ])
                    clip_durs.append(float(json.loads(r.stdout)["format"]["duration"]))

                inputs = []
                for cp in clip_paths:
                    inputs += ["-i", str(cp)]

                # Pre-label every input stream with setpts=PTS-STARTPTS so that
                # xfade receives monotonically-increasing timestamps on each side.
                # Without this, stream labels collide and FFmpeg errors out.
                filter_parts: list[str] = []
                for k in range(len(clip_paths)):
                    filter_parts.append(f"[{k}:v]setpts=PTS-STARTPTS[s{k}]")

                # Build the xfade chain: [s0][s1] → [v1], [v1][s2] → [v2], …, → [vout]
                # "none"/"cut" transitions are kept in the chain as a 1ms fade so that
                # mixed cut+effect timelines don't require two separate filter graphs.
                prev_label = "[s0]"
                offset = 0.0
                for idx in range(1, len(clip_paths)):
                    t = transitions[idx - 1] if idx - 1 < len(transitions) else Transition()
                    is_cut = t.type in ("none", "cut")
                    tdur = 0.001 if is_cut else t.duration
                    xtype = "fade" if is_cut else (
                        t.type if t.type in XFADE_TRANSITIONS else "fade"
                    )
                    # offset = when the transition should START, measured from the
                    # beginning of the concatenated stream (accounting for overlaps
                    # consumed by previous transitions).
                    offset += clip_durs[idx - 1] - tdur
                    out_label = f"[v{idx}]" if idx < len(clip_paths) - 1 else "[vout]"
                    filter_parts.append(
                        f"{prev_label}[s{idx}]xfade=transition={xtype}"
                        f":duration={tdur}:offset={max(offset, 0):.4f}{out_label}"
                    )
                    prev_label = out_label

                merged = tmp / "merged.mp4"
                cmd = ["ffmpeg", "-y"] + inputs + [
                    "-filter_complex", ";".join(filter_parts),
                    "-map", "[vout]",
                    "-c:v", "libx264", "-preset", "fast", "-crf", "18",
                    "-r", str(FPS),
                    str(merged)
                ]
                run(cmd)
            else:
                # All cuts — simple lossless concat
                list_file = tmp / "clips.txt"
                list_file.write_text("\n".join(f"file '{p}'" for p in clip_paths))
                merged = tmp / "merged.mp4"
                run([
                    "ffmpeg", "-y", "-f", "concat", "-safe", "0",
                    "-i", str(list_file),
                    "-c", "copy", str(merged)
                ])

        job["progress"] = 80

        # ── Step 3: add audio ─────────────────────────────────────────────
        output = EXPORTS_DIR / f"output_{job_id}.mp4"
        audio_file = config.audio.file
        if audio_file:
            ap = UPLOADS_DIR / audio_file
            if not ap.exists():
                raise FileNotFoundError(f"Audio file {audio_file} not found")
            run([
                "ffmpeg", "-y",
                "-i", str(merged),
                "-i", str(ap),
                "-map", "0:v", "-map", "1:a",
                "-c:v", "copy", "-c:a", "aac",
                "-shortest",
                str(output)
            ])
        else:
            shutil.copy(merged, output)

        job["progress"] = 100
        job["status"] = "done"
        job["output"] = output.name

    except Exception as e:
        job["status"] = "error"
        job["error"] = str(e)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@app.post("/api/export")
def start_export(config: ExportConfig):
    if not config.clips:
        raise HTTPException(400, "No clips provided")
    job_id = str(uuid.uuid4())[:8]
    jobs[job_id] = {"status": "running", "progress": 0}
    t = threading.Thread(target=_render, args=(job_id, config), daemon=True)
    t.start()
    return {"job_id": job_id}


@app.get("/api/export/{job_id}")
def export_status(job_id: str):
    if job_id not in jobs:
        raise HTTPException(404)
    return jobs[job_id]


@app.get("/exports/{filename}")
def download_export(filename: str):
    p = EXPORTS_DIR / filename
    if not p.exists():
        raise HTTPException(404)
    return FileResponse(str(p), media_type="video/mp4", filename=filename)


# ── Static files (last, catches everything else) ──────────────────────────────
app.mount("/", StaticFiles(directory=str(BASE / "static"), html=True), name="static")
