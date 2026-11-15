/* Farnworth Dead Hang — reads deadhang.csv and replays the challenge. */
(() => {
  'use strict';

  const DATA_URL = 'deadhang.csv';

  // World units (roughly "pixels at zoom 1"). Bar is at y = 0, ground at y = G.
  const S = 130;          // spacing between hangers
  const G = 330;          // bar-to-ground distance
  const SPEEDS = [4, 8, 16, 1];
  const MEDAL = { 1: '#ffcf40', 2: '#cfd6de', 3: '#d08a4e' };
  const MEDAL_DARK = { 1: '#a67c00', 2: '#7d8894', 3: '#7a4a22' };
  const CHALK = '#f2efe6';
  const FALLEN = '#8d93a0';
  const BG = '#15171c';

  const canvas = document.getElementById('stage');
  const ctx = canvas.getContext('2d');
  const clockEl = document.getElementById('clock');
  const subtitleEl = document.getElementById('subtitle');
  const hintEl = document.getElementById('hint');
  const resultsEl = document.getElementById('results');
  const boardEl = document.getElementById('board');
  const speedBtn = document.getElementById('speed');

  let W = 0, H = 0, dpr = 1;
  let figs = [];          // sorted shortest hang -> longest hang (left -> right)
  let times = [];
  let t = 0;              // challenge clock, seconds
  let speedIdx = 1;
  let phase = 'run';      // run -> celebrate -> overview
  let celebT = 0;
  let pRaw = 0;           // 0 = single line layout, 1 = overview layout
  let focus = null;       // index of zoomed-in figure during overview
  let grid = null;        // overview layout
  let confetti = [];
  let wall = 0;           // wall-clock seconds, for idle motion
  const cam = { x: 0, y: 0, z: 1 };

  // ---------- data ----------

  function parseCSV(text) {
    const rows = text.trim().split(/\r?\n/).map(line => {
      const out = []; let cur = ''; let q = false;
      for (const ch of line) {
        if (ch === '"') q = !q;
        else if (ch === ',' && !q) { out.push(cur); cur = ''; }
        else cur += ch;
      }
      out.push(cur);
      return out.map(s => s.trim());
    });
    const head = rows.shift().map(h => h.toLowerCase());
    const col = key => head.findIndex(h => h.includes(key));
    const ci = { name: col('name'), time: col('time'), date: col('date') };
    return rows
      .map(r => ({ name: r[ci.name], time: parseFloat(r[ci.time]), date: r[ci.date] || '' }))
      .filter(r => r.name && isFinite(r.time));
  }

  function buildFigures(rows) {
    const best = new Map();
    for (const r of rows) {
      const b = best.get(r.name);
      if (!b) best.set(r.name, { ...r, attempts: 1 });
      else {
        b.attempts++;
        if (r.time > b.time || (r.time === b.time && r.date < b.date)) { b.time = r.time; b.date = r.date; }
      }
    }
    // Ascending by time; on a tie, whoever set it first ranks higher (sits further right).
    const list = [...best.values()].sort((a, b) => a.time - b.time || (a.date < b.date ? 1 : -1));
    const n = list.length;
    return list.map((p, i) => {
      const parts = p.name.split(/\s+/);
      const rank = n - i;
      return {
        ...p, i, rank,
        medal: rank <= 3 ? rank : 0,
        short: parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : p.name,
        ax: i * S, bx: 0, by: 0,
        state: 'hang', yOff: 0, vy: 0, sit: 0, pop: 0,
        dir: i % 2 ? 1 : -1, ph: (i * 2.399) % 6.283,
      };
    });
  }

  const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  // ---------- layout & camera ----------

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, k) => a + (b - a) * k;
  const ease = k => k * k * (3 - 2 * k);

  const LABEL_PX = 100;   // screen space reserved above the bar for nameplates

  function followZoom() {
    return clamp(Math.min((H - LABEL_PX - 10) / (G + 50), W / (3.2 * S)), 0.2, 1.5);
  }
  const bandCenter = z => ((G + 50) - LABEL_PX / z) / 2;

  function computeGrid() {
    const n = figs.length;
    let pick = null;
    for (let R = 1; R <= 8; R++) {
      const cols = Math.ceil(n / R);
      const z = Math.min((W - 16) / (cols * S + 40), (H - R * 76) / (R * (G + 70)));
      if (z <= 0) continue;
      const g = { R, cols, z };
      if (!pick || z > pick.z) pick = g;
      if (z >= 0.28) { pick = g; break; }   // prefer the fewest rows that stay legible
    }
    pick.z = Math.min(pick.z, 1.2);
    pick.pitch = (G + 70) + 76 / pick.z;
    figs.forEach((f, i) => {
      f.row = Math.floor(i / pick.cols);
      f.bx = (i % pick.cols) * S;
      f.by = f.row * pick.pitch;
    });
    pick.cx = (pick.cols - 1) * S / 2;
    pick.cy = (-76 / pick.z + (pick.R - 1) * pick.pitch + G + 70) / 2;
    grid = pick;
  }

  function focusX() {
    const n = figs.length;
    let i = times.findIndex(T => T > t);
    let f;
    if (i === 0) f = 0;
    else if (i < 0) f = n - 1;
    else f = i - 1 + Math.pow((t - times[i - 1]) / (times[i] - times[i - 1]), 0.6);
    return Math.min(f, Math.max(0, n - 2)) * S;   // finish centred on the podium
  }

  function cameraTarget() {
    const zf = followZoom();
    if (phase !== 'overview') return { x: focusX(), y: bandCenter(zf), z: zf };
    if (focus !== null) {
      const f = figs[focus];
      return { x: f.bx, y: f.by + bandCenter(zf), z: zf };
    }
    return { x: grid.cx, y: grid.cy, z: grid.z };
  }

  function resize() {
    const r = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 3);
    W = r.width; H = r.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    if (figs.length) computeGrid();
  }

  // ---------- simulation ----------

  function reset() {
    t = 0; phase = 'run'; celebT = 0; pRaw = 0; focus = null; confetti = [];
    for (const f of figs) { f.state = 'hang'; f.yOff = 0; f.vy = 0; f.sit = 0; f.pop = 0; }
    resultsEl.hidden = true; hintEl.hidden = true;
    canvas.classList.remove('tappable');
    Object.assign(cam, cameraTarget());
  }

  function finish(instant) {
    t = times[times.length - 1];
    for (const f of figs) {
      if (f.medal) { f.state = 'medal'; if (instant) f.pop = 1; }
      else if (instant || f.state === 'hang') {
        if (instant) { f.state = 'sit'; f.yOff = G - 123; f.sit = 1; } else f.state = 'fall';
      }
    }
    if (instant) { phase = 'overview'; showResults(); if (instant === 'jump') { pRaw = 1; Object.assign(cam, cameraTarget()); } }
    else { phase = 'celebrate'; celebT = 0; spawnConfetti(); }
  }

  function showResults() {
    resultsEl.hidden = false; hintEl.hidden = false;
    canvas.classList.add('tappable');
  }

  function spawnConfetti() {
    const gold = figs[figs.length - 1];
    const sx = (gold.ax - cam.x) * cam.z + W / 2;
    const sy = (0 - cam.y) * cam.z + H / 2;
    const colours = ['#ffcf40', '#f2efe6', '#ff6b6b', '#5ec8ff', '#7be07b'];
    for (let k = 0; k < 110; k++) {
      const a = Math.random() * Math.PI * 2, v = 120 + Math.random() * 380;
      confetti.push({
        x: sx, y: sy, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 220,
        r: Math.random() * 6, vr: (Math.random() - 0.5) * 12,
        c: colours[k % colours.length], life: 2.2 + Math.random() * 1.2,
      });
    }
  }

  function step(dt) {
    wall += dt;
    if (phase === 'run') {
      t += dt * SPEEDS[speedIdx];
      if (t >= times[times.length - 1]) finish(false);
    } else if (phase === 'celebrate') {
      celebT += dt;
      if (celebT > 2.2) { phase = 'overview'; showResults(); }
    } else if (pRaw < 1) {
      pRaw = Math.min(1, pRaw + dt / 2.4);
    }

    for (const f of figs) {
      if (f.state === 'hang' && t >= f.time) f.state = f.medal ? 'medal' : 'fall';
      if (f.state === 'medal') f.pop = Math.min(1, f.pop + dt * 3);
      if (f.state === 'fall') {
        f.vy += 1500 * dt;
        f.yOff += f.vy * dt;
        if (f.yOff >= G - 123) { f.yOff = G - 123; f.state = 'sit'; }
      }
      if (f.state === 'sit') f.sit = Math.min(1, f.sit + dt * 5);
    }

    for (const c of confetti) {
      c.vy += 600 * dt; c.vx *= 1 - 1.2 * dt;
      c.x += c.vx * dt; c.y += c.vy * dt; c.r += c.vr * dt; c.life -= dt;
    }
    confetti = confetti.filter(c => c.life > 0);

    const tg = cameraTarget();
    const k = 1 - Math.exp(-dt * (phase === 'overview' ? 2.2 : 5));
    cam.x = lerp(cam.x, tg.x, k);
    cam.y = lerp(cam.y, tg.y, k);
    cam.z = Math.exp(lerp(Math.log(cam.z), Math.log(tg.z), k));
  }

  // ---------- drawing ----------

  function drawRig(x1, x2, y, alpha, posts) {
    if (alpha <= 0.01) return;
    ctx.globalAlpha = alpha;
    ctx.lineCap = 'butt';
    // ground
    ctx.strokeStyle = '#3a404d';
    ctx.lineWidth = Math.max(2, 1 / cam.z);
    ctx.beginPath(); ctx.moveTo(x1 - 60, y + G); ctx.lineTo(x2 + 60, y + G); ctx.stroke();
    // uprights
    ctx.strokeStyle = '#4a505e';
    ctx.lineWidth = Math.max(9, 2 / cam.z);
    ctx.beginPath();
    for (const px of posts) { ctx.moveTo(px, y - 22); ctx.lineTo(px, y + G); }
    ctx.stroke();
    // the bar
    ctx.strokeStyle = '#b9c0cc';
    ctx.lineWidth = Math.max(7, 2 / cam.z);
    ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x2, y); ctx.stroke();
    ctx.strokeStyle = '#ffffff55';
    ctx.lineWidth = Math.max(2, 0.6 / cam.z);
    ctx.beginPath(); ctx.moveTo(x1, y - 2); ctx.lineTo(x2, y - 2); ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function mix(a, b, k) { return [lerp(a[0], b[0], k), lerp(a[1], b[1], k)]; }

  function drawFigure(f, x, y0) {
    const d = f.dir;
    const falling = f.state === 'fall' || f.state === 'sit';
    const hanging = f.state === 'hang';
    // nerves: shake harder as their time approaches
    const left = f.time - t;
    const strain = hanging ? clamp(1 - left / 8, 0, 1) : 0;
    const jx = Math.sin(wall * 38 + f.ph) * 2.5 * strain * strain;
    const sway = Math.sin(wall * (1.6 + strain * 3) + f.ph) * (3 + strain * 7);
    const yo = y0 + f.yOff;
    const fl = wall * 22 + f.ph;

    // airborne / hanging pose
    let head = [x + jx, yo + 38], sh = [x + jx, yo + 56], hip = [x + jx + sway * 0.4, yo + 118];
    let hL, hR, fL, fR, kL, kR;
    if (falling) {
      hL = [x - 30 - 8 * Math.sin(fl), yo + 22 + 12 * Math.cos(fl)];
      hR = [x + 30 + 8 * Math.cos(fl), yo + 22 + 12 * Math.sin(fl)];
      fL = [x - 20 - 6 * Math.cos(fl), yo + 174];
      fR = [x + 20 + 6 * Math.sin(fl), yo + 174];
    } else {
      hL = [x - 15, y0]; hR = [x + 15, y0];
      fL = [hip[0] - 7 + sway, yo + 180];
      fR = [hip[0] + 7 + sway * 1.3, yo + 180];
    }
    kL = mix(hip, fL, 0.5); kR = mix(hip, fR, 0.5);

    if (f.sit > 0) {
      const s = ease(f.sit), gy = y0 + G;
      head = mix(head, [x - 10 * d, gy - 82], s);
      sh = mix(sh, [x - 8 * d, gy - 60], s);
      hip = mix(hip, [x, gy - 5], s);
      hL = mix(hL, [x - 30 * d, gy - 3], s);
      hR = mix(hR, [x + 20 * d, gy - 24], s);
      kL = mix(kL, [x + 26 * d, gy - 26], s);
      fL = mix(fL, [x + 50 * d, gy - 3], s);
      kR = mix(kR, [x + 28 * d, gy - 4], s);
      fR = mix(fR, [x + 58 * d, gy - 3], s);
    }

    ctx.strokeStyle = f.state === 'sit' ? FALLEN : CHALK;
    ctx.lineWidth = Math.max(4, 1.4 / cam.z);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(hL[0], hL[1]); ctx.lineTo(sh[0], sh[1]); ctx.lineTo(hR[0], hR[1]);
    ctx.moveTo(head[0], head[1]); ctx.lineTo(sh[0], sh[1]); ctx.lineTo(hip[0], hip[1]);
    ctx.moveTo(fL[0], fL[1]); ctx.lineTo(kL[0], kL[1]); ctx.lineTo(hip[0], hip[1]);
    ctx.lineTo(kR[0], kR[1]); ctx.lineTo(fR[0], fR[1]);
    ctx.stroke();
    ctx.beginPath(); ctx.arc(head[0], head[1], 13, 0, Math.PI * 2);
    ctx.fillStyle = BG; ctx.fill(); ctx.stroke();

    // face, only when big enough to read
    if (cam.z > 0.45) {
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (f.state === 'sit') {
        for (const ex of [-5, 5]) {
          ctx.moveTo(head[0] + ex - 2, head[1] - 4); ctx.lineTo(head[0] + ex + 2, head[1]);
          ctx.moveTo(head[0] + ex + 2, head[1] - 4); ctx.lineTo(head[0] + ex - 2, head[1]);
        }
      } else {
        for (const ex of [-5, 5]) { ctx.moveTo(head[0] + ex, head[1] - 3); ctx.lineTo(head[0] + ex, head[1] - 1); }
        if (f.state === 'medal') { ctx.moveTo(head[0] + 5, head[1] + 4); ctx.arc(head[0], head[1] + 3, 5, 0.15, Math.PI - 0.15); }
        else if (strain > 0.4 || falling) { ctx.moveTo(head[0] + 3, head[1] + 6); ctx.arc(head[0], head[1] + 6, 3, 0, Math.PI * 2); }
      }
      ctx.stroke();
    }

    if (f.state === 'medal' && f.pop > 0) {
      const p = f.pop, sc = p < 1 ? 1 + 0.6 * Math.sin(p * Math.PI) : 1;
      const mx = sh[0] + sway * 0.25, my = sh[1] + 34;
      ctx.globalAlpha = p;
      ctx.strokeStyle = '#d9412f';
      ctx.lineWidth = Math.max(3.5, 1 / cam.z);
      ctx.beginPath();
      ctx.moveTo(sh[0] - 7, sh[1] - 4); ctx.lineTo(mx, my - 6); ctx.lineTo(sh[0] + 7, sh[1] - 4);
      ctx.stroke();
      ctx.beginPath(); ctx.arc(mx, my, 11 * sc, 0, Math.PI * 2);
      ctx.fillStyle = MEDAL[f.medal]; ctx.fill();
      ctx.strokeStyle = MEDAL_DARK[f.medal]; ctx.lineWidth = Math.max(2, 0.8 / cam.z); ctx.stroke();
      if (cam.z > 0.45) {
        ctx.fillStyle = MEDAL_DARK[f.medal];
        ctx.font = '800 13px system-ui, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(String(f.medal), mx, my + 1);
      }
      ctx.globalAlpha = 1;
    }
  }

  function drawLabel(f, sx, sBar) {
    const z = cam.z;
    const fs = clamp(13 * z, 9, 15);
    const done = f.state !== 'hang';
    ctx.font = `700 ${fs}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    const maxW = S * z * 2 - 10;
    let name = f.name;
    if (ctx.measureText(name).width + 12 > maxW) name = f.short;
    const w = Math.max(ctx.measureText(name).width, done ? fs * 2.4 : 0) + 12;
    const full = fs * 2.5 + 2;                    // two-line plate height
    const h = done ? full : fs * 1.5;
    const bottom = sBar - 10 - (f.i % 2) * (full + 5);
    const top = bottom - h;
    const colour = f.state === 'medal' ? MEDAL[f.medal] : done ? '#5a6070' : '#8a91a0';

    ctx.strokeStyle = colour; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(sx, bottom); ctx.lineTo(sx, sBar - 4); ctx.stroke();
    ctx.fillStyle = 'rgba(21,23,28,0.92)';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(sx - w / 2, top, w, h, 4); else ctx.rect(sx - w / 2, top, w, h);
    ctx.fill(); ctx.stroke();

    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = f.state === 'sit' ? '#b4b9c4' : CHALK;
    ctx.fillText(name, sx, top + fs * 0.78);
    if (done) {
      ctx.fillStyle = f.state === 'medal' ? MEDAL[f.medal] : '#ffd23f';
      ctx.fillText(fmt(f.time), sx, top + fs * 1.85);
    }
  }

  function draw() {
    const z = cam.z, e = ease(pRaw);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * (W / 2 - cam.x * z), dpr * (H / 2 - cam.y * z));

    const n = figs.length;
    // single long rig (side-scroll view)
    const posts = [-80, (n - 1) * S + 80];
    for (let k = 5; k < n; k += 5) posts.push((k - 0.5) * S);
    drawRig(-80, (n - 1) * S + 80, 0, 1 - e, posts);
    // one rig per row (overview)
    if (e > 0) for (let r = 0; r < grid.R; r++) {
      const count = Math.min(grid.cols, n - r * grid.cols);
      const x2 = (count - 1) * S + 70;
      drawRig(-70, x2, r * grid.pitch, e, [-70, x2]);
    }

    const halfW = W / 2 / z + S, halfH = H / 2 / z + G + 200;
    const visible = [];
    for (const f of figs) {
      const x = lerp(f.ax, f.bx, e), y = lerp(0, f.by, e);
      if (Math.abs(x - cam.x) > halfW || Math.abs(y - cam.y) > halfH) continue;
      drawFigure(f, x, y);
      visible.push([f, x, y]);
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const [f, x, y] of visible) drawLabel(f, (x - cam.x) * z + W / 2, (y - cam.y) * z + H / 2);

    for (const c of confetti) {
      ctx.save();
      ctx.translate(c.x, c.y); ctx.rotate(c.r);
      ctx.globalAlpha = Math.min(1, c.life);
      ctx.fillStyle = c.c; ctx.fillRect(-4, -2.5, 8, 5);
      ctx.restore();
    }

    clockEl.textContent = fmt(t);
  }

  // ---------- UI ----------

  function buildBoard() {
    boardEl.innerHTML = '';
    for (const f of [...figs].reverse()) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      if (f.medal) b.className = 'm' + f.medal;
      const rank = document.createElement('span'); rank.className = 'rank'; rank.textContent = f.rank;
      const who = document.createElement('span'); who.className = 'who';
      const nm = document.createElement('span'); nm.className = 'name'; nm.textContent = f.name;
      const meta = document.createElement('span'); meta.className = 'meta';
      meta.textContent = [f.date, f.attempts > 1 ? `best of ${f.attempts} attempts` : ''].filter(Boolean).join(' · ');
      who.append(nm, meta);
      const tm = document.createElement('span'); tm.className = 'time'; tm.textContent = fmt(f.time);
      b.append(rank, who, tm);
      b.addEventListener('click', () => {
        focus = f.i;
        canvas.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      li.append(b); boardEl.append(li);
    }
  }

  canvas.addEventListener('click', ev => {
    if (phase !== 'overview') return;
    if (focus !== null) { focus = null; return; }
    const r = canvas.getBoundingClientRect();
    const wx = (ev.clientX - r.left - W / 2) / cam.z + cam.x;
    const wy = (ev.clientY - r.top - H / 2) / cam.z + cam.y;
    let bestD = Infinity, bestI = null;
    for (const f of figs) {
      const d = Math.hypot(f.bx - wx, (f.by + G / 2 - wy) * 0.5);
      if (d < bestD) { bestD = d; bestI = f.i; }
    }
    focus = bestI;
  });

  document.getElementById('replay').addEventListener('click', reset);
  document.getElementById('skip').addEventListener('click', () => { if (phase !== 'overview') finish('skip'); });
  speedBtn.addEventListener('click', () => {
    speedIdx = (speedIdx + 1) % SPEEDS.length;
    speedBtn.textContent = SPEEDS[speedIdx] === 1 ? 'Speed 1× (real time)' : `Speed ${SPEEDS[speedIdx]}×`;
  });

  // ---------- boot ----------

  let last = 0;
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;
    step(dt);
    draw();
    requestAnimationFrame(frame);
  }

  fetch(DATA_URL, { cache: 'no-cache' })
    .then(r => { if (!r.ok) throw new Error(r.status); return r.text(); })
    .then(text => {
      figs = buildFigures(parseCSV(text));
      if (!figs.length) throw new Error('no rows');
      times = figs.map(f => f.time);
      subtitleEl.textContent = `${figs.length} contenders. One bar. Who hangs on longest?`;
      buildBoard();
      resize();
      new ResizeObserver(resize).observe(canvas);
      reset();
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) finish('jump');
      requestAnimationFrame(frame);
    })
    .catch(err => {
      subtitleEl.textContent = `Couldn't load ${DATA_URL} (${err.message}).`;
    });
})();
