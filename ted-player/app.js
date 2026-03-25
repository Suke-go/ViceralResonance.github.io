/**
 * Prominence Player — TED Talks with Dynamic Subtitles
 * Line-by-line karaoke-style subtitle display
 */
'use strict';

// ═══════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════

const S = {
  clips: [],
  currentClip: null,
  subtitleData: null,
  words: [],
  lines: [],       // Pre-computed subtitle lines
  condition: 'prosody',
  isPlaying: false,
  currentLineIdx: -1
};

let videoEl = null;
let animId = null;

const $ = id => document.getElementById(id);

// ═══════════════════════════════════════════════════════
// Init
// ═══════════════════════════════════════════════════════

async function init() {
  videoEl = $('video');
  await loadManifest();
  bindControls();
}

// ═══════════════════════════════════════════════════════
// Manifest + Clip Loading
// ═══════════════════════════════════════════════════════

async function loadManifest() {
  try {
    const r = await fetch('demo_data/manifest.json');
    if (!r.ok) throw new Error('manifest not found');
    S.clips = await r.json();
    renderClipGrid();
  } catch (e) {
    $('clip_grid').innerHTML = '<p style="color:#f87171;padding:20px">Failed to load clips: ' + e.message + '</p>';
  }
}

function renderClipGrid() {
  const grid = $('clip_grid');
  grid.innerHTML = '';
  S.clips.forEach(c => {
    const group = c.name.charAt(0);
    const badgeClass = group === 'H' ? 'high' : (group === 'R' ? 'high' : 'low');
    const badgeText = group === 'H' ? 'High Prominence' : (group === 'R' ? 'Rap' : 'Low Prominence');

    const card = document.createElement('div');
    card.className = 'clip-card';
    card.dataset.name = c.name;
    card.innerHTML = `
      <div class="clip-card__name">${c.name}</div>
      <div class="clip-card__speaker">${c.speaker || 'Unknown'}</div>
      <div class="clip-card__title">${c.title || ''}</div>
      <div class="clip-card__badges">
        <span class="clip-badge ${badgeClass}">${badgeText}</span>
        <span class="clip-badge">${c.duration || '--'}s</span>
        <span class="clip-badge">${c.words || '--'} words</span>
      </div>
    `;
    card.addEventListener('click', () => loadClip(c.name));
    grid.appendChild(card);
  });
}

async function loadClip(name) {
  if (!name) return;
  stopPlayback();

  document.querySelectorAll('.clip-card').forEach(c =>
    c.classList.toggle('active', c.dataset.name === name));

  try {
    const subR = await fetch(`demo_data/${name}/subtitle.json`);
    if (!subR.ok) throw new Error('subtitle.json not found');
    S.subtitleData = await subR.json();

    const promR = await fetch(`demo_data/${name}/prominence.json`);
    if (promR.ok) {
      const pd = await promR.json();
      for (const c of Object.keys(S.subtitleData.conditions)) {
        S.subtitleData.conditions[c].forEach((w, i) => {
          if (i < pd.length) w.prominence = pd[i].prominence;
        });
      }
    }

    S.currentClip = name;

    const hasVideo = await probeFile(`demo_data/${name}/video.mp4`);
    videoEl.src = hasVideo ? `demo_data/${name}/video.mp4` : `demo_data/${name}/audio.wav`;
    videoEl.preload = 'auto';

    await new Promise((res, rej) => {
      videoEl.addEventListener('canplay', res, { once: true });
      videoEl.addEventListener('error', rej, { once: true });
    });

    $('player_section').classList.add('visible');
    renderSubs(S.condition);

    const meta = S.clips.find(c => c.name === name) || {};
    $('clip_speaker').textContent = meta.speaker || '';
    $('clip_title').textContent = meta.title || '';
    $('clip_meta').textContent = `${meta.year || ''} · ${meta.duration || '--'}s · ${meta.words || '--'} words`;

  } catch (e) {
    console.error('Load failed:', e);
    $('subtitle_text').innerHTML = `<span style="color:#f87171">Error: ${e.message}</span>`;
  }
}

async function probeFile(url) {
  try { return (await fetch(url, { method: 'HEAD' })).ok; }
  catch (_) { return false; }
}

// ═══════════════════════════════════════════════════════
// Line-based Subtitle Segmentation
// ═══════════════════════════════════════════════════════

/**
 * Segment words into display lines based on timing gaps and word count.
 * A new line starts when:
 *   - There is a pause > GAP_THRESHOLD_S between words, OR
 *   - The line exceeds MAX_WORDS_PER_LINE words
 */
const GAP_THRESHOLD_S = 0.8;  // silence gap to break line
const MAX_WORDS_PER_LINE = 12;

function segmentIntoLines(words) {
  const lines = [];
  let current = [];

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    current.push({ ...w, globalIdx: i });

    const nextW = words[i + 1];
    const gap = nextW ? (nextW.start - w.end) : Infinity;
    const lineIsFull = current.length >= MAX_WORDS_PER_LINE;
    const hasGap = gap > GAP_THRESHOLD_S;

    if (lineIsFull || hasGap || i === words.length - 1) {
      lines.push({
        words: current,
        start: current[0].start,
        end: current[current.length - 1].end
      });
      current = [];
    }
  }

  return lines;
}

// ═══════════════════════════════════════════════════════
// Subtitle Rendering (Line-by-Line)
// ═══════════════════════════════════════════════════════

function renderSubs(condition) {
  if (!S.subtitleData) return;
  const ws = S.subtitleData.conditions[condition] || [];
  S.words = ws;
  S.lines = segmentIntoLines(ws);
  S.currentLineIdx = -1;

  // Show initial state — first line
  const container = $('subtitle_text');
  container.innerHTML = '<span class="sub-line-placeholder">Press ▶ to play</span>';
}

/**
 * Render the current + next line in the subtitle overlay.
 * Only 2 lines are visible at a time for readability.
 */
function renderCurrentLines(lineIdx) {
  if (lineIdx === S.currentLineIdx) return; // no change
  S.currentLineIdx = lineIdx;

  const container = $('subtitle_text');
  container.innerHTML = '';

  // Show current line and next line
  for (let li = lineIdx; li <= Math.min(lineIdx + 1, S.lines.length - 1); li++) {
    const line = S.lines[li];
    const lineEl = document.createElement('div');
    lineEl.className = 'sub-line' + (li === lineIdx ? ' sub-line--current' : ' sub-line--next');

    line.words.forEach(w => {
      const span = document.createElement('span');
      span.className = 'sub-word';
      span.dataset.idx = w.globalIdx;
      span.textContent = w.text + ' ';
      span.style.fontSize = `${w.font_size}px`;
      span.style.fontWeight = w.font_weight;
      span.title = `${w.pos || ''} p=${(w.prominence || 0).toFixed(2)}`;
      lineEl.appendChild(span);
    });

    container.appendChild(lineEl);
  }
}

// ═══════════════════════════════════════════════════════
// Playback Controls
// ═══════════════════════════════════════════════════════

function play() {
  if (!videoEl || !videoEl.src) return;
  if (videoEl.duration && videoEl.currentTime >= videoEl.duration - 0.1) videoEl.currentTime = 0;
  videoEl.play().catch(() => {});
  S.isPlaying = true;
  startSync();
}

function pause() {
  if (!videoEl) return;
  videoEl.pause();
  S.isPlaying = false;
  stopSync();
}

function stopPlayback() {
  if (!videoEl) return;
  videoEl.pause();
  videoEl.currentTime = 0;
  S.isPlaying = false;
  $('seek_bar').value = 0;
  $('time_display').textContent = '0:00 / 0:00';
  stopSync();
  S.currentLineIdx = -1;
  const container = $('subtitle_text');
  container.innerHTML = '<span class="sub-line-placeholder">Press ▶ to play</span>';
}

// ═══════════════════════════════════════════════════════
// Sync Loop (Line-based)
// ═══════════════════════════════════════════════════════

function startSync() {
  stopSync();
  const tick = () => {
    if (!videoEl) return;
    const t = videoEl.currentTime;
    const d = videoEl.duration || 1;

    $('time_display').textContent = `${fmtTime(t)} / ${fmtTime(d)}`;
    $('seek_bar').value = (t / d * 1000) | 0;

    // Find the active line (the line whose time range contains 't')
    let activeLineIdx = -1;
    for (let i = 0; i < S.lines.length; i++) {
      const line = S.lines[i];
      // Consider a line active if we're within its range or in the gap before the next line
      const nextLine = S.lines[i + 1];
      const lineEnd = nextLine ? nextLine.start : line.end + 2;
      if (t >= line.start - 0.3 && t < lineEnd) {
        activeLineIdx = i;
        break;
      }
    }

    // If before any line, show first line
    if (activeLineIdx < 0 && S.lines.length > 0 && t < S.lines[0].start) {
      activeLineIdx = 0;
    }

    if (activeLineIdx >= 0) {
      renderCurrentLines(activeLineIdx);

      // Highlight active words within displayed lines
      const container = $('subtitle_text');
      const wordEls = container.querySelectorAll('.sub-word');
      wordEls.forEach(el => {
        const idx = parseInt(el.dataset.idx);
        const w = S.words[idx];
        if (!w) return;

        const isActive = t >= w.start && t <= w.end;
        const isPast = t > w.end;
        const isProminent = (w.prominence || 0) >= 0.55;

        if (isActive) {
          el.className = 'sub-word active' + (isProminent ? ' prominent' : '');
        } else if (isPast) {
          el.className = 'sub-word past';
        } else {
          el.className = 'sub-word';
        }
      });
    }

    if (videoEl.ended) {
      S.isPlaying = false;
      stopSync();
      return;
    }
    animId = requestAnimationFrame(tick);
  };
  animId = requestAnimationFrame(tick);
}

function stopSync() {
  if (animId) { cancelAnimationFrame(animId); animId = null; }
}

function fmtTime(s) {
  return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
}

// ═══════════════════════════════════════════════════════
// Controls Binding
// ═══════════════════════════════════════════════════════

function bindControls() {
  $('btn_play').addEventListener('click', play);
  $('btn_pause').addEventListener('click', pause);
  $('btn_stop').addEventListener('click', stopPlayback);

  $('seek_bar').addEventListener('input', e => {
    if (!videoEl || !videoEl.duration) return;
    videoEl.currentTime = (parseInt(e.target.value) / 1000) * videoEl.duration;
    S.currentLineIdx = -1; // force re-render on seek
  });

  $('btn_fullscreen').addEventListener('click', () => {
    const pw = $('player_wrapper');
    if (!document.fullscreenElement) pw.requestFullscreen();
    else document.exitFullscreen();
  });

  document.querySelectorAll('.condition-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const cond = tab.dataset.cond;
      S.condition = cond;
      document.querySelectorAll('.condition-tab').forEach(t =>
        t.classList.toggle('active', t.dataset.cond === cond));
      S.currentLineIdx = -1; // force re-render
      renderSubs(cond);
    });
  });

  videoEl.addEventListener('click', () => {
    if (S.isPlaying) pause();
    else play();
  });
}

// ═══ Bootstrap ═══
document.addEventListener('DOMContentLoaded', init);
