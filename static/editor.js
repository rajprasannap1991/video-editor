// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  videos: [],           // [{name, duration, size, type}, ...]
  fonts: [],            // [{name, path}, ...]
  timeline: [],         // [{id, file, start, end, captions:[...]}, ...]
  transitions: [],      // [{type, duration}, ...]
  selectedId: null,
  audio: null,
  previewFile: null,
  superResolution: false,
  apiKeySet: false,
};

let nextId = 1;
function mkId() { return nextId++; }

function fmt(sec) {
  if (sec == null || isNaN(sec)) return '--:--';
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

// ── DOM refs ──────────────────────────────────────────────────────────────────
const libraryEl = document.getElementById('library-cards');
const timelineEl = document.getElementById('timeline');
const inspectorEl = document.getElementById('inspector');
const previewEl = document.getElementById('preview');
const previewImgEl = document.getElementById('preview-img');
const previewPlaceholder = document.getElementById('preview-placeholder');
const headerCount = document.getElementById('header-count');
const audioDropEl = document.getElementById('audio-drop');
const audioInputEl = document.getElementById('audio-input');
const exportBtn = document.getElementById('export-btn');
const progressWrap = document.getElementById('export-progress-wrap');
const progressBar = document.getElementById('export-progress-bar');
const statusText = document.getElementById('export-status-text');
const downloadLink = document.getElementById('download-link');

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function init() {
  const [videos, fontsData, cfg] = await Promise.all([
    fetch('/api/videos').then(r => r.json()),
    fetch('/api/fonts').then(r => r.json()),
    fetch('/api/config').then(r => r.json()),
  ]);
  state.videos = videos;
  state.fonts = fontsData;
  state.apiKeySet = cfg.has_key;
  updateSettingsStatus();
  renderLibrary();
  for (const v of videos) addToTimeline(v.name, 0, v.duration, v.type);
  renderTimeline();
  renderInspector();
}

async function refreshLibrary() {
  const videos = await fetch('/api/videos').then(r => r.json());
  state.videos = videos;
  renderLibrary();
}

// ── Library ───────────────────────────────────────────────────────────────────
function renderLibrary() {
  libraryEl.innerHTML = '';
  headerCount.textContent = `${state.videos.length} clip${state.videos.length !== 1 ? 's' : ''} in library`;
  for (const v of state.videos) {
    const thumbSrc = v.type === 'image' ? `/media/${v.name}` : `/thumbnails/${v.name}`;
    const durLabel = v.type === 'image' ? `${v.duration}s (image)` : fmt(v.duration);
    const card = document.createElement('div');
    card.className = 'lib-card';
    card.dataset.name = v.name;
    card.innerHTML = `
      <img src="${thumbSrc}" alt="${v.name}" onerror="this.style.background='#333'">
      <div class="lib-card-info">
        <span class="lib-card-name">${escHtml(v.name)}</span>
        <span class="lib-card-dur">${durLabel}</span>
      </div>
      <div class="lib-card-actions">
        <button class="lib-card-add">+ Add to Timeline</button>
        <button class="lib-card-remove" title="Remove from library">✕</button>
      </div>
    `;
    card.querySelector('img').addEventListener('click', () => previewMedia(v.name, v.type));
    card.querySelector('.lib-card-add').addEventListener('click', (e) => {
      e.stopPropagation();
      addToTimeline(v.name, 0, v.duration, v.type);
      renderTimeline();
    });
    card.querySelector('.lib-card-remove').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Remove "${v.name}" from the library? This will delete the file.`)) return;
      const res = await fetch(`/api/media/${encodeURIComponent(v.name)}`, { method: 'DELETE' });
      if (res.ok) {
        state.videos = state.videos.filter(x => x.name !== v.name);
        renderLibrary();
      } else {
        alert('Failed to remove file.');
      }
    });
    libraryEl.appendChild(card);
  }
}

// ── Library upload ────────────────────────────────────────────────────────────
const libUploadZone = document.getElementById('library-upload-zone');
const libFileInput = document.getElementById('lib-file-input');

libUploadZone.addEventListener('dragover', e => { e.preventDefault(); libUploadZone.classList.add('drag-over'); });
libUploadZone.addEventListener('dragleave', () => libUploadZone.classList.remove('drag-over'));
libUploadZone.addEventListener('drop', async e => {
  e.preventDefault();
  libUploadZone.classList.remove('drag-over');
  await uploadMediaFiles([...e.dataTransfer.files]);
});
libFileInput.addEventListener('change', async () => {
  await uploadMediaFiles([...libFileInput.files]);
  libFileInput.value = '';
});

async function uploadMediaFiles(files) {
  for (const file of files) {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/api/upload-media', { method: 'POST', body: fd });
    if (res.ok) {
      const item = await res.json();
      if (!state.videos.find(v => v.name === item.name)) {
        state.videos.push(item);
      }
    } else {
      const err = await res.json().catch(() => ({}));
      alert(`Failed to upload ${file.name}: ${err.detail || res.statusText}`);
    }
  }
  renderLibrary();
}

function previewMedia(name, type = 'video', startSec = 0) {
  state.previewFile = name;
  previewPlaceholder.style.display = 'none';
  if (type === 'image') {
    previewEl.style.display = 'none';
    previewImgEl.src = `/media/${name}`;
    previewImgEl.style.display = 'block';
  } else {
    previewImgEl.style.display = 'none';
    previewEl.src = `/media/${name}#t=${startSec}`;
    previewEl.style.display = 'block';
  }
  document.querySelectorAll('.lib-card').forEach(c =>
    c.classList.toggle('active', c.dataset.name === name));
}

// keep old name working
function previewVideo(name, startSec = 0) {
  const v = state.videos.find(x => x.name === name);
  previewMedia(name, v ? v.type : 'video', startSec);
}

// ── Timeline ──────────────────────────────────────────────────────────────────
function addToTimeline(file, start, end, type = 'video') {
  const id = mkId();
  state.timeline.push({ id, file, start, end, captions: [], type });
  // add a default "none" transition before this clip (if not first)
  if (state.timeline.length > 1) {
    state.transitions.push({ type: 'none', duration: 1.0 });
  }
}

function removeFromTimeline(id) {
  const idx = state.timeline.findIndex(c => c.id === id);
  if (idx === -1) return;
  state.timeline.splice(idx, 1);
  // remove associated transition
  if (idx > 0) state.transitions.splice(idx - 1, 1);
  else if (state.transitions.length > 0) state.transitions.splice(0, 1);
  if (state.selectedId === id) state.selectedId = null;
}

function renderTimeline() {
  timelineEl.innerHTML = '';

  if (state.timeline.length === 0) {
    timelineEl.innerHTML = '<span style="color:var(--muted);font-size:13px;padding:0 12px">Add clips from the library</span>';
    return;
  }

  state.timeline.forEach((clip, i) => {
    // Transition pill before this clip (not before first)
    if (i > 0) {
      const tr = state.transitions[i - 1] || { type: 'none', duration: 1.0 };
      const pill = document.createElement('div');
      pill.className = 'tl-transition';
      pill.innerHTML = `<button class="tl-transition-btn" data-idx="${i - 1}">${trLabel(tr)}</button>`;
      pill.querySelector('button').addEventListener('click', () => openTransitionModal(i - 1));
      timelineEl.appendChild(pill);
    }

    const thumbSrc = clip.type === 'image' ? `/media/${clip.file}` : `/thumbnails/${clip.file}`;
    const trimLabel = clip.type === 'image'
      ? `${clip.end}s`
      : `${fmt(clip.start)} – ${fmt(clip.end)}`;

    const card = document.createElement('div');
    card.className = 'tl-clip' + (clip.id === state.selectedId ? ' selected' : '');
    card.dataset.id = clip.id;
    card.innerHTML = `
      <button class="tl-clip-remove" title="Remove">✕</button>
      <img src="${thumbSrc}" alt="${clip.file}" onerror="this.style.background='#222'">
      <div class="tl-clip-label">${escHtml(clip.file)}</div>
      <div class="tl-clip-trim">${trimLabel}</div>
    `;
    card.querySelector('.tl-clip-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      removeFromTimeline(clip.id);
      renderTimeline();
      renderInspector();
    });
    card.addEventListener('click', () => {
      state.selectedId = clip.id;
      previewMedia(clip.file, clip.type, clip.start);
      renderTimeline();
      renderInspector();
    });
    timelineEl.appendChild(card);
  });

  // Make sortable
  if (window.Sortable) {
    Sortable.create(timelineEl, {
      animation: 150,
      filter: '.tl-transition',
      onEnd(evt) {
        // Reorder clips (skip transition nodes)
        const clipCards = [...timelineEl.querySelectorAll('.tl-clip')];
        const newOrder = clipCards.map(c => parseInt(c.dataset.id));
        const oldTimeline = [...state.timeline];
        state.timeline = newOrder.map(id => oldTimeline.find(c => c.id === id)).filter(Boolean);
        renderTimeline();
      }
    });
  }
}

const TR_LABELS = {
  none: '— cut —', fade: 'dissolve', fadeblack: 'fade▪black',
  fadewhite: 'fade▪white', wipeleft: 'wipe←', wiperight: 'wipe→',
  wipeup: 'wipe↑', wipedown: 'wipe↓', slideleft: 'slide←',
  slideright: 'slide→', slideup: 'slide↑', slidedown: 'slide↓',
  smoothleft: 'smooth←', smoothright: 'smooth→', smoothup: 'smooth↑',
  smoothdown: 'smooth↓', circleopen: 'circle⊕', circleclose: 'circle⊖',
  circlecrop: 'circle✂', rectcrop: 'rect✂', pixelize: 'pixelize',
  radial: 'radial', zoomin: 'zoom▲', distance: 'distance',
  diagtl: 'diag↖', diagtr: 'diag↗', hlslice: 'h-slice', vuslice: 'v-slice',
};

function trLabel(tr) {
  if (tr.type === 'none') return '— cut —';
  const name = TR_LABELS[tr.type] || tr.type;
  return `${name} ${tr.duration}s`;
}

// ── Transition modal ──────────────────────────────────────────────────────────
let editingTrIdx = null;
const modalOverlay = document.getElementById('modal-overlay');
const modalTypeEl = document.getElementById('modal-type');
const modalDurEl = document.getElementById('modal-dur');

function openTransitionModal(idx) {
  editingTrIdx = idx;
  const tr = state.transitions[idx] || { type: 'none', duration: 1.0 };
  modalTypeEl.value = tr.type;
  modalDurEl.value = tr.duration;
  modalOverlay.classList.add('open');
}

document.getElementById('modal-cancel').addEventListener('click', () => {
  modalOverlay.classList.remove('open');
});

document.getElementById('modal-apply').addEventListener('click', () => {
  if (editingTrIdx !== null) {
    state.transitions[editingTrIdx] = {
      type: modalTypeEl.value,
      duration: parseFloat(modalDurEl.value) || 1.0
    };
  }
  modalOverlay.classList.remove('open');
  renderTimeline();
});

// ── Inspector ─────────────────────────────────────────────────────────────────
function renderInspector() {
  inspectorEl.innerHTML = '';

  const clip = state.timeline.find(c => c.id === state.selectedId);
  if (!clip) {
    inspectorEl.innerHTML = '<div class="inspector-empty">Click a timeline clip to edit</div>';
    return;
  }

  const vidMeta = state.videos.find(v => v.name === clip.file) || {};
  const maxDur = vidMeta.duration || 300;
  const isImage = clip.type === 'image';

  const trimSection = isImage ? `
    <div class="inspector-section">
      <h3>Duration — ${escHtml(clip.file)}</h3>
      <div class="time-row">
        <label class="field-label" style="min-width:64px">Display (s)</label>
        <input type="number" id="img-duration" min="0.5" step="0.5" value="${clip.end ?? 5}"
          style="background:var(--card);border:1px solid var(--border);border-radius:4px;color:var(--text);padding:4px 8px;width:80px">
      </div>
    </div>
  ` : `
    <div class="inspector-section">
      <h3>Trim — ${escHtml(clip.file)}</h3>
      <label class="field-label">Start</label>
      <div class="time-row">
        <input type="range" id="trim-start" min="0" max="${maxDur}" step="0.1" value="${clip.start}">
        <span class="time-val" id="trim-start-val">${fmt(clip.start)}</span>
      </div>
      <label class="field-label">End</label>
      <div class="time-row">
        <input type="range" id="trim-end" min="0" max="${maxDur}" step="0.1" value="${clip.end ?? maxDur}">
        <span class="time-val" id="trim-end-val">${fmt(clip.end ?? maxDur)}</span>
      </div>
      <button class="btn btn-sm" id="preview-trim-btn" style="margin-top:4px">Preview from trim start</button>
    </div>
  `;

  inspectorEl.innerHTML = `
    ${trimSection}
    <div class="inspector-section">
      <h3>Captions</h3>
      <div id="captions-list"></div>
      <button class="btn btn-sm btn-secondary" id="add-caption-btn">+ Add Caption</button>
    </div>
  `;

  if (isImage) {
    document.getElementById('img-duration').addEventListener('change', (e) => {
      clip.end = parseFloat(e.target.value) || 5;
      updateTlCard(clip);
    });
  } else {
    const trimStart = document.getElementById('trim-start');
    const trimEnd = document.getElementById('trim-end');
    const startVal = document.getElementById('trim-start-val');
    const endVal = document.getElementById('trim-end-val');

    trimStart.addEventListener('input', () => {
      const v = parseFloat(trimStart.value);
      clip.start = v;
      startVal.textContent = fmt(v);
      if (v >= clip.end) { clip.end = Math.min(v + 0.5, maxDur); trimEnd.value = clip.end; endVal.textContent = fmt(clip.end); }
      updateTlCard(clip);
    });

    trimEnd.addEventListener('input', () => {
      const v = parseFloat(trimEnd.value);
      clip.end = v;
      endVal.textContent = fmt(v);
      if (v <= clip.start) { clip.start = Math.max(v - 0.5, 0); trimStart.value = clip.start; startVal.textContent = fmt(clip.start); }
      updateTlCard(clip);
    });

    document.getElementById('preview-trim-btn').addEventListener('click', () => {
      previewVideo(clip.file, clip.start);
      previewEl.currentTime = clip.start;
    });
  }

  document.getElementById('add-caption-btn').addEventListener('click', () => {
    clip.captions.push(defaultCaption());
    renderCaptions(clip);
  });

  renderCaptions(clip);
}

function defaultCaption() {
  return {
    text: 'Caption', x: 50, y: 85, from: 0, to: 3,
    fontsize: 36, fontcolor: '#ffffff', fontfile: '',
    box: false, boxcolor: '#000000', boxalpha: 0.6, boxborderw: 12,
  };
}

function fontOptions(selected) {
  const none = `<option value="">Default font</option>`;
  const opts = state.fonts.map(f =>
    `<option value="${escHtml(f.path)}" ${f.path === selected ? 'selected' : ''}>${escHtml(f.name)}</option>`
  ).join('');
  return none + opts;
}

function renderCaptions(clip) {
  const list = document.getElementById('captions-list');
  if (!list) return;
  list.innerHTML = '';

  clip.captions.forEach((cap, i) => {
    const item = document.createElement('div');
    item.className = 'caption-item';
    item.innerHTML = `
      <button class="caption-remove">✕</button>

      <!-- Text + AI -->
      <div class="caption-row">
        <label>Text</label>
        <input type="text" class="cap-text" value="${escHtml(cap.text)}" style="flex:1">
      </div>
      <div class="cap-ai-row">
        <textarea class="cap-ai-prompt" placeholder="Prompt for Claude (e.g. 'Write a punchy caption')">${escHtml(cap._aiPrompt || '')}</textarea>
        <button class="cap-ai-btn" ${state.apiKeySet ? '' : 'title="Configure API key in Settings"'}>
          ${state.apiKeySet ? '✦ Generate' : '✦ AI (setup)'}
        </button>
      </div>

      <!-- Position + Timing -->
      <div class="cap-style-row">
        <label>X%</label><input type="number" class="cap-x" min="0" max="100" value="${cap.x}" style="width:52px">
        <label>Y%</label><input type="number" class="cap-y" min="0" max="100" value="${cap.y}" style="width:52px">
        <label>In</label><input type="number" class="cap-from" min="0" step="0.1" value="${cap.from}" style="width:52px">
        <label>Out</label><input type="number" class="cap-to" min="0" step="0.1" value="${cap.to}" style="width:52px">
      </div>

      <!-- Font -->
      <div class="cap-style-row">
        <label>Font</label>
        <select class="cap-font" style="flex:1;max-width:150px;background:var(--card);border:1px solid var(--border);border-radius:4px;color:var(--text);padding:3px 5px;font-size:12px">
          ${fontOptions(cap.fontfile || '')}
        </select>
        <label>Size</label><input type="number" class="cap-size" min="8" max="200" value="${cap.fontsize || 36}" style="width:52px">
        <label>Color</label><input type="color" class="cap-color" value="${cap.fontcolor || '#ffffff'}">
      </div>

      <!-- Background card -->
      <div class="cap-bg-row">
        <label><input type="checkbox" class="cap-checkbox cap-box" ${cap.box ? 'checked' : ''}> Card BG</label>
        <label>Color</label><input type="color" class="cap-boxcolor" value="${cap.boxcolor || '#000000'}">
        <label>Opacity</label><input type="range" class="cap-boxalpha" min="0" max="100" value="${Math.round((cap.boxalpha ?? 0.6) * 100)}">
        <label>Pad</label><input type="number" class="cap-boxborderw" min="0" max="80" value="${cap.boxborderw ?? 12}" style="width:44px">
      </div>
    `;

    // Wire up all fields to cap object
    const bind = (sel, field, parse) => {
      const el = item.querySelector(sel);
      if (!el) return;
      el.addEventListener(el.tagName === 'SELECT' || el.type === 'text' || el.type === 'textarea' ? 'change' : 'input', () => {
        cap[field] = parse ? parse(el.value) : el.value;
      });
    };

    bind('.cap-text',       'text',       null);
    bind('.cap-x',          'x',          parseFloat);
    bind('.cap-y',          'y',          parseFloat);
    bind('.cap-from',       'from',       parseFloat);
    bind('.cap-to',         'to',         parseFloat);
    bind('.cap-font',       'fontfile',   null);
    bind('.cap-size',       'fontsize',   parseInt);
    bind('.cap-color',      'fontcolor',  null);
    bind('.cap-boxcolor',   'boxcolor',   null);
    bind('.cap-boxborderw', 'boxborderw', parseInt);

    item.querySelector('.cap-box').addEventListener('change', e => { cap.box = e.target.checked; });
    item.querySelector('.cap-boxalpha').addEventListener('input', e => { cap.boxalpha = parseInt(e.target.value) / 100; });

    // Remove
    item.querySelector('.caption-remove').addEventListener('click', () => {
      clip.captions.splice(i, 1);
      renderCaptions(clip);
    });

    // AI generate
    const aiBtn = item.querySelector('.cap-ai-btn');
    const aiPromptEl = item.querySelector('.cap-ai-prompt');
    const textEl = item.querySelector('.cap-text');

    aiPromptEl.addEventListener('change', e => { cap._aiPrompt = e.target.value; });

    aiBtn.addEventListener('click', async () => {
      if (!state.apiKeySet) {
        settingsOverlay.classList.add('open');
        return;
      }
      const prompt = aiPromptEl.value.trim() || 'Write a short, punchy caption for this media clip.';
      aiBtn.disabled = true;
      aiBtn.textContent = '…';
      try {
        const res = await fetch('/api/generate-caption', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clip: clip.file, prompt }),
        });
        const data = await res.json();
        if (res.ok) {
          cap.text = data.text;
          textEl.value = data.text;
        } else {
          alert('Generation failed: ' + (data.detail || res.statusText));
        }
      } catch (e) {
        alert('Network error: ' + e.message);
      } finally {
        aiBtn.disabled = false;
        aiBtn.textContent = '✦ Generate';
      }
    });

    list.appendChild(item);
  });
}

function updateTlCard(clip) {
  const card = timelineEl.querySelector(`.tl-clip[data-id="${clip.id}"]`);
  if (!card) return;
  const trimEl = card.querySelector('.tl-clip-trim');
  if (trimEl) trimEl.textContent = clip.type === 'image'
    ? `${clip.end}s`
    : `${fmt(clip.start)} – ${fmt(clip.end)}`;
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Audio ─────────────────────────────────────────────────────────────────────
audioDropEl.addEventListener('click', () => audioInputEl.click());
audioDropEl.addEventListener('dragover', e => { e.preventDefault(); audioDropEl.style.borderColor = 'var(--accent)'; });
audioDropEl.addEventListener('dragleave', () => { audioDropEl.style.borderColor = ''; });
audioDropEl.addEventListener('drop', e => {
  e.preventDefault();
  audioDropEl.style.borderColor = '';
  const file = e.dataTransfer.files[0];
  if (file) uploadAudio(file);
});
audioInputEl.addEventListener('change', () => {
  if (audioInputEl.files[0]) uploadAudio(audioInputEl.files[0]);
});

async function uploadAudio(file) {
  audioDropEl.textContent = 'Uploading…';
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch('/api/upload-audio', { method: 'POST', body: fd });
  if (res.ok) {
    const data = await res.json();
    state.audio = data.filename;
    audioDropEl.textContent = '🎵 ' + data.filename;
    audioDropEl.classList.add('has-file');
  } else {
    audioDropEl.textContent = '❌ Upload failed';
  }
}

// ── Export ────────────────────────────────────────────────────────────────────
exportBtn.addEventListener('click', async () => {
  if (state.timeline.length === 0) { alert('Add at least one clip to the timeline.'); return; }

  exportBtn.disabled = true;
  downloadLink.style.display = 'none';
  progressWrap.style.display = 'flex';
  progressBar.style.width = '0%';
  statusText.textContent = 'Starting render…';

  const payload = {
    clips: state.timeline.map(c => ({
      file: c.file,
      start: c.start,
      end: c.end,
      captions: c.captions.map(({ _aiPrompt, ...cap }) => cap)
    })),
    transitions: state.transitions,
    audio: { file: state.audio },
    super_resolution: state.superResolution,
  };

  const res = await fetch('/api/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    statusText.textContent = 'Export failed to start.';
    exportBtn.disabled = false;
    return;
  }

  const { job_id } = await res.json();
  pollExport(job_id);
});

function pollExport(job_id) {
  const interval = setInterval(async () => {
    const data = await fetch(`/api/export/${job_id}`).then(r => r.json());
    const pct = data.progress || 0;
    progressBar.style.width = pct + '%';

    if (data.status === 'done') {
      clearInterval(interval);
      statusText.textContent = 'Done!';
      downloadLink.href = `/exports/${data.output}`;
      downloadLink.download = data.output;
      downloadLink.textContent = `Download ${data.output}`;
      downloadLink.style.display = 'inline';
      exportBtn.disabled = false;
    } else if (data.status === 'error') {
      clearInterval(interval);
      statusText.textContent = 'Error: ' + (data.error || 'unknown');
      exportBtn.disabled = false;
    } else {
      statusText.textContent = `Rendering… ${pct}%`;
    }
  }, 1500);
}

// ── Settings modal ───────────────────────────────────────────────────────────
const settingsOverlay = document.getElementById('settings-overlay');
const apiKeyInput     = document.getElementById('api-key-input');
const apiKeyStatus    = document.getElementById('api-key-status');
const apiKeyToggle    = document.getElementById('api-key-toggle');

document.getElementById('settings-btn').addEventListener('click', () => {
  settingsOverlay.classList.add('open');
});
document.getElementById('settings-cancel').addEventListener('click', () => {
  settingsOverlay.classList.remove('open');
});
apiKeyToggle.addEventListener('click', () => {
  const isPass = apiKeyInput.type === 'password';
  apiKeyInput.type = isPass ? 'text' : 'password';
  apiKeyToggle.textContent = isPass ? 'Hide' : 'Show';
});
document.getElementById('settings-save').addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();
  const res = await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ anthropic_api_key: key }),
  });
  if (res.ok) {
    state.apiKeySet = !!key;
    updateSettingsStatus();
    settingsOverlay.classList.remove('open');
    apiKeyInput.value = '';
  }
});

function updateSettingsStatus() {
  if (apiKeyStatus) {
    apiKeyStatus.textContent = state.apiKeySet ? '✓ API key saved' : 'Not configured';
    apiKeyStatus.style.color = state.apiKeySet ? 'var(--success)' : 'var(--muted)';
  }
  const btn = document.getElementById('settings-btn');
  if (btn) btn.style.borderColor = state.apiKeySet ? 'var(--success)' : '';
}

// ── Super Resolution toggle ───────────────────────────────────────────────────
document.getElementById('sr-toggle').addEventListener('change', e => {
  state.superResolution = e.target.checked;
});

// ── Start ─────────────────────────────────────────────────────────────────────
init();
