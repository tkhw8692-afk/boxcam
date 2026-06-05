/* =====================================================================
   VISION — on-device tracking overlay filter
   Phase 1: 카메라 피드 + 절차적(가짜) 박스 오버레이 + 녹화/사진 저장
   구조는 Phase 2(모션) / 3(사진 코너) / 4(얼굴)이 끼워지도록 잡음.
   ===================================================================== */

'use strict';

/* ---------- DOM ---------- */
const $ = (id) => document.getElementById(id);
const video   = $('video');
const photo   = $('photo');
const canvas  = $('canvas');
const ctx     = canvas.getContext('2d', { alpha: false });

const startScreen = $('startScreen');
const errScreen   = $('errScreen');
const controls    = $('controls');
const panel       = $('panel');
const hud         = $('hud');
const hudText     = $('hud-text');
const fileInput   = $('fileInput');

/* ---------- 설정/상태 ---------- */
const COLORS = {
  white: [223, 232, 236],
  cyan:  [70, 230, 255],
  green: [92, 255, 157],
  amber: [255, 207, 107],
};

const state = {
  mode: 'idle',            // 'camera' | 'photo' | 'idle'
  facing: 'user',          // 'user' | 'environment'
  mirror: true,            // 셀카는 좌우반전
  source: null,            // 현재 그릴 소스 엘리먼트 (video|img)
  srcW: 0, srcH: 0,
  stream: null,
  running: false,
  color: COLORS.white,
  density: 48,             // 목표 박스 수
  sensitivity: 0.55,       // Phase 2 모션 가중치 (지금은 드리프트 강도에 사용)
  showLines: true,
  showScan: true,
  faceMode: false,         // 얼굴 정밀 추적 (MediaPipe) on/off
};

function lerp(a, b, t) { return a + (b - a) * t; }

/* =====================================================================
   모션 엔진 (Phase 2) — 프레임 차분으로 "어디가 움직이는지" 맵 생성
   분석은 화면(canvas)과 동일한 cover+mirror 공간에서 수행 →
   셀 좌표가 박스의 정규화 좌표와 1:1 대응.
   ===================================================================== */
const motion = {
  cols: 0, rows: 0,
  data: null,            // Float32Array: 셀별 모션 세기 0..1 (시간 평활)
  prev: null,            // Float32Array: 직전 프레임 그레이스케일
  acan: document.createElement('canvas'),
  actx: null,
  total: 0,              // 평균 모션 (활동량)
  ready: false,
  primed: false,         // 첫 프레임(prev 채우기) 완료 여부
};

function setupMotionGrid() {
  const long = 64;
  if (canvas.width >= canvas.height) {
    motion.cols = long;
    motion.rows = Math.max(8, Math.round(long * canvas.height / canvas.width));
  } else {
    motion.rows = long;
    motion.cols = Math.max(8, Math.round(long * canvas.width / canvas.height));
  }
  motion.acan.width = motion.cols;
  motion.acan.height = motion.rows;
  motion.actx = motion.acan.getContext('2d', { willReadFrequently: true });
  const n = motion.cols * motion.rows;
  motion.data = new Float32Array(n);
  motion.prev = new Float32Array(n);
  motion.primed = false;
  motion.ready = false;
}

function updateMotion() {
  const { cols, rows, actx } = motion;
  if (!actx) return;
  const sw = state.srcW, sh = state.srcH;
  if (!sw || !sh || !video.videoWidth) return;

  // 화면과 같은 cover+mirror로 비디오를 저해상 분석 캔버스에 그림
  const scale = Math.max(cols / sw, rows / sh);
  const dw = sw * scale, dh = sh * scale, dx = (cols - dw) / 2, dy = (rows - dh) / 2;
  actx.save();
  actx.clearRect(0, 0, cols, rows);
  if (state.mirror) { actx.translate(cols, 0); actx.scale(-1, 1); }
  actx.drawImage(video, dx, dy, dw, dh);
  actx.restore();

  const px = actx.getImageData(0, 0, cols, rows).data;
  const thr = lerp(42, 7, state.sensitivity);   // 민감도↑ → 임계값↓ → 모션 많이
  const d = motion.data, prev = motion.prev;
  const n = cols * rows;
  let total = 0;

  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const g = px[o] * 0.3 + px[o + 1] * 0.59 + px[o + 2] * 0.11;
    const diff = Math.abs(g - prev[i]);
    prev[i] = g;
    let m = diff > thr ? Math.min(1, (diff - thr) / 55) : 0;
    // 빠르게 차오르고 천천히 사라짐 → 박스가 잠깐 머묾
    d[i] = m > d[i] ? m : d[i] * 0.82;
    total += d[i];
  }
  if (!motion.primed) { motion.primed = true; return; }  // 첫 프레임은 기준만
  motion.total = total / n;
  motion.ready = true;
}

function motionAt(nx, ny) {
  if (!motion.ready) return 0;
  let c = (nx * motion.cols) | 0, r = (ny * motion.rows) | 0;
  if (c < 0) c = 0; else if (c >= motion.cols) c = motion.cols - 1;
  if (r < 0) r = 0; else if (r >= motion.rows) r = motion.rows - 1;
  return motion.data[r * motion.cols + c];
}

// 박스 주변의 모션 무게중심 — 박스가 여기로 끌려가며 "추적"
function localMotionCentroid(nx, ny, rad) {
  if (!motion.ready) return null;
  const { cols, rows, data } = motion;
  const cc = (nx * cols) | 0, cr = (ny * rows) | 0;
  let sx = 0, sy = 0, sw = 0;
  for (let dr = -rad; dr <= rad; dr++) {
    const r = cr + dr; if (r < 0 || r >= rows) continue;
    for (let dc = -rad; dc <= rad; dc++) {
      const c = cc + dc; if (c < 0 || c >= cols) continue;
      const m = data[r * cols + c];
      if (m <= 0) continue;
      sx += (c + 0.5) * m; sy += (r + 0.5) * m; sw += m;
    }
  }
  if (sw < 0.02) return null;
  return { x: sx / sw / cols, y: sy / sw / rows, m: sw };
}

// 모션 가중 랜덤으로 새 박스 위치 뽑기 (움직이는 곳에 박스 생성)
let _cum = null, _cumTotal = 0;
function buildCumulative() {
  const d = motion.data, n = d.length;
  if (!_cum || _cum.length !== n) _cum = new Float32Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) { acc += d[i]; _cum[i] = acc; }
  _cumTotal = acc;
}
function sampleMotionCell() {
  if (!motion.ready || _cumTotal <= 0.0005) return null;
  let x = Math.random() * _cumTotal;
  // 이분 탐색
  let lo = 0, hi = _cum.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (_cum[mid] < x) lo = mid + 1; else hi = mid; }
  const c = lo % motion.cols, r = (lo / motion.cols) | 0;
  return { x: (c + Math.random()) / motion.cols, y: (r + Math.random()) / motion.rows };
}

/* =====================================================================
   박스 시스템 — 좌표는 모두 정규화([0,1])로 저장 → 리사이즈/회전에 강함
   ===================================================================== */
let idCounter = 7600;
const boxes = [];

function rand(a, b) { return a + Math.random() * (b - a); }
function nextId() {
  idCounter++;
  if (idCounter > 9990) idCounter = 7600;
  return idCounter;
}

function spawnBox(motionMode) {
  let cx, cy;
  if (motionMode) {
    const cell = sampleMotionCell();
    if (!cell) return false;          // 움직이는 곳이 없으면 생성 안 함
    cx = cell.x; cy = cell.y;
  } else {
    cx = rand(0.04, 0.96);
    cy = rand(0.06, 0.94);
  }
  const big = Math.random() < 0.12;               // 가끔 큰 그룹 박스
  const w = big ? rand(0.10, 0.20) : rand(0.03, 0.085);
  const h = big ? rand(0.08, 0.15) : rand(0.025, 0.07);
  boxes.push({
    id: nextId(),
    x: cx - w / 2, y: cy - h / 2, w, h,
    jx: rand(0, 6.28), jy: rand(0, 6.28),   // 지터 위상
    age: 0, life: rand(1.6, 4.2),
    starve: 0,
  });
  return true;
}

function updateBoxes(dt, t) {
  const motionMode = (state.mode === 'camera' && motion.ready);
  if (motionMode) buildCumulative();

  // 목표 개수: 라이브는 활동량에 비례 (움직이면 박스 많아짐), 사진은 고정
  let target;
  if (motionMode) {
    const activity = Math.min(1, motion.total / 0.007);   // 적은 움직임에도 박스 잘 차게
    target = Math.max(8, Math.round(state.density * (0.2 + 0.8 * activity)));
  } else {
    target = Math.round(state.density * 0.6);
  }

  // 부족분 생성
  let guard = 0;
  while (boxes.length < target && guard++ < 240) {
    if (!spawnBox(motionMode)) break;
  }

  for (let i = boxes.length - 1; i >= 0; i--) {
    const b = boxes[i];
    b.age += dt;
    b.jx += dt * 2.0;
    b.jy += dt * 2.3;

    if (motionMode) {
      // 박스 주변 모션 무게중심으로 부드럽게 끌려감 → "추적"
      const cen = localMotionCentroid(b.x + b.w / 2, b.y + b.h / 2, 2);
      if (cen) {
        b.starve = 0;
        const k = Math.min(1, dt * 22);          // 빠릿하게 달라붙음 (덜 끈적)
        b.x += ((cen.x - b.w / 2) - b.x) * k;
        b.y += ((cen.y - b.h / 2) - b.y) * k;
      } else {
        b.starve += dt;     // 추적할 모션이 사라지면 곧 소멸
      }
    }

    const oob = b.x < -0.12 || b.x > 1.06 || b.y < -0.06 || b.y > 1.06;
    const starved = motionMode && b.starve > 0.3;
    if (b.age >= b.life || starved || oob) {
      boxes.splice(i, 1);
    }
  }

  while (boxes.length > target + 8) boxes.pop();
}

/* =====================================================================
   렌더링
   ===================================================================== */
function fitCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const r = canvas.getBoundingClientRect();
  canvas.width  = Math.round(r.width  * dpr);
  canvas.height = Math.round(r.height * dpr);
  setupMotionGrid();
}

function drawSourceCover() {
  const { source, srcW, srcH, mirror } = state;
  const cw = canvas.width, ch = canvas.height;
  if (!source || !srcW || !srcH) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cw, ch);
    return;
  }
  const scale = Math.max(cw / srcW, ch / srcH);
  const dw = srcW * scale, dh = srcH * scale;
  const dx = (cw - dw) / 2, dy = (ch - dh) / 2;
  ctx.save();
  if (mirror) { ctx.translate(cw, 0); ctx.scale(-1, 1); }
  ctx.drawImage(source, dx, dy, dw, dh);
  ctx.restore();
}

function drawBoxes(t) {
  const cw = canvas.width, ch = canvas.height;
  const [r, g, b] = state.color;
  const line = `rgba(${r},${g},${b},`;
  ctx.lineWidth = Math.max(1.6, cw / 560);     // 박스 선 두께
  ctx.font = `${Math.round(cw / 86)}px ui-monospace, monospace`;
  ctx.textBaseline = 'top';

  for (const box of boxes) {
    // 페이드 인/아웃
    const p = box.age / box.life;
    let a = 1;
    if (p < 0.15) a = p / 0.15;
    else if (p > 0.8) a = (1 - p) / 0.2;
    a = Math.max(0, Math.min(1, a)) * 0.62;

    // 지터를 픽셀로
    const jit = cw * 0.0015;
    const x = (box.x * cw) + Math.sin(box.jx) * jit;
    const y = (box.y * ch) + Math.cos(box.jy) * jit;
    const w = box.w * cw;
    const h = box.h * ch;

    // 박스
    ctx.strokeStyle = line + (a).toFixed(3) + ')';
    ctx.strokeRect(x, y, w, h);

    // 모서리 틱(코너 마커) — CV 룩 강화
    const tick = Math.min(w, h) * 0.18;
    ctx.beginPath();
    ctx.moveTo(x, y + tick); ctx.lineTo(x, y); ctx.lineTo(x + tick, y);
    ctx.moveTo(x + w - tick, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + tick);
    ctx.stroke();

    // ID
    ctx.fillStyle = line + (a * 0.9).toFixed(3) + ')';
    ctx.fillText(box.id, x + 2, y + 2);
  }
}

function drawLines(t) {
  if (!state.showLines) return;
  const cw = canvas.width, ch = canvas.height;
  const [r, g, b] = state.color;
  ctx.lineWidth = Math.max(1, cw / 900);
  const maxDist = cw * 0.28;

  // 박스 중심 좌표 캐시
  const cx = new Array(boxes.length);
  for (let i = 0; i < boxes.length; i++) {
    cx[i] = [(boxes[i].x + boxes[i].w / 2) * cw, (boxes[i].y + boxes[i].h / 2) * ch];
  }

  // 각 박스를 "이후 박스 중 가장 가까운 2개"와 연결 → 끊김 없는 네트워크
  let drawn = 0;
  const cap = 90;
  for (let i = 0; i < boxes.length && drawn < cap; i++) {
    const cand = [];
    for (let j = i + 1; j < boxes.length; j++) {
      const d = Math.hypot(cx[i][0] - cx[j][0], cx[i][1] - cx[j][1]);
      if (d <= maxDist) cand.push([d, j]);
    }
    cand.sort((a, b2) => a[0] - b2[0]);
    for (let k = 0; k < Math.min(2, cand.length); k++) {
      const [d, j] = cand[k];
      const a = (1 - d / maxDist) * 0.42;        // 더 진하게
      ctx.strokeStyle = `rgba(${r},${g},${b},${a.toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(cx[i][0], cx[i][1]);
      ctx.lineTo(cx[j][0], cx[j][1]);
      ctx.stroke();
      // 연결 끝점에 작은 노드 점
      ctx.fillStyle = `rgba(${r},${g},${b},${(a * 0.9).toFixed(3)})`;
      ctx.fillRect(cx[j][0] - 1, cx[j][1] - 1, 2, 2);
      if (++drawn >= cap) break;
    }
  }
}

function drawScan(t) {
  if (!state.showScan) return;
  const cw = canvas.width, ch = canvas.height;
  const [r, g, b] = state.color;
  const y = ((t * 0.08) % 1) * ch;
  const grd = ctx.createLinearGradient(0, y - ch * 0.06, 0, y + ch * 0.06);
  grd.addColorStop(0, `rgba(${r},${g},${b},0)`);
  grd.addColorStop(0.5, `rgba(${r},${g},${b},0.06)`);
  grd.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = grd;
  ctx.fillRect(0, y - ch * 0.06, cw, ch * 0.12);
}

/* =====================================================================
   얼굴 모드 (Phase 4) — MediaPipe Face Landmarker (478점)
   눈/코/입/눈썹에 박스, 턱선·얼굴 윤곽선, 페이스메시 점.
   모델은 토글 켤 때 지연 로드 (수 MB 다운로드).
   ===================================================================== */
let faceLandmarker = null;
let faceReady = false, faceLoading = false;
let faceLatest = null, faceLost = 0;
let faceFeatures = null, faceOval = null;

const FACE_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

async function ensureFace() {
  if (faceReady || faceLoading) return;
  faceLoading = true;
  $('btnFace').classList.add('loading');
  setHud('FACE // 모델 로딩…');
  try {
    const vision = await import(FACE_CDN + '/+esm');
    const { FaceLandmarker, FilesetResolver } = vision;
    const fileset = await FilesetResolver.forVisionTasks(FACE_CDN + '/wasm');
    faceLandmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: FACE_MODEL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numFaces: 1,
    });
    const uniq = (conns) => { const s = new Set(); conns.forEach((c) => { s.add(c.start); s.add(c.end); }); return [...s]; };
    faceFeatures = [
      { tag: 'EYE_L', idx: uniq(FaceLandmarker.FACE_LANDMARKS_LEFT_EYE),  id: nextId() },
      { tag: 'EYE_R', idx: uniq(FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE), id: nextId() },
      { tag: 'BROW_L', idx: uniq(FaceLandmarker.FACE_LANDMARKS_LEFT_EYEBROW),  id: nextId() },
      { tag: 'BROW_R', idx: uniq(FaceLandmarker.FACE_LANDMARKS_RIGHT_EYEBROW), id: nextId() },
      { tag: 'MOUTH', idx: uniq(FaceLandmarker.FACE_LANDMARKS_LIPS), id: nextId() },
      { tag: 'NOSE', idx: [1, 2, 98, 327, 5, 4, 6, 197, 195, 168, 45, 275], id: nextId() },
    ];
    faceOval = FaceLandmarker.FACE_LANDMARKS_FACE_OVAL;
    faceReady = true;
    setHud('FACE // tracking');
  } catch (e) {
    flash('얼굴 모델 로드 실패 — 네트워크 확인');
    state.faceMode = false;
    $('btnFace').classList.remove('active');
  } finally {
    faceLoading = false;
    $('btnFace').classList.remove('loading');
  }
}

function detectFace(ts) {
  try {
    const res = faceLandmarker.detectForVideo(video, ts);
    const lm = res && res.faceLandmarks && res.faceLandmarks[0];
    if (lm) { faceLatest = lm; faceLost = 0; }
    else if (++faceLost > 8) { faceLatest = null; }
  } catch (e) { /* 일시적 오류 무시 */ }
}

// 랜드마크(영상 정규화 좌표) → 캔버스 픽셀 (cover + mirror 반영)
function mapLandmark(lx, ly) {
  const cw = canvas.width, ch = canvas.height;
  const sw = state.srcW, sh = state.srcH;
  const scale = Math.max(cw / sw, ch / sh);
  const dw = sw * scale, dh = sh * scale, dx = (cw - dw) / 2, dy = (ch - dh) / 2;
  let x = dx + lx * dw;
  const y = dy + ly * dh;
  if (state.mirror) x = cw - x;
  return [x, y];
}

function drawFace(lm) {
  const cw = canvas.width;
  const [r, g, b] = state.color;
  const col = (a) => `rgba(${r},${g},${b},${a})`;

  // 1) 페이스메시 점들 (옅게)
  ctx.fillStyle = col(0.22);
  for (let i = 0; i < lm.length; i++) {
    const [x, y] = mapLandmark(lm[i].x, lm[i].y);
    ctx.fillRect(x - 0.6, y - 0.6, 1.5, 1.5);
  }

  // 2) 얼굴 윤곽선(턱선 포함)
  ctx.strokeStyle = col(0.5);
  ctx.lineWidth = Math.max(1.3, cw / 680);
  ctx.beginPath();
  for (const c of faceOval) {
    const [ax, ay] = mapLandmark(lm[c.start].x, lm[c.start].y);
    const [bx, by] = mapLandmark(lm[c.end].x, lm[c.end].y);
    ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
  }
  ctx.stroke();

  // 3) 이목구비 박스 + 라벨
  ctx.lineWidth = Math.max(1.6, cw / 560);
  ctx.font = `${Math.round(cw / 92)}px ui-monospace, monospace`;
  ctx.textBaseline = 'bottom';
  const centers = [];
  for (const f of faceFeatures) {
    let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
    for (const i of f.idx) {
      const [x, y] = mapLandmark(lm[i].x, lm[i].y);
      if (x < minx) minx = x; if (y < miny) miny = y;
      if (x > maxx) maxx = x; if (y > maxy) maxy = y;
    }
    const pad = Math.max(3, cw / 130);
    minx -= pad; miny -= pad; maxx += pad; maxy += pad;
    const w = maxx - minx, h = maxy - miny;
    ctx.strokeStyle = col(0.66);
    ctx.strokeRect(minx, miny, w, h);
    // 코너틱
    const tick = Math.min(w, h) * 0.22;
    ctx.beginPath();
    ctx.moveTo(minx, miny + tick); ctx.lineTo(minx, miny); ctx.lineTo(minx + tick, miny);
    ctx.moveTo(maxx - tick, miny); ctx.lineTo(maxx, miny); ctx.lineTo(maxx, miny + tick);
    ctx.stroke();
    ctx.fillStyle = col(0.85);
    ctx.fillText(`${f.id} ${f.tag}`, minx + 1, miny - 2);
    centers.push([minx + w / 2, miny + h / 2]);
  }

  // 4) 이목구비 박스끼리 연결선
  if (state.showLines) {
    ctx.strokeStyle = col(0.26);
    ctx.lineWidth = Math.max(1, cw / 900);
    ctx.beginPath();
    for (let i = 0; i < centers.length; i++) {
      for (let j = i + 1; j < centers.length; j++) {
        ctx.moveTo(centers[i][0], centers[i][1]);
        ctx.lineTo(centers[j][0], centers[j][1]);
      }
    }
    ctx.stroke();
  }
}

/* ---------- 메인 루프 ---------- */
let lastT = 0;
function loop(ts) {
  if (!state.running) return;
  const t = ts / 1000;
  const dt = Math.min(0.05, t - lastT || 0.016);
  lastT = t;

  if (state.mode === 'camera' && video.videoWidth) {
    state.srcW = video.videoWidth; state.srcH = video.videoHeight;
  }

  const faceActive = state.faceMode && faceReady && state.mode === 'camera' && video.videoWidth;

  if (faceActive) {
    detectFace(ts);
    if (!faceLatest) updateMotion();          // 얼굴 못 찾으면 모션으로 폴백
  } else if (state.mode === 'camera' && video.videoWidth) {
    updateMotion();
  }

  drawSourceCover();

  if (faceActive && faceLatest) {
    drawFace(faceLatest);
  } else {
    updateBoxes(dt, t);
    drawLines(t);
    drawBoxes(t);
  }

  drawScan(t);
  requestAnimationFrame(loop);
}

function startLoop() {
  if (state.running) return;
  state.running = true;
  lastT = 0;
  requestAnimationFrame(loop);
}

/* =====================================================================
   카메라
   ===================================================================== */
async function startCamera() {
  try {
    if (state.stream) state.stream.getTracks().forEach((tr) => tr.stop());
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: state.facing, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    state.stream = stream;
    video.srcObject = stream;
    await video.play();

    state.mode = 'camera';
    state.source = video;
    state.mirror = (state.facing === 'user');
    fitCanvas();
    enterRunning('LIVE // tracking');
  } catch (err) {
    showError(describeCamError(err));
  }
}

function describeCamError(err) {
  const n = err && err.name;
  if (n === 'NotAllowedError' || n === 'SecurityError')
    return '카메라 권한이 거부됐어요. 브라우저 설정에서 허용하거나 사진 모드로 진행하세요.';
  if (n === 'NotFoundError' || n === 'OverconstrainedError')
    return '사용 가능한 카메라를 찾지 못했어요.';
  if (n === 'NotReadableError')
    return '다른 앱이 카메라를 사용 중이에요.';
  return '카메라를 시작할 수 없어요: ' + (err && err.message || err);
}

/* =====================================================================
   사진 업로드
   ===================================================================== */
function openPhotoPicker() { fileInput.click(); }

fileInput.addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  photo.onload = () => {
    state.mode = 'photo';
    state.source = photo;
    state.mirror = false;
    state.srcW = photo.naturalWidth;
    state.srcH = photo.naturalHeight;
    if (state.stream) state.stream.getTracks().forEach((tr) => tr.stop());
    boxes.length = 0;
    fitCanvas();
    enterRunning('IMG // analyzing');
    URL.revokeObjectURL(url);
  };
  photo.src = url;
  fileInput.value = '';
});

/* =====================================================================
   녹화 / 스냅샷
   ===================================================================== */
let recorder = null, chunks = [];

function pickMime() {
  const c = ['video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  for (const m of c) if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  return '';
}

function toggleRecord() {
  if (recorder && recorder.state === 'recording') { recorder.stop(); return; }
  if (!canvas.captureStream) {
    flash('이 브라우저는 영상 녹화를 지원하지 않아요. 사진 저장을 사용하세요.');
    return;
  }
  const mime = pickMime();
  let stream;
  try {
    stream = canvas.captureStream(30);
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  } catch (e) {
    flash('녹화를 시작할 수 없어요 (브라우저 미지원).');
    return;
  }
  chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = () => {
    const type = recorder.mimeType || mime || 'video/webm';
    const blob = new Blob(chunks, { type });
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    downloadBlob(blob, `vision_${stamp()}.${ext}`);
    $('btnRecord').classList.remove('recording');
    setHud(state.mode === 'camera' ? 'LIVE // tracking' : 'IMG // analyzing');
  };
  recorder.start();
  $('btnRecord').classList.add('recording');
  setHud('REC ●');
}

function snapshot() {
  canvas.toBlob((blob) => {
    if (blob) downloadBlob(blob, `vision_${stamp()}.png`);
  }, 'image/png');
  flash('사진 저장됨');
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/* =====================================================================
   UI / 화면 전환
   ===================================================================== */
function enterRunning(hudMsg) {
  startScreen.hidden = true;
  errScreen.hidden = true;
  controls.hidden = false;
  $('btnSwitch').style.display = (state.mode === 'camera') ? '' : 'none';
  hud.classList.add('live');
  setHud(hudMsg);
  startLoop();
}

function showError(msg) {
  $('errMsg').textContent = msg;
  errScreen.hidden = false;
  controls.hidden = true;
}

function setHud(msg) { hudText.innerHTML = msg; }

let flashTimer = null;
function flash(msg) {
  setHud(msg);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    setHud(state.mode === 'camera' ? 'LIVE // tracking' : 'IMG // analyzing');
  }, 1400);
}

/* ---------- 버튼 와이어링 ---------- */
$('startCam').addEventListener('click', startCamera);
$('startPhoto').addEventListener('click', openPhotoPicker);
$('errRetry').addEventListener('click', startCamera);
$('errPhoto').addEventListener('click', openPhotoPicker);

$('btnRecord').addEventListener('click', toggleRecord);
$('btnShot').addEventListener('click', snapshot);
$('btnSwitch').addEventListener('click', () => {
  if (state.mode !== 'camera') return;
  state.facing = (state.facing === 'user') ? 'environment' : 'user';
  startCamera();
});
$('btnPanel').addEventListener('click', () => { panel.hidden = !panel.hidden; });
$('btnFace').addEventListener('click', async () => {
  if (state.mode !== 'camera') { flash('얼굴 모드는 카메라에서 동작해요'); return; }
  state.faceMode = !state.faceMode;
  $('btnFace').classList.toggle('active', state.faceMode);
  if (state.faceMode) {
    boxes.length = 0;          // 모션 박스 정리
    faceLatest = null; faceLost = 0;
    await ensureFace();
  } else {
    setHud('LIVE // tracking');
  }
});

/* ---------- 패널 컨트롤 ---------- */
$('density').addEventListener('input', (e) => { state.density = +e.target.value; });
$('sensitivity').addEventListener('input', (e) => { state.sensitivity = +e.target.value / 100; });
$('lines').addEventListener('change', (e) => { state.showLines = e.target.checked; });
$('scanline').addEventListener('change', (e) => { state.showScan = e.target.checked; });

const swatches = $('swatches');
swatches.addEventListener('click', (e) => {
  const sw = e.target.closest('.sw');
  if (!sw) return;
  state.color = COLORS[sw.dataset.color] || COLORS.white;
  [...swatches.children].forEach((c) => c.classList.toggle('active', c === sw));
});
swatches.firstElementChild.classList.add('active');

/* ---------- 리사이즈 ---------- */
let resizeT = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(fitCanvas, 150);
});
window.addEventListener('orientationchange', () => setTimeout(fitCanvas, 300));

/* =====================================================================
   환경 체크 (HTTPS / 인앱 브라우저)
   ===================================================================== */
function checkEnv() {
  const warnEl = $('envWarn');
  const msgs = [];

  // 보안 컨텍스트(카메라 필수)
  if (!window.isSecureContext && location.hostname !== 'localhost') {
    msgs.push('⚠ HTTPS가 아니면 카메라가 동작하지 않아요. 배포 링크(https)로 열어주세요.');
  }
  // 인앱 브라우저 감지
  const ua = navigator.userAgent || '';
  const inApp = /Instagram|FBAN|FBAV|Line|KAKAOTALK|NAVER|Snapchat|Twitter|TikTok|musical_ly/i.test(ua);
  if (inApp) {
    msgs.push('⚠ 인앱 브라우저에서는 카메라가 막힐 수 있어요. 우측 상단 메뉴에서 “사파리/크롬으로 열기”를 선택하세요.');
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    msgs.push('⚠ 이 브라우저는 카메라 API를 지원하지 않아요. 사진 업로드를 사용하세요.');
  }

  if (msgs.length) {
    warnEl.hidden = false;
    warnEl.innerHTML = msgs.join('<br><br>');
  }
}

/* ---------- 부팅 ---------- */
fitCanvas();
checkEnv();
setHud('VISION // standby');
