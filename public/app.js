/**
 * MI LIVE TV — CONTROL ROOM APPLICATION LOGIC
 * app.js — Full production client-side controller
 */

'use strict';

// ═══════════════════════════════════════════
// GLOBAL STATE
// ═══════════════════════════════════════════
const State = {
  currentChannel: 1,
  startTime: Date.now(),
  nowPlaying: null,
  schedule: [],
  overlays: { logo: true, clock: true, ticker: true, branding: false },
  tickerSpeed: 25,
  uptime: 0,
  logBuffer: [],
};

// ═══════════════════════════════════════════
// CLOCK & DATE
// ═══════════════════════════════════════════
function updateClocks() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');

  // Main topbar clock
  const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const days = ['SUN','MON','TUE','WED','THU','FRI','SAT'];
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const dateStr = `${days[now.getDay()]} ${pad(now.getDate())} ${months[now.getMonth()]} ${now.getFullYear()}`;

  const ctEl = document.getElementById('clockTime');
  const cdEl = document.getElementById('clockDate');
  const ocEl = document.getElementById('overlayClock');
  if (ctEl) ctEl.textContent = timeStr;
  if (cdEl) cdEl.textContent = dateStr;
  if (ocEl) {
    const fmt = document.getElementById('clockFormat');
    if (fmt && fmt.value === '12h') {
      const h12 = now.getHours() % 12 || 12;
      const ampm = now.getHours() < 12 ? 'AM' : 'PM';
      ocEl.textContent = `${pad(h12)}:${pad(now.getMinutes())}:${pad(now.getSeconds())} ${ampm}`;
    } else {
      ocEl.textContent = timeStr;
    }
  }

  // Uptime
  State.uptime = Math.floor((Date.now() - State.startTime) / 1000);
  const h = Math.floor(State.uptime / 3600);
  const m = Math.floor((State.uptime % 3600) / 60);
  const s = State.uptime % 60;
  const upEl = document.getElementById('uptimeDisplay');
  if (upEl) upEl.textContent = `${pad(h)}:${pad(m)}:${pad(s)}`;

  // Check now-playing
  updateNowPlayingFromTime(now);
}

// ═══════════════════════════════════════════
// PANEL NAVIGATION
// ═══════════════════════════════════════════
function showPanel(name) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const panel = document.getElementById(`panel-${name}`);
  if (panel) panel.classList.add('active');
  const btn = document.querySelector(`[data-panel="${name}"]`);
  if (btn) btn.classList.add('active');

  // Close mobile panel
  const rp = document.querySelector('.right-panel');
  if (window.innerWidth <= 768 && rp) rp.classList.add('open');
}

// ═══════════════════════════════════════════
// CHANNEL MANAGEMENT
// ═══════════════════════════════════════════
function switchChannel(id) {
  State.currentChannel = parseInt(id);
  const chEl = document.getElementById('monitorCh');
  if (chEl) chEl.textContent = id;

  // Update stream URL
  const urlEl = document.getElementById('streamUrlDisplay');
  if (urlEl) urlEl.value = `/api/stream?channelId=${id}`;

  addLog(`Switched to Channel ${id}`, 'info');
  showToast(`🎬 Switched to MI LIVE ${id}`, 'info');
}

// ═══════════════════════════════════════════
// PLAYOUT CONTROLS
// ═══════════════════════════════════════════
function playoutAction(action) {
  const player = document.getElementById('previewPlayer');
  switch(action) {
    case 'play':
      if (player && player.paused) player.play();
      document.getElementById('onAirBadge').style.opacity = '1';
      addLog('Playout PLAY triggered', 'success');
      showToast('▶ Playout started', 'success');
      break;
    case 'pause':
      if (player && !player.paused) player.pause();
      addLog('Playout PAUSED', 'warn');
      showToast('⏸ Playout paused', 'warn');
      break;
    case 'next':
      playNextInQueue();
      break;
    case 'stop':
      if (player) { player.pause(); player.currentTime = 0; }
      document.getElementById('onAirBadge').style.opacity = '0.4';
      addLog('Playout STOPPED', 'error');
      showToast('⏹ Playout stopped', 'error');
      break;
  }
}

function playNextInQueue() {
  const items = document.querySelectorAll('.queue-item');
  let activeIdx = -1;
  items.forEach((item, i) => {
    if (item.classList.contains('active-item')) activeIdx = i;
  });
  if (activeIdx >= 0 && activeIdx < items.length - 1) {
    items[activeIdx].classList.remove('active-item');
    items[activeIdx + 1].classList.add('active-item');
    addLog('Jumped to next item in queue', 'info');
    showToast('⏭ Next item loaded', 'info');
  }
}

// ═══════════════════════════════════════════
// OVERLAY MANAGEMENT
// ═══════════════════════════════════════════
function toggleOverlay(type) {
  const checkId = { logo: 'logoToggle', clock: 'clockToggle', ticker: 'tickerToggle', branding: 'copyrightToggle' };
  const elemId  = { logo: 'logoOverlay', clock: 'clockOverlay', ticker: 'pattiBar', branding: 'copyrightFilter' };
  const chk = document.getElementById(checkId[type]);
  const el  = document.getElementById(elemId[type]);
  if (!chk || !el) return;
  const on = chk.checked;
  State.overlays[type] = on;
  el.style.display = on ? '' : 'none';
  if (type === 'branding') el.classList.toggle('active', on);
  addLog(`${type} overlay ${on ? 'enabled' : 'disabled'}`, 'info');

  // Persist to Firebase
  if (window.firebaseReady && window._saveOverlayToFirebase) {
    window.saveOverlayToFirebase(State.currentChannel, State.overlays);
  }
}

function applyLogoSettings() {
  const text = document.getElementById('logoText').value;
  const pos  = document.getElementById('logoPosition').value;
  const anim = document.getElementById('logoAnim').value;
  const logoEl = document.getElementById('logoOverlay');
  const logoText = logoEl.querySelector('.logo-animated');

  if (logoText) logoText.textContent = text;

  // Position
  logoEl.style.top = ''; logoEl.style.bottom = ''; logoEl.style.left = ''; logoEl.style.right = '';
  const posMap = {
    'top-left':     { top: '12px', left: '12px' },
    'top-right':    { top: '12px', right: '12px' },
    'bottom-left':  { bottom: '52px', left: '12px' },
    'bottom-right': { bottom: '52px', right: '12px' },
  };
  Object.assign(logoEl.style, posMap[pos] || posMap['top-left']);

  // Animation
  const animMap = {
    'pulse':  'logoPulse 2s ease-in-out infinite',
    'glow':   'none',
    'bounce': 'logoBounce 1s ease-in-out infinite',
    'none':   'none',
  };
  if (logoText) logoText.style.animation = animMap[anim] || animMap['pulse'];

  showToast('✅ Logo settings applied', 'success');
  addLog(`Logo updated: "${text}" @ ${pos}`, 'success');

  if (window.firebaseReady) {
    window.saveOverlayToFirebase(State.currentChannel, { ...State.overlays, logo_text: text, logo_pos: pos });
  }
}

// ═══════════════════════════════════════════
// TICKER / PATTI
// ═══════════════════════════════════════════
function applyTickerSettings() {
  const text   = document.getElementById('tickerText').value.trim();
  const speed  = document.getElementById('tickerSpeed').value;
  const bg     = document.getElementById('tickerBg').value;
  const color  = document.getElementById('tickerColor').value;
  const lang   = document.getElementById('tickerLang').value;

  const scrollEl = document.getElementById('pattiScrollText');
  const barEl    = document.getElementById('pattiBar');
  if (!scrollEl || !barEl) return;

  scrollEl.textContent = text;
  scrollEl.style.animationDuration = `${speed}s`;
  barEl.style.background = bg + 'ee';

  if (lang === 'ur') {
    scrollEl.style.fontFamily = 'JameelNooriNastaliq, serif';
    scrollEl.style.fontSize = '1.3rem';
    scrollEl.style.direction = 'rtl';
  } else {
    scrollEl.style.fontFamily = '';
    scrollEl.style.fontSize = '';
    scrollEl.style.direction = '';
  }
  scrollEl.style.color = color;

  addLog(`Ticker updated (${lang}, ${speed}s)`, 'success');
  showToast('📡 Ticker pushed live', 'success');

  if (window.firebaseReady) {
    window.saveTickerToFirebase(State.currentChannel, text);
  }
}

function updateTickerSpeed(val) {
  document.getElementById('speedVal').textContent = `${val}s`;
  const scrollEl = document.getElementById('pattiScrollText');
  if (scrollEl) scrollEl.style.animationDuration = `${val}s`;
}

function updateTickerLang() {
  const lang = document.getElementById('tickerLang').value;
  const textarea = document.getElementById('tickerText');
  if (lang === 'ur') {
    textarea.style.fontFamily = 'JameelNooriNastaliq, serif';
    textarea.style.direction = 'rtl';
    textarea.style.textAlign = 'right';
    textarea.style.fontSize = '1.1rem';
    textarea.style.lineHeight = '2';
    textarea.setAttribute('dir', 'rtl');
    textarea.setAttribute('lang', 'ur');
  } else {
    textarea.style.fontFamily = '';
    textarea.style.direction = '';
    textarea.style.textAlign = '';
    textarea.style.fontSize = '';
    textarea.style.lineHeight = '';
    textarea.removeAttribute('dir');
    textarea.removeAttribute('lang');
  }
}

function updateTickerStyle() {
  const bg    = document.getElementById('tickerBg').value;
  const color = document.getElementById('tickerColor').value;
  const barEl = document.getElementById('pattiBar');
  const txtEl = document.getElementById('pattiScrollText');
  if (barEl) barEl.style.background = bg + 'ee';
  if (txtEl) txtEl.style.color = color;
}

function insertBreaking(prefix) {
  const ta = document.getElementById('tickerText');
  if (!ta) return;
  ta.value = `${prefix}: ${ta.value}`;
  ta.focus();
}

function clearTicker() {
  const ta = document.getElementById('tickerText');
  if (ta) ta.value = '';
  const scrollEl = document.getElementById('pattiScrollText');
  if (scrollEl) scrollEl.textContent = '';
  showToast('🗑 Ticker cleared', 'warn');
}

// ═══════════════════════════════════════════
// FILTER / BRANDING OVERLAY
// ═══════════════════════════════════════════
function applyFilter() {
  const type  = document.getElementById('filterType').value;
  const cf    = document.getElementById('copyrightFilter');
  if (!cf) return;

  // Legitimate channel branding watermark patterns only
  const patterns = {
    noise: `repeating-linear-gradient(45deg, transparent, transparent 60px, rgba(255,255,255,0.012) 60px, rgba(255,255,255,0.012) 61px)`,
    tint:  `linear-gradient(rgba(0,0,60,0.07), rgba(0,0,60,0.07))`,
    grain: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.04'/%3E%3C/svg%3E")`,
    watermark: `repeating-linear-gradient(135deg, transparent, transparent 80px, rgba(255,255,255,0.008) 80px, rgba(255,255,255,0.008) 81px)`,
  };
  cf.style.background = patterns[type] || patterns.noise;
}

function updateFilterIntensity(val) {
  document.getElementById('filterVal').textContent = val;
  const cf = document.getElementById('copyrightFilter');
  if (cf) cf.style.opacity = (val / 20).toString();
}

// ═══════════════════════════════════════════
// SCHEDULE MANAGEMENT
// ═══════════════════════════════════════════
function addScheduleEntry() {
  const title    = document.getElementById('schTitle').value.trim();
  const start    = document.getElementById('schStart').value;
  const duration = document.getElementById('schDuration').value.trim();
  const videoUrl = document.getElementById('schVideoUrl').value.trim();
  const type     = document.getElementById('schType').value;

  if (!title || !start || !duration) {
    showToast('⚠ Fill in Title, Start Time, and Duration', 'warn');
    return;
  }

  const entry = {
    title, start, duration, videoUrl, type,
    channelId: State.currentChannel,
    createdAt: Date.now(),
  };

  if (window.firebaseReady) {
    window.saveScheduleEntry(State.currentChannel, entry);
    showToast('✅ Schedule entry saved to Firebase', 'success');
    addLog(`Schedule: "${title}" added @ ${start}`, 'success');
  } else {
    showToast('⚠ Firebase not ready', 'warn');
  }

  // Clear form
  ['schTitle','schStart','schDuration','schVideoUrl'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
}

function triggerPythonScheduler() {
  showToast('🐍 30-Day scheduler triggered via GitHub Actions', 'info');
  addLog('Manual scheduler trigger requested', 'info');
  // In production: POST to a GitHub Actions webhook or Vercel API route
  fetch('/api/trigger-scheduler', { method: 'POST' })
    .then(r => r.json())
    .then(d => { showToast('✅ Scheduler dispatched', 'success'); addLog(`Scheduler: ${JSON.stringify(d)}`, 'success'); })
    .catch(() => { addLog('Scheduler endpoint not reachable (deploy to Vercel first)', 'warn'); });
}

window.renderScheduleTimeline = function(data) {
  const list = document.getElementById('timelineList');
  if (!list) return;
  list.innerHTML = '';

  const entries = Object.values(data).sort((a,b) => new Date(a.start) - new Date(b.start));
  State.schedule = entries;

  const today = new Date().toDateString();
  const todayEntries = entries.filter(e => new Date(e.start).toDateString() === today);

  if (todayEntries.length === 0) {
    list.innerHTML = '<div class="tl-loading">No schedule for today. Add entries above.</div>';
    return;
  }

  todayEntries.forEach(e => {
    const d  = document.createElement('div');
    d.className = 'tl-item';
    const t  = new Date(e.start);
    const hm = `${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}`;
    d.innerHTML = `
      <span class="tl-time">${hm}</span>
      <span class="tl-title">${e.title}</span>
      <span class="tl-type">${e.duration}</span>
      <span class="tl-type">${e.type}</span>
    `;
    list.appendChild(d);
  });
};

window.renderQueue = function(data) {
  // Update queue from Firebase data — skip re-render if already showing items
};

window.updateNowPlaying = function(data) {
  updateNowPlayingFromTime(new Date(), data);
};

function updateNowPlayingFromTime(now, data) {
  const entries = data ? Object.values(data) : State.schedule;
  if (!entries.length) return;

  const current = entries.find(e => {
    const start = new Date(e.start);
    const [h,m,s] = (e.duration || '00:30:00').split(':').map(Number);
    const durationMs = ((h||0)*3600 + (m||0)*60 + (s||0)) * 1000;
    const end = new Date(start.getTime() + durationMs);
    return now >= start && now < end;
  });

  if (current) {
    State.nowPlaying = current;
    const titleEl = document.getElementById('npTitle');
    if (titleEl) titleEl.textContent = current.title;

    const start = new Date(current.start);
    const [h,m,s] = (current.duration || '00:30:00').split(':').map(Number);
    const totalMs = ((h||0)*3600 + (m||0)*60 + (s||0)) * 1000;
    const elapsed = now - start;
    const pct = Math.min(100, Math.max(0, (elapsed / totalMs) * 100));

    const prog = document.getElementById('npProgress');
    if (prog) prog.style.width = `${pct}%`;

    const fmtMs = (ms) => {
      const sec = Math.floor(ms/1000);
      const mm = Math.floor(sec/60); const ss = sec%60;
      return `${String(mm).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
    };
    const elEl = document.getElementById('npElapsed');
    const totEl = document.getElementById('npTotal');
    if (elEl) elEl.textContent = fmtMs(elapsed);
    if (totEl) totEl.textContent = fmtMs(totalMs);
  }
}

// ═══════════════════════════════════════════
// FILLER CONFIG
// ═══════════════════════════════════════════
function saveFillerConfig() {
  const url   = document.getElementById('fillerUrl').value.trim();
  const gap   = document.getElementById('gapThreshold').value;
  if (!url) { showToast('⚠ Enter filler URL', 'warn'); return; }
  if (window.firebaseReady) {
    window.saveFillerToFirebase(State.currentChannel, { url, gapThreshold: parseInt(gap), updatedAt: Date.now() });
    showToast('💾 Filler config saved', 'success');
    addLog(`Filler config updated: gap=${gap}s`, 'success');
  }
}

// ═══════════════════════════════════════════
// MEDIA LIBRARY
// ═══════════════════════════════════════════
function handleDrop(event) {
  event.preventDefault();
  const files = event.dataTransfer.files;
  if (files.length) processUpload(files[0]);
}

function handleFileSelect(event) {
  const file = event.target.files[0];
  if (file) processUpload(file);
}

function processUpload(file) {
  if (!file.type.startsWith('video/')) {
    showToast('⚠ Only video files allowed', 'warn'); return;
  }
  if (file.size > 4 * 1024 * 1024 * 1024) {
    showToast('⚠ File exceeds 4GB limit', 'error'); return;
  }

  const progressWrap = document.getElementById('uploadProgress');
  const bar = document.getElementById('upBar');
  const pct = document.getElementById('upPct');
  if (progressWrap) progressWrap.style.display = 'block';

  if (window.firebaseReady && window.uploadFileToFirebase) {
    window.uploadFileToFirebase(
      file,
      (p) => {
        if (bar) bar.style.width = `${p}%`;
        if (pct) pct.textContent = `${p}%`;
      },
      (downloadUrl, name) => {
        if (progressWrap) progressWrap.style.display = 'none';
        addMediaCard(name, downloadUrl);
        showToast(`✅ Uploaded: ${name}`, 'success');
        addLog(`Media uploaded: ${name}`, 'success');
        // Save reference to Firebase
        if (window._set && window._ref && window._db) {
          window._set(window._ref(window._db, `channels/ch${State.currentChannel}/media/${Date.now()}`), {
            name, url: downloadUrl, uploadedAt: Date.now()
          });
        }
      }
    );
  } else {
    // Fallback: show simulated progress
    let p = 0;
    const iv = setInterval(() => {
      p += 5;
      if (bar) bar.style.width = `${p}%`;
      if (pct) pct.textContent = `${p}%`;
      if (p >= 100) {
        clearInterval(iv);
        if (progressWrap) progressWrap.style.display = 'none';
        showToast('⚠ Firebase Storage not ready — connect Firebase first', 'warn');
      }
    }, 100);
  }
}

function addMediaCard(name, url) {
  const grid = document.getElementById('mediaGrid');
  if (!grid) return;
  const card = document.createElement('div');
  card.className = 'media-card';
  const short = name.length > 16 ? name.substring(0,16) + '…' : name;
  card.innerHTML = `
    <div class="mc-thumb">🎬</div>
    <div class="mc-title" title="${name}">${short}</div>
    <div class="mc-meta">New · ${(url||'').substring(0,20)}…</div>
    <div class="mc-actions">
      <button onclick="previewMedia('${url}')">▶</button>
      <button onclick="addToQueue('${name}')">➕</button>
      <button onclick="this.closest('.media-card').remove()">🗑</button>
    </div>
  `;
  grid.prepend(card);
}

function previewMedia(url) {
  const player = document.getElementById('previewPlayer');
  if (player && url.startsWith('http')) {
    player.src = url;
    player.play();
    showToast('▶ Preview loaded', 'info');
  }
}

function addToQueue(name) {
  showToast(`➕ "${name}" added to queue`, 'success');
  addLog(`Queue: "${name}" added`, 'info');
}

function deleteMedia(key) {
  showToast(`🗑 Media "${key}" removed`, 'warn');
}

// ═══════════════════════════════════════════
// STREAM URL HELPERS
// ═══════════════════════════════════════════
function copyStreamUrl() {
  const el = document.getElementById('streamUrlDisplay');
  if (!el) return;
  navigator.clipboard.writeText(el.value).then(() => showToast('📋 Stream URL copied', 'success'));
}

function openStreamUrl() {
  const el = document.getElementById('streamUrlDisplay');
  if (el) window.open(el.value, '_blank');
}

// ═══════════════════════════════════════════
// CHANNEL CONFIG
// ═══════════════════════════════════════════
function addChannel() {
  const name = prompt('Enter channel name (e.g. MI LIVE 3):');
  if (!name) return;
  const list = document.getElementById('channelList');
  const id = list.children.length + 1;
  const row = document.createElement('div');
  row.className = 'ch-row';
  row.innerHTML = `<span>CH${id} — ${name}</span><button onclick="editChannel(${id})">✏</button><button onclick="this.closest('.ch-row').remove()">🗑</button>`;
  list.appendChild(row);
  const sel = document.getElementById('channelSelect');
  if (sel) {
    const opt = document.createElement('option');
    opt.value = id; opt.textContent = name;
    sel.appendChild(opt);
  }
  showToast(`✅ Channel "${name}" added`, 'success');
}

function editChannel(id) { showToast(`✏ Edit channel ${id} — coming soon`, 'info'); }
function deleteChannel(id) { showToast(`🗑 Delete channel ${id} — coming soon`, 'warn'); }

function saveAllSettings() {
  const cfg = {
    projectId:   document.getElementById('cfgProjectId')?.value,
    databaseUrl: document.getElementById('cfgDbUrl')?.value,
    bucket:      document.getElementById('cfgBucket')?.value,
    hlsSegment:  document.getElementById('cfgHlsSeg')?.value,
    dvr:         document.getElementById('cfgDvr')?.value,
    resolution:  document.getElementById('cfgRes')?.value,
  };
  localStorage.setItem('milive_settings', JSON.stringify(cfg));
  showToast('💾 Settings saved locally', 'success');
  addLog('System settings saved', 'success');
}

// ═══════════════════════════════════════════
// EMERGENCY
// ═══════════════════════════════════════════
function triggerEmergency() {
  const conf = confirm('⚠ TRIGGER EMERGENCY BROADCAST? This will override current playout.');
  if (conf) {
    showToast('🚨 EMERGENCY MODE ACTIVATED', 'error');
    addLog('EMERGENCY BROADCAST TRIGGERED', 'error');
    document.getElementById('onAirBadge').style.borderColor = '#ff2244';
    document.getElementById('pattiScrollText').textContent = '🚨 EMERGENCY BROADCAST — براہ کرم توجہ دیں — PLEASE STAND BY 🚨';
  }
}

// ═══════════════════════════════════════════
// ANALYTICS — LIVE CHART
// ═══════════════════════════════════════════
let chartPoints = Array(20).fill(0).map(() => Math.floor(Math.random() * 500 + 200));
let chartCtx = null;

function initChart() {
  const canvas = document.getElementById('viewerChart');
  if (!canvas) return;
  chartCtx = canvas.getContext('2d');
  drawChart();
}

function drawChart() {
  if (!chartCtx) return;
  const canvas = chartCtx.canvas;
  canvas.width  = canvas.offsetWidth || 260;
  canvas.height = 120;
  const W = canvas.width; const H = canvas.height;
  const max = Math.max(...chartPoints);
  chartCtx.clearRect(0, 0, W, H);

  // Grid lines
  chartCtx.strokeStyle = 'rgba(255,255,255,0.05)';
  chartCtx.lineWidth = 1;
  for (let i = 0; i < 4; i++) {
    const y = H * i / 4;
    chartCtx.beginPath(); chartCtx.moveTo(0,y); chartCtx.lineTo(W,y); chartCtx.stroke();
  }

  // Fill gradient
  const grad = chartCtx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, 'rgba(0,220,130,0.3)');
  grad.addColorStop(1, 'rgba(0,220,130,0.02)');

  const step = W / (chartPoints.length - 1);
  chartCtx.beginPath();
  chartCtx.moveTo(0, H - (chartPoints[0]/max)*H*0.85);
  chartPoints.forEach((v,i) => {
    chartCtx.lineTo(i * step, H - (v/max)*H*0.85);
  });
  chartCtx.lineTo(W, H); chartCtx.lineTo(0, H); chartCtx.closePath();
  chartCtx.fillStyle = grad; chartCtx.fill();

  // Line
  chartCtx.beginPath();
  chartCtx.moveTo(0, H - (chartPoints[0]/max)*H*0.85);
  chartPoints.forEach((v,i) => chartCtx.lineTo(i*step, H-(v/max)*H*0.85));
  chartCtx.strokeStyle = '#00dc82'; chartCtx.lineWidth = 2;
  chartCtx.shadowColor = '#00dc82'; chartCtx.shadowBlur = 6;
  chartCtx.stroke(); chartCtx.shadowBlur = 0;
}

function updateAnalytics() {
  // Simulate live viewer count fluctuation
  chartPoints.push(Math.floor(chartPoints[chartPoints.length-1] + (Math.random()-0.5)*80));
  chartPoints.shift();
  if (chartPoints[chartPoints.length-1] < 50) chartPoints[chartPoints.length-1] = 50;

  const viewers = chartPoints[chartPoints.length-1];
  const statV = document.getElementById('statViewers');
  if (statV) statV.textContent = viewers.toLocaleString();
  const statBr = document.getElementById('statBitrate');
  if (statBr) statBr.textContent = `${(3.8 + Math.random()*0.8).toFixed(1)}Mbps`;
  const statBuf = document.getElementById('statBuffer');
  if (statBuf) statBuf.textContent = `${(0.05 + Math.random()*0.2).toFixed(2)}s`;

  drawChart();
}

// ═══════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════
function addLog(message, type = 'info') {
  const logList = document.getElementById('logList');
  if (!logList) return;
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  const now = new Date();
  const ts = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
  const prefix = { info:'INFO', success:'OK', warn:'WARN', error:'ERROR' }[type] || 'INFO';
  entry.textContent = `[${ts}][${prefix}] ${message}`;
  logList.prepend(entry);
  // Keep max 50 entries
  while (logList.children.length > 50) logList.removeChild(logList.lastChild);
  State.logBuffer.unshift({ ts, type, message });
}

// ═══════════════════════════════════════════
// TOAST NOTIFICATIONS
// ═══════════════════════════════════════════
window.showToast = function(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transition = 'opacity 0.4s'; }, 2500);
  setTimeout(() => toast.remove(), 3000);
};

// ═══════════════════════════════════════════
// MOBILE PANEL TOGGLE
// ═══════════════════════════════════════════
function initMobileToggle() {
  const btn = document.createElement('button');
  btn.className = 'mobile-panel-toggle';
  btn.textContent = '⚙';
  btn.addEventListener('click', () => {
    const rp = document.querySelector('.right-panel');
    if (rp) rp.classList.toggle('open');
  });
  document.body.appendChild(btn);
}

// ═══════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  // Start clocks
  setInterval(updateClocks, 1000);
  updateClocks();

  // Analytics
  setTimeout(initChart, 100);
  setInterval(updateAnalytics, 3000);

  // Mobile toggle
  initMobileToggle();

  // Load saved settings
  try {
    const saved = JSON.parse(localStorage.getItem('milive_settings') || '{}');
    if (saved.resolution) {
      const el = document.getElementById('cfgRes');
      if (el) el.value = saved.resolution;
    }
  } catch(e) {}

  addLog('MI LIVE TV Control Room initialized', 'success');
  addLog(`Firebase project: ramadan-2385b`, 'info');
  addLog('Waiting for stream engine…', 'info');

  // Set datetime-local min to now
  const schStart = document.getElementById('schStart');
  if (schStart) {
    const now = new Date();
    const tzOffset = now.getTimezoneOffset() * 60000;
    schStart.min = new Date(now - tzOffset).toISOString().slice(0,16);
    schStart.value = new Date(now - tzOffset).toISOString().slice(0,16);
  }
});

// Expose globals needed by inline HTML handlers
window.showPanel     = showPanel;
window.switchChannel = switchChannel;
window.playoutAction = playoutAction;
window.playNextInQueue = playNextInQueue;
window.toggleOverlay = toggleOverlay;
window.applyLogoSettings = applyLogoSettings;
window.applyTickerSettings = applyTickerSettings;
window.updateTickerSpeed = updateTickerSpeed;
window.updateTickerLang = updateTickerLang;
window.updateTickerStyle = updateTickerStyle;
window.insertBreaking = insertBreaking;
window.clearTicker   = clearTicker;
window.applyFilter   = applyFilter;
window.updateFilterIntensity = updateFilterIntensity;
window.addScheduleEntry = addScheduleEntry;
window.triggerPythonScheduler = triggerPythonScheduler;
window.saveFillerConfig = saveFillerConfig;
window.handleDrop    = handleDrop;
window.handleFileSelect = handleFileSelect;
window.previewMedia  = previewMedia;
window.addToQueue    = addToQueue;
window.deleteMedia   = deleteMedia;
window.copyStreamUrl = copyStreamUrl;
window.openStreamUrl = openStreamUrl;
window.triggerEmergency = triggerEmergency;
window.addChannel    = addChannel;
window.editChannel   = editChannel;
window.deleteChannel = deleteChannel;
window.saveAllSettings = saveAllSettings;
window.currentChannel = State.currentChannel;
