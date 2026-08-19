(() => {
'use strict';

const APP_VERSION = '3.0.0';
const DB_NAME = 'visual-route-web-v1';
const DB_VERSION = 2;
const DEFAULT_THRESHOLD = 1.10;
const STRIDE_M = 0.70;
const TURN_THRESHOLD_DEG = 42;
const TURN_MIN_STEP_GAP = 2;
const NAV_LOCAL_WINDOW_STEPS = 10;
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const normDeg = (d) => ((d % 360) + 360) % 360;
const signedAngle = (from, to) => ((to - from + 540) % 360) - 180;
const angleDiff = (a, b) => Math.abs(signedAngle(a, b));
const fmtTime = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function smoothAngle(previous, next, alpha = 0.22) {
  if (previous == null) return normDeg(next);
  return normDeg(previous + signedAngle(previous, next) * alpha);
}

function relHeading(startHeading, currentHeading) {
  if (startHeading == null || currentHeading == null) return null;
  return signedAngle(startHeading, currentHeading);
}

const state = {
  sensorGranted: false,
  motionActive: false,
  orientationActive: false,
  heading: null,
  headingSource: 'unknown',
  compassAccuracy: null,
  orientation: { alpha: null, beta: null, gamma: null },
  dynamicAcc: 0,
  detector: {
    gravity: 9.81,
    smooth: 0,
    p2: 0,
    p1: 0,
    lastStepAt: 0,
    threshold: Number(localStorage.getItem('visualRoute.stepThreshold')) || DEFAULT_THRESHOLD,
    refractoryMs: 280,
  },
  calibrating: false,
  calibrationSamples: [],
  measurementPaused: false,
  wakeLock: null,

  recording: false,
  recordStartAt: 0,
  recordStartHeading: null,
  recordSteps: 0,
  recordEvents: [],
  recordCheckpoints: [],

  navActive: false,
  navRoute: null,
  navStartHeading: null,
  navRawSteps: 0,
  navOffset: 0,
  navEvents: [],
  navEstimateStep: 0,
  navTurnAnchorHeading: 0,
  navTurnAnchorStep: 0,
  navMatchedTurnIndex: 0,
  lastTurnCorrection: null,
  lastVisualCorrection: null,
  navCandidate: null,

  stream: null,
  cameraMode: null,
};

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('routes')) {
        db.createObjectStore('routes', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function putRoute(route) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('routes', 'readwrite');
    tx.objectStore('routes').put(route);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function getRoutes() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('routes', 'readonly');
    const req = tx.objectStore('routes').getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function deleteRoute(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('routes', 'readwrite');
    tx.objectStore('routes').delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

function normalizeRoute(route) {
  const r = { ...route };
  r.schemaVersion = r.schemaVersion || 1;
  r.strideM = r.strideM || STRIDE_M;
  r.events = Array.isArray(r.events) ? r.events.map((e) => ({ ...e })) : [];
  const firstHeading = r.startHeading ?? r.events.find((e) => typeof e.heading === 'number')?.heading ?? 0;
  for (const e of r.events) {
    if (typeof e.relHeading !== 'number') {
      e.relHeading = typeof e.heading === 'number' ? signedAngle(firstHeading, e.heading) : 0;
    }
  }
  r.turns = detectTurns(r.events);
  r.checkpoints = Array.isArray(r.checkpoints) ? r.checkpoints.map((cp) => {
    const next = { ...cp };
    if (typeof next.relHeading !== 'number') {
      next.relHeading = typeof next.heading === 'number' ? signedAngle(firstHeading, next.heading) : null;
    }
    return next;
  }) : [];
  return r;
}

function setDot(id, status) {
  const el = $(id);
  el.classList.toggle('ok', status === 'ok');
  el.classList.toggle('bad', status === 'bad');
}

function renderCompassQuality() {
  let text = '方角品質: '; let status = 'ok';
  if (!state.orientationActive || state.heading == null) {
    text += '未判定'; status = 'bad';
  } else if (state.headingSource === 'webkitCompassHeading') {
    if (typeof state.compassAccuracy === 'number' && state.compassAccuracy >= 0) {
      if (state.compassAccuracy <= 20) text += `良好 (±${state.compassAccuracy.toFixed(0)}°)`;
      else if (state.compassAccuracy <= 40) { text += `注意 (±${state.compassAccuracy.toFixed(0)}°)`; status = 'bad'; }
      else { text += `低い (±${state.compassAccuracy.toFixed(0)}°)`; status = 'bad'; }
    } else text += '利用可';
  } else {
    text += '相対値のみ'; status = 'bad';
  }
  $('compassQuality').textContent = text;
  setDot('compassQualityDot', status);
}

function onOrientation(event) {
  let nextHeading = null;
  if (typeof event.webkitCompassHeading === 'number' && !Number.isNaN(event.webkitCompassHeading)) {
    nextHeading = normDeg(event.webkitCompassHeading);
    state.headingSource = 'webkitCompassHeading';
    state.compassAccuracy = typeof event.webkitCompassAccuracy === 'number' ? event.webkitCompassAccuracy : null;
  } else if (typeof event.alpha === 'number' && !Number.isNaN(event.alpha)) {
    nextHeading = normDeg(360 - event.alpha);
    state.headingSource = 'alpha';
    state.compassAccuracy = null;
  }
  if (nextHeading != null) state.heading = smoothAngle(state.heading, nextHeading);
  state.orientation = { alpha: event.alpha, beta: event.beta, gamma: event.gamma };
  state.orientationActive = true;
  setDot('orientDot', 'ok');
  $('orientStatus').textContent = `方角: 受信中 (${state.headingSource})`;
  renderCompassQuality();
  renderLive();
  renderNav();
}

function calculateDynamicAcceleration(event) {
  const a = event.acceleration;
  if (a && [a.x, a.y, a.z].every((v) => typeof v === 'number')) {
    return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
  }
  const ag = event.accelerationIncludingGravity;
  if (!ag || ![ag.x, ag.y, ag.z].every((v) => typeof v === 'number')) return null;
  const mag = Math.sqrt(ag.x * ag.x + ag.y * ag.y + ag.z * ag.z);
  state.detector.gravity = 0.94 * state.detector.gravity + 0.06 * mag;
  return Math.abs(mag - state.detector.gravity);
}

function resetDetectorTransient() {
  state.detector.smooth = 0;
  state.detector.p1 = 0;
  state.detector.p2 = 0;
  state.detector.lastStepAt = performance.now();
}

function detectPeak(now, value) {
  const d = state.detector;
  const p2 = d.p2;
  const p1 = d.p1;
  const isPeak = p1 > p2 && p1 >= value && p1 >= d.threshold;
  if (isPeak && now - d.lastStepAt >= d.refractoryMs) {
    d.lastStepAt = now;
    countStep();
  }
  d.p2 = p1;
  d.p1 = value;
}

function onMotion(event) {
  const raw = calculateDynamicAcceleration(event);
  if (raw == null) return;
  state.detector.smooth = 0.68 * state.detector.smooth + 0.32 * raw;
  state.dynamicAcc = state.detector.smooth;
  state.motionActive = true;
  setDot('motionDot', 'ok');
  $('motionStatus').textContent = 'DeviceMotion: 受信中';

  const now = performance.now();
  if (state.calibrating && !state.measurementPaused) {
    state.calibrationSamples.push({ t: now, v: state.detector.smooth });
  }
  if (!state.measurementPaused) detectPeak(now, state.detector.smooth);
  renderLive();
}

function countStep() {
  if (state.calibrating) return;
  if (state.recording) {
    state.recordSteps += 1;
    state.recordEvents.push({
      t: Date.now(),
      steps: state.recordSteps,
      heading: state.heading,
      relHeading: relHeading(state.recordStartHeading, state.heading) ?? 0,
      orientation: { ...state.orientation },
    });
  }
  if (state.navActive) {
    state.navRawSteps += 1;
    const rel = relHeading(state.navStartHeading, state.heading) ?? 0;
    const ev = { t: Date.now(), steps: state.navRawSteps, relHeading: rel, heading: state.heading };
    state.navEvents.push(ev);
    maybeCorrectFromTurn(ev);
  }
  renderLive();
  renderNav();
}

function countPeaks(samples, threshold, refractoryMs = 280) {
  let count = 0;
  let last = -Infinity;
  for (let i = 1; i < samples.length - 1; i += 1) {
    const prev = samples[i - 1];
    const cur = samples[i];
    const next = samples[i + 1];
    if (cur.v > prev.v && cur.v >= next.v && cur.v >= threshold && cur.t - last >= refractoryMs) {
      count += 1;
      last = cur.t;
    }
  }
  return count;
}

function chooseThresholdForTarget(samples, target = 20) {
  let best = { threshold: DEFAULT_THRESHOLD, count: countPeaks(samples, DEFAULT_THRESHOLD), error: Infinity };
  for (let th = 0.35; th <= 2.80 + 1e-9; th += 0.05) {
    const count = countPeaks(samples, th);
    const error = Math.abs(count - target);
    const tie = Math.abs(th - DEFAULT_THRESHOLD) * 0.02;
    if (error + tie < best.error) best = { threshold: Number(th.toFixed(2)), count, error: error + tie };
  }
  return best;
}

async function toggleCalibration() {
  if (!state.sensorGranted) {
    alert('先に「センサーを許可」を押してください。');
    return;
  }
  if (state.recording || state.navActive) {
    alert('ルート記録/ナビ中はキャリブレーションできません。');
    return;
  }
  if (!state.calibrating) {
    state.calibrating = true;
    state.calibrationSamples = [];
    resetDetectorTransient();
    $('btnCalibration').textContent = '20歩終わった → 調整する';
    $('calibrationResult').textContent = '普段の持ち方で、正確に20歩歩いてからこのボタンをもう一度押してください。';
    await requestWakeLock();
    return;
  }

  state.calibrating = false;
  releaseWakeLock();
  if (state.calibrationSamples.length < 30) {
    $('calibrationResult').textContent = 'データが少なすぎます。もう一度20歩歩いてください。';
    $('btnCalibration').textContent = '20歩キャリブレーション';
    return;
  }
  const result = chooseThresholdForTarget(state.calibrationSamples, 20);
  state.detector.threshold = result.threshold;
  localStorage.setItem('visualRoute.stepThreshold', String(result.threshold));
  $('threshold').value = String(result.threshold);
  $('thresholdLabel').textContent = result.threshold.toFixed(2);
  $('calibrationResult').textContent = `自動調整: ${result.threshold.toFixed(2)} m/s²（このデータでは${result.count}歩検出）`;
  $('btnCalibration').textContent = '20歩キャリブレーション';
  resetDetectorTransient();
}

function resetCalibration() {
  state.detector.threshold = DEFAULT_THRESHOLD;
  localStorage.removeItem('visualRoute.stepThreshold');
  $('threshold').value = String(DEFAULT_THRESHOLD);
  $('thresholdLabel').textContent = DEFAULT_THRESHOLD.toFixed(2);
  $('calibrationResult').textContent = '初期値へ戻しました。';
}

async function requestSensors() {
  try {
    let ok = true;
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      ok = ok && (await DeviceMotionEvent.requestPermission()) === 'granted';
    }
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      ok = ok && (await DeviceOrientationEvent.requestPermission()) === 'granted';
    }
    if (!ok) throw new Error('センサー権限が拒否されました');
    window.addEventListener('devicemotion', onMotion, { passive: true });
    window.addEventListener('deviceorientation', onOrientation, { passive: true });
    state.sensorGranted = true;
    $('permissionBox').className = 'box goodbox';
    $('permissionBox').textContent = 'センサー許可済み。iPhoneを少し動かして受信状態を確認してください。';
    $('btnPermission').textContent = 'センサー許可済み';
    $('btnPermission').disabled = true;
  } catch (error) {
    $('permissionBox').className = 'box error';
    $('permissionBox').textContent = `センサーを開始できません: ${error?.message || error}`;
  }
}

async function requestWakeLock() {
  if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
  } catch (_) {
    state.wakeLock = null;
  }
}

function releaseWakeLock() {
  if (state.wakeLock) {
    try { state.wakeLock.release(); } catch (_) {}
    state.wakeLock = null;
  }
}

function pauseMeasurement(reason) {
  if (!(state.recording || state.navActive || state.calibrating)) return;
  state.measurementPaused = true;
  releaseWakeLock();
  $('resumeReason').textContent = reason;
  $('resumeBanner').hidden = false;
}

async function resumeMeasurement() {
  state.measurementPaused = false;
  resetDetectorTransient();
  $('resumeBanner').hidden = true;
  await requestWakeLock();
}

function renderLive() {
  $('recordSteps').textContent = state.recordSteps;
  $('dynamicAcc').textContent = state.dynamicAcc.toFixed(2);
  $('absoluteHeading').textContent = state.heading == null ? '--°' : `${state.heading.toFixed(0)}°`;
  const relative = state.recording ? relHeading(state.recordStartHeading, state.heading) : null;
  $('relativeHeading').textContent = relative == null ? '--°' : `${relative.toFixed(0)}°`;
  $('compassAccuracy').textContent = typeof state.compassAccuracy === 'number' && state.compassAccuracy >= 0 ? `±${state.compassAccuracy.toFixed(0)}°` : '--';
  ['alpha', 'beta', 'gamma'].forEach((key) => {
    const v = state.orientation[key];
    $(key).textContent = typeof v === 'number' ? `${v.toFixed(1)}°` : '--°';
  });
  if (state.recording) $('elapsed').textContent = fmtTime(Date.now() - state.recordStartAt);
}

function ensureSensorReadyForRoute() {
  if (!state.sensorGranted) {
    alert('先に「センサーを許可」を押してください。');
    return false;
  }
  if (!state.motionActive || state.heading == null) {
    alert('まだセンサー値を受信できていません。iPhoneを少し動かして方角が表示されてから開始してください。');
    return false;
  }
  return true;
}

async function startRecording() {
  if (!ensureSensorReadyForRoute()) return;
  if (state.calibrating) return;
  state.recording = true;
  state.recordSteps = 0;
  state.recordStartAt = Date.now();
  state.recordStartHeading = state.heading;
  state.recordEvents = [{
    t: Date.now(),
    steps: 0,
    heading: state.heading,
    relHeading: 0,
    orientation: { ...state.orientation },
  }];
  state.recordCheckpoints = [];
  state.measurementPaused = false;
  resetDetectorTransient();
  $('recordButtons').innerHTML = `
    <button id="btnStopRecord" class="btn danger">STOP 保存</button>
    <button id="btnCheckpoint" class="btn secondary">現在地点を写真で記録</button>
  `;
  $('btnStopRecord').onclick = stopRecording;
  $('btnCheckpoint').onclick = () => openCamera('checkpoint');
  await requestWakeLock();
  renderLive();
}

function detectTurns(events) {
  if (!events?.length) return [];
  const out = [];
  let anchorHeading = events[0].relHeading ?? 0;
  let anchorStep = events[0].steps ?? 0;
  for (const ev of events) {
    const current = ev.relHeading ?? 0;
    const delta = signedAngle(anchorHeading, current);
    if (Math.abs(delta) >= TURN_THRESHOLD_DEG && ev.steps - anchorStep >= TURN_MIN_STEP_GAP) {
      out.push({ steps: ev.steps, relHeading: current, delta });
      anchorHeading = current;
      anchorStep = ev.steps;
    }
  }
  return out;
}

async function stopRecording() {
  state.recording = false;
  releaseWakeLock();
  if (state.recordSteps < 3) {
    alert('歩数が少なすぎるため保存しません。');
    resetRecordUI();
    return;
  }
  const route = {
    schemaVersion: 2,
    appVersion: APP_VERSION,
    id: `route-${Date.now()}`,
    name: $('routeName').value.trim() || '無題ルート',
    createdAt: new Date().toISOString(),
    durationMs: Date.now() - state.recordStartAt,
    totalSteps: state.recordSteps,
    strideM: STRIDE_M,
    startHeading: state.recordStartHeading,
    stepThreshold: state.detector.threshold,
    events: state.recordEvents,
    turns: detectTurns(state.recordEvents),
    checkpoints: state.recordCheckpoints,
  };
  await putRoute(route);
  alert(`保存しました\n${route.name}\n${route.totalSteps}歩 / 曲がり${route.turns.length} / 写真${route.checkpoints.length}枚`);
  resetRecordUI();
  await refreshRoutes();
}

function resetRecordUI() {
  state.recording = false;
  state.recordSteps = 0;
  state.recordEvents = [];
  state.recordCheckpoints = [];
  state.recordStartHeading = null;
  state.measurementPaused = false;
  $('resumeBanner').hidden = true;
  $('elapsed').textContent = '0:00';
  $('recordButtons').innerHTML = '<button id="btnStartRecord" class="btn">② START ルート記録</button>';
  $('btnStartRecord').onclick = startRecording;
  renderLive();
}

async function openCamera(mode) {
  if (!window.isSecureContext) {
    alert('カメラにはHTTPSが必要です。GitHub PagesからSafariで開いてください。');
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    alert('このSafariではカメラAPIを利用できません。');
    return;
  }
  if (mode === 'checkpoint' && !state.recording) return;
  if (mode === 'visual-match' && !state.navRoute) {
    alert('先にナビ対象ルートを選択してください。');
    return;
  }
  try {
    state.cameraMode = mode;
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    $('video').srcObject = state.stream;
    $('cameraModal').classList.add('active');
    $('cameraHelp').textContent = mode === 'checkpoint'
      ? `記録中 ${state.recordSteps}歩地点。ドア枠・壁の角・固定棚など、後で同じ場所だと分かりやすい構図を撮影してください。`
      : '登録時チェックポイントに近い向き・距離で撮影してください。似た場所が多い場合は特徴的な固定物を入れてください。';
  } catch (error) {
    alert(`カメラを開始できません: ${error?.message || error}`);
  }
}

function closeCamera() {
  $('cameraModal').classList.remove('active');
  if (state.stream) {
    state.stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
  }
  $('video').srcObject = null;
}

async function captureVideoFrame() {
  const video = $('video');
  if (video.videoWidth < 2 || video.videoHeight < 2) await sleep(250);
  const maxWidth = 720;
  const scale = Math.min(1, maxWidth / video.videoWidth);
  const width = Math.max(1, Math.round(video.videoWidth * scale));
  const height = Math.max(1, Math.round(video.videoHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(video, 0, 0, width, height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.76));
  const descriptor = computeDescriptorV2(canvas);
  return { blob, descriptor };
}

function sampleDescriptor(canvas, cropRatio = 1) {
  const w = 24; const h = 18;
  const small = document.createElement('canvas');
  small.width = w; small.height = h;
  const ctx = small.getContext('2d', { willReadFrequently: true });
  const sw = canvas.width * cropRatio;
  const sh = canvas.height * cropRatio;
  const sx = (canvas.width - sw) / 2;
  const sy = (canvas.height - sh) / 2;
  ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  const lum = new Array(w * h);
  const histR = new Array(12).fill(0);
  const histG = new Array(12).fill(0);
  const histB = new Array(12).fill(0);
  let brightness = 0;
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    lum[p] = y; brightness += y;
    histR[Math.min(11, Math.floor(r / 256 * 12))] += 1;
    histG[Math.min(11, Math.floor(g / 256 * 12))] += 1;
    histB[Math.min(11, Math.floor(b / 256 * 12))] += 1;
  }
  brightness /= lum.length;
  const mean = brightness;
  const contrast = Math.sqrt(lum.reduce((sum, v) => sum + (v - mean) ** 2, 0) / lum.length);
  const sd = contrast || 1;

  const gridW = 12, gridH = 9;
  const grid = [];
  for (let gy = 0; gy < gridH; gy += 1) {
    for (let gx = 0; gx < gridW; gx += 1) {
      let sum = 0, n = 0;
      const x0 = Math.floor(gx * w / gridW), x1 = Math.floor((gx + 1) * w / gridW);
      const y0 = Math.floor(gy * h / gridH), y1 = Math.floor((gy + 1) * h / gridH);
      for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) { sum += lum[y * w + x]; n += 1; }
      grid.push(((sum / Math.max(1, n)) - mean) / sd);
    }
  }

  const edgeHist = new Array(8).fill(0);
  let edgeEnergy = 0;
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const gx = lum[y * w + (x + 1)] - lum[y * w + (x - 1)];
      const gy = lum[(y + 1) * w + x] - lum[(y - 1) * w + x];
      const mag = Math.sqrt(gx * gx + gy * gy);
      if (mag < 10) continue;
      edgeEnergy += mag;
      let angle = Math.atan2(gy, gx);
      if (angle < 0) angle += Math.PI * 2;
      const bin = Math.min(7, Math.floor(angle / (Math.PI * 2) * 8));
      edgeHist[bin] += mag;
    }
  }

  const norm = (arr) => {
    const sum = arr.reduce((a, b) => a + b, 0) || 1;
    return arr.map((v) => v / sum);
  };
  const hashes = [];
  for (let y = 0; y < h; y += 3) {
    for (let x = 0; x < w - 1; x += 3) hashes.push(lum[y * w + x] > lum[y * w + x + 1] ? 1 : 0);
  }
  return {
    grid,
    hist: [...norm(histR), ...norm(histG), ...norm(histB)],
    edge: norm(edgeHist),
    hash: hashes,
    quality: { brightness, contrast, edgeEnergy: edgeEnergy / Math.max(1, (w - 2) * (h - 2)) },
  };
}

function computeDescriptorV2(canvas) {
  const full = sampleDescriptor(canvas, 1.0);
  const center = sampleDescriptor(canvas, 0.78);
  return {
    version: 2,
    views: [full, center],
    quality: full.quality,
  };
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return dot / (Math.sqrt(aa * bb) || 1);
}

function hashSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let same = 0;
  for (let i = 0; i < a.length; i += 1) if (a[i] === b[i]) same += 1;
  return same / a.length;
}

function viewSimilarity(a, b) {
  const grid = (cosine(a.grid, b.grid) + 1) / 2;
  const hist = clamp(cosine(a.hist, b.hist), 0, 1);
  const edge = clamp(cosine(a.edge, b.edge), 0, 1);
  const hash = hashSimilarity(a.hash, b.hash);
  return clamp(0.50 * grid + 0.20 * hist + 0.20 * edge + 0.10 * hash, 0, 1);
}

function descriptorSimilarity(a, b) {
  if (!a?.views || !b?.views) return 0;
  let best = 0;
  for (const av of a.views) for (const bv of b.views) best = Math.max(best, viewSimilarity(av, bv));
  return best;
}

function imageQualityMessage(descriptor) {
  const q = descriptor?.quality;
  if (!q) return { ok: true, text: '' };
  const problems = [];
  if (q.brightness < 40) problems.push('暗い');
  if (q.brightness > 220) problems.push('明るすぎる');
  if (q.contrast < 22) problems.push('コントラストが低い');
  if (q.edgeEnergy < 14) problems.push('特徴が少ない/ぼけている');
  return { ok: problems.length === 0, text: problems.join('・') };
}

async function blobToDescriptor(blob) {
  let bitmap = null;
  try {
    if ('createImageBitmap' in window) bitmap = await createImageBitmap(blob);
  } catch (_) {}
  const canvas = document.createElement('canvas');
  if (bitmap) {
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close?.();
    return computeDescriptorV2(canvas);
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image(); el.onload = () => resolve(el); el.onerror = reject; el.src = url;
    });
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);
    return computeDescriptorV2(canvas);
  } finally { URL.revokeObjectURL(url); }
}

async function ensureCheckpointDescriptors(route) {
  let changed = false;
  for (const cp of route.checkpoints || []) {
    if (cp.descriptor?.version === 2) continue;
    if (cp.blob) {
      try { cp.descriptor = await blobToDescriptor(cp.blob); changed = true; } catch (_) {}
    }
  }
  if (changed) { route.schemaVersion = 2; await putRoute(route); }
  return route;
}

async function captureCamera() {
  try {
    const snap = await captureVideoFrame();
    if (state.cameraMode === 'checkpoint') {
      if (!state.recording) { closeCamera(); return; }
      const quality = imageQualityMessage(snap.descriptor);
      if (!quality.ok && !confirm(`画像品質に注意: ${quality.text}\nそれでも保存しますか？`)) {
        closeCamera(); return;
      }
      state.recordCheckpoints.push({
        id: `cp-${Date.now()}`,
        steps: state.recordSteps,
        heading: state.heading,
        relHeading: relHeading(state.recordStartHeading, state.heading),
        blob: snap.blob,
        descriptor: snap.descriptor,
      });
      closeCamera();
      alert(`${state.recordSteps}歩地点の画像を保存しました。${quality.ok ? '' : `\n注意: ${quality.text}`}`);
    } else {
      closeCamera();
      await performVisualMatch(snap.descriptor);
    }
  } catch (error) {
    alert(`撮影処理に失敗しました: ${error?.message || error}`);
  }
}

async function performVisualMatch(descriptor) {
  if (!state.navRoute?.checkpoints?.length) {
    alert('このルートにはチェックポイント画像がありません。');
    return;
  }
  state.navRoute = await ensureCheckpointDescriptors(state.navRoute);
  const currentRel = relHeading(state.navStartHeading, state.heading) ?? 0;
  const candidates = [];
  for (const cp of state.navRoute.checkpoints) {
    if (!cp.descriptor?.views) continue;
    const imageScore = descriptorSimilarity(descriptor, cp.descriptor);
    const headingScore = typeof cp.relHeading === 'number' ? 1 - clamp(angleDiff(cp.relHeading, currentRel) / 100, 0, 1) : 0.5;
    const score = 0.90 * imageScore + 0.10 * headingScore;
    candidates.push({ cp, score, imageScore, headingScore });
  }
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  const second = candidates[1];
  if (!best) {
    alert('比較可能なチェックポイントがありません。');
    return;
  }
  const margin = second ? best.score - second.score : 1;
  const strong = best.score >= 0.72 && margin >= 0.035;
  const acceptable = best.score >= 0.63 && margin >= 0.018;
  state.navCandidate = acceptable ? best : null;

  $('matchResult').hidden = false;
  $('matchScore').textContent = `一致 ${(best.score * 100).toFixed(0)}% / 候補差 ${(margin * 100).toFixed(1)}pt`;
  $('matchScore').className = `match ${strong ? 'good' : acceptable ? 'weak' : 'bad'}`;
  let detail = `最有力: ${best.cp.steps}歩地点。画像単体 ${(best.imageScore * 100).toFixed(0)}%。`;
  if (strong) detail += ' 第2候補との差もあり、補正候補として比較的信頼できます。';
  else if (acceptable) detail += ' 補正は可能ですが、似た場所の誤一致に注意してください。';
  else detail += ' 候補が曖昧です。固定物を大きく入れ、登録時に近い構図で再撮影してください。';
  if (second) detail += ` 第2候補は${second.cp.steps}歩地点。`;
  $('matchDetail').textContent = detail;
  $('btnApplyMatch').hidden = !acceptable;
}

function applyVisualMatch() {
  if (!state.navCandidate) return;
  const cp = state.navCandidate.cp;
  state.navOffset = cp.steps - state.navRawSteps;
  state.navEstimateStep = cp.steps;
  state.lastVisualCorrection = { at: Date.now(), steps: cp.steps, score: state.navCandidate.score };
  $('visualCorrectionLabel').textContent = `${cp.steps}歩へ補正`;
  $('matchDetail').textContent += ' 補正を適用しました。';
  renderNav();
}

function maybeCorrectFromTurn(navEvent) {
  const route = state.navRoute;
  if (!route?.turns?.length) return;
  const delta = signedAngle(state.navTurnAnchorHeading, navEvent.relHeading);
  if (Math.abs(delta) < TURN_THRESHOLD_DEG || navEvent.steps - state.navTurnAnchorStep < TURN_MIN_STEP_GAP) return;

  const navTurn = { steps: navEvent.steps, relHeading: navEvent.relHeading, delta };
  state.navTurnAnchorHeading = navEvent.relHeading;
  state.navTurnAnchorStep = navEvent.steps;

  let matchIndex = -1;
  for (let i = state.navMatchedTurnIndex; i < Math.min(route.turns.length, state.navMatchedTurnIndex + 2); i += 1) {
    const rt = route.turns[i];
    const sameDirection = Math.sign(rt.delta) === Math.sign(navTurn.delta);
    const magnitudeOK = Math.abs(Math.abs(rt.delta) - Math.abs(navTurn.delta)) <= 65;
    if (sameDirection && magnitudeOK) { matchIndex = i; break; }
  }
  if (matchIndex < 0) return;
  const target = route.turns[matchIndex].steps;
  const currentAdjusted = state.navRawSteps + state.navOffset;
  const correction = target - currentAdjusted;
  if (Math.abs(correction) <= 12) {
    const applied = Math.round(correction * 0.75);
    state.navOffset += applied;
    state.lastTurnCorrection = { at: Date.now(), routeTurn: matchIndex + 1, applied, target };
    state.navMatchedTurnIndex = matchIndex + 1;
  }
}

function routePoints(route) {
  const points = [{ x: 0, y: 0, steps: 0 }];
  let x = 0, y = 0;
  for (const ev of route?.events || []) {
    if (!ev.steps) continue;
    const h = (ev.relHeading ?? 0) * Math.PI / 180;
    x += Math.sin(h) * (route.strideM || STRIDE_M);
    y -= Math.cos(h) * (route.strideM || STRIDE_M);
    points.push({ x, y, steps: ev.steps });
  }
  return points;
}

function clearCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#0b1118'; ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function drawRoute(canvas, route, progress = null) {
  clearCanvas(canvas);
  if (!route) return;
  const ctx = canvas.getContext('2d');
  const points = routePoints(route);
  if (points.length < 2) return;
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const rx = Math.max(0.5, maxX - minX), ry = Math.max(0.5, maxY - minY);
  const pad = 28, usable = canvas.width - pad * 2, scale = Math.min(usable / rx, usable / ry);
  const xy = (p) => ({
    x: pad + (p.x - minX) * scale + (usable - rx * scale) / 2,
    y: pad + (p.y - minY) * scale + (usable - ry * scale) / 2,
  });
  ctx.strokeStyle = '#596a82'; ctx.lineWidth = 3; ctx.beginPath();
  points.forEach((p, i) => { const q = xy(p); if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); });
  ctx.stroke();
  const dot = (p, color, r) => { const q = xy(p); ctx.fillStyle = color; ctx.beginPath(); ctx.arc(q.x, q.y, r, 0, Math.PI * 2); ctx.fill(); };
  dot(points[0], '#62c77a', 7); dot(points[points.length - 1], '#efb85e', 7);
  for (const turn of route.turns || []) {
    const point = points.find((p) => p.steps >= turn.steps) || points[points.length - 1];
    dot(point, '#c191ff', 4);
  }
  if (progress != null) {
    const idx = clamp(Math.round(progress * (points.length - 1)), 0, points.length - 1);
    dot(points[idx], '#4d91ff', 8);
    const q = xy(points[idx]); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(q.x, q.y, 8, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.fillStyle = '#7b899c'; ctx.font = 'bold 12px -apple-system'; ctx.fillText('START↑', 10, 18);
}

function nearestRouteEvent(route, predictedStep, currentRelHeading) {
  if (!route?.events?.length) return null;
  let best = null, bestScore = Infinity;
  const windowed = route.events.filter((ev) => Math.abs(ev.steps - predictedStep) <= NAV_LOCAL_WINDOW_STEPS);
  const candidates = windowed.length ? windowed : route.events;
  for (const ev of candidates) {
    const stepError = Math.abs(ev.steps - predictedStep) / 4;
    const headingError = currentRelHeading == null ? 0 : angleDiff(ev.relHeading ?? 0, currentRelHeading) / 45;
    const score = stepError + 0.75 * headingError;
    if (score < bestScore) { bestScore = score; best = ev; }
  }
  return best;
}

function nextRouteTurn(route, step) {
  return (route?.turns || []).find((turn) => turn.steps > step + 1) || null;
}

function confidenceForNav(headingDifference) {
  const visualFresh = state.lastVisualCorrection && Date.now() - state.lastVisualCorrection.at < 90000;
  const turnFresh = state.lastTurnCorrection && Date.now() - state.lastTurnCorrection.at < 90000;
  if (visualFresh && state.lastVisualCorrection.score >= 0.72) return { label: '高', cls: 'confidence-high' };
  if ((turnFresh && headingDifference != null && headingDifference < 35) || (headingDifference != null && headingDifference < 20)) return { label: '高', cls: 'confidence-high' };
  if (headingDifference == null || headingDifference < 50) return { label: '中', cls: 'confidence-medium' };
  return { label: '低', cls: 'confidence-low' };
}

function renderNav() {
  const route = state.navRoute;
  const rawAdjusted = Math.max(0, state.navRawSteps + state.navOffset);
  const currentRel = state.navActive ? relHeading(state.navStartHeading, state.heading) : null;
  $('navRawSteps').textContent = String(state.navRawSteps);
  $('navRelativeHeading').textContent = currentRel == null ? '--°' : `${currentRel.toFixed(0)}°`;
  if (!route) {
    $('navSteps').textContent = '0歩'; $('navProgressValue').textContent = '0%'; $('navProgressBar').style.width = '0%';
    $('navRecordedHeading').textContent = '--°'; $('navHeadingDiff').textContent = '--°'; $('nextTurn').textContent = 'ルートを選択してください';
    $('navConfidence').textContent = '--'; $('navConfidence').className = 'metric-value confidence-medium';
    clearCanvas($('navCanvas')); return;
  }

  const nearest = nearestRouteEvent(route, rawAdjusted, currentRel);
  let estimate = nearest ? nearest.steps : rawAdjusted;
  if (state.navActive && state.navEstimateStep > 0 && estimate < state.navEstimateStep - 2) estimate = state.navEstimateStep - 2;
  estimate = clamp(estimate, 0, route.totalSteps);
  state.navEstimateStep = estimate;
  const progress = clamp(estimate / Math.max(1, route.totalSteps), 0, 1);
  const headingDiff = nearest && currentRel != null ? angleDiff(nearest.relHeading ?? 0, currentRel) : null;
  const confidence = confidenceForNav(headingDiff);

  $('navSteps').textContent = `${Math.round(estimate)}歩`;
  $('navProgressValue').textContent = `${Math.round(progress * 100)}%`;
  $('navProgressBar').style.width = `${progress * 100}%`;
  $('navRecordedHeading').textContent = nearest ? `${(nearest.relHeading ?? 0).toFixed(0)}°` : '--°';
  $('navHeadingDiff').textContent = headingDiff == null ? '--°' : `${headingDiff.toFixed(0)}°`;
  $('navConfidence').textContent = confidence.label;
  $('navConfidence').className = `metric-value ${confidence.cls}`;
  $('turnCorrectionLabel').textContent = state.lastTurnCorrection ? `${state.lastTurnCorrection.applied >= 0 ? '+' : ''}${state.lastTurnCorrection.applied}歩` : 'なし';
  $('visualCorrectionLabel').textContent = state.lastVisualCorrection ? `${state.lastVisualCorrection.steps}歩へ` : 'なし';

  const turn = nextRouteTurn(route, estimate);
  $('nextTurn').textContent = progress >= 0.98 ? 'GOAL付近です' : turn ? `次の大きな方向変化まで約 ${Math.max(0, Math.round(turn.steps - estimate))} 歩` : 'この先に大きな方向変化はありません';
  drawRoute($('navCanvas'), route, progress);
}

async function loadNavRoute(id) {
  const routes = (await getRoutes()).map(normalizeRoute);
  state.navRoute = routes.find((r) => r.id === id) || null;
  state.navActive = false;
  state.navRawSteps = 0; state.navOffset = 0; state.navEstimateStep = 0; state.navEvents = [];
  state.lastTurnCorrection = null; state.lastVisualCorrection = null; state.navCandidate = null;
  state.navMatchedTurnIndex = 0;
  $('matchResult').hidden = true;
  renderNav();
}

async function startNavigation() {
  if (!ensureSensorReadyForRoute()) return;
  if (!state.navRoute) { alert('ルートを選択してください。'); return; }
  state.navActive = true;
  state.navRawSteps = 0; state.navOffset = 0; state.navEstimateStep = 0; state.navEvents = [];
  state.navStartHeading = state.heading;
  state.navTurnAnchorHeading = 0; state.navTurnAnchorStep = 0; state.navMatchedTurnIndex = 0;
  state.lastTurnCorrection = null; state.lastVisualCorrection = null; state.navCandidate = null;
  state.measurementPaused = false;
  resetDetectorTransient();
  renderNavButtons(true);
  await requestWakeLock();
  renderNav();
}

function stopNavigation() {
  state.navActive = false;
  releaseWakeLock();
  state.measurementPaused = false;
  $('resumeBanner').hidden = true;
  renderNavButtons(false);
}

function renderNavButtons(active) {
  $('navButtons').innerHTML = active
    ? '<button id="btnStopNav" class="btn danger">ナビ停止</button><button id="btnVisualMatch" class="btn secondary">画像で現在地点を補正</button>'
    : '<button id="btnStartNav" class="btn">同じSTART地点からナビ開始</button><button id="btnVisualMatch" class="btn secondary">画像で現在地点を補正</button>';
  if (active) $('btnStopNav').onclick = stopNavigation; else $('btnStartNav').onclick = startNavigation;
  $('btnVisualMatch').onclick = () => openCamera('visual-match');
}

async function refreshRoutes() {
  const routes = (await getRoutes()).map(normalizeRoute).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const list = $('routesList'); list.innerHTML = '';
  if (!routes.length) list.innerHTML = '<div class="card"><div class="note">まだ保存ルートがありません。「登録」から作成してください。</div></div>';

  for (const route of routes) {
    const el = document.createElement('div'); el.className = 'route';
    el.innerHTML = `
      <div class="route-title"></div><div class="route-meta"></div>
      <div class="pills"></div>
      <div class="canvas-wrap"><canvas width="340" height="340"></canvas></div>
      <div class="checkpoints"></div>
      <div class="row top-gap"><button class="btn secondary choose">ナビに選択</button><button class="btn secondary del">削除</button></div>`;
    el.querySelector('.route-title').textContent = route.name;
    el.querySelector('.route-meta').textContent = new Date(route.createdAt).toLocaleString('ja-JP');
    el.querySelector('.pills').innerHTML = `<span class="pill">${route.totalSteps}歩</span><span class="pill">${fmtTime(route.durationMs)}</span><span class="pill">${route.turns.length} turns</span><span class="pill">${route.checkpoints.length} photos</span><span class="pill">schema v${route.schemaVersion}</span>`;
    drawRoute(el.querySelector('canvas'), route);
    const cps = el.querySelector('.checkpoints');
    for (const cp of route.checkpoints) {
      const box = document.createElement('div'); box.className = 'checkpoint';
      const img = document.createElement('img');
      if (cp.blob instanceof Blob) {
        const url = URL.createObjectURL(cp.blob); img.src = url; img.onload = () => URL.revokeObjectURL(url);
      }
      const label = document.createElement('div'); label.textContent = `${cp.steps}歩`;
      box.append(img, label); cps.appendChild(box);
    }
    el.querySelector('.choose').onclick = () => { $('navRouteSelect').value = route.id; loadNavRoute(route.id); switchView('nav'); };
    el.querySelector('.del').onclick = async () => { if (confirm(`「${route.name}」を削除しますか？`)) { await deleteRoute(route.id); await refreshRoutes(); } };
    list.appendChild(el);
  }

  const select = $('navRouteSelect'); const previous = select.value;
  select.innerHTML = '<option value="">ルートを選択</option>';
  for (const route of routes) {
    const option = document.createElement('option'); option.value = route.id; option.textContent = `${route.name} / ${route.totalSteps}歩`;
    select.appendChild(option);
  }
  if (routes.some((r) => r.id === previous)) select.value = previous;
  await renderStorageInfo();
}

async function renderStorageInfo() {
  if (!navigator.storage?.estimate) { $('storageInfo').textContent = 'ストレージ使用量: このSafariでは取得できません。'; return; }
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    const mb = (n) => (n / 1024 / 1024).toFixed(1);
    $('storageInfo').textContent = `Safariサイトデータ概算: ${mb(usage)} MB / 上限 ${mb(quota)} MB`;
  } catch (_) { $('storageInfo').textContent = 'ストレージ使用量を取得できませんでした。'; }
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob);
  });
}

async function dataURLToBlob(dataURL) {
  const response = await fetch(dataURL); return response.blob();
}

async function exportBackup() {
  const routes = (await getRoutes()).map(normalizeRoute);
  const serialized = [];
  for (const route of routes) {
    const copy = { ...route, checkpoints: [] };
    for (const cp of route.checkpoints) {
      copy.checkpoints.push({ ...cp, blobDataURL: cp.blob instanceof Blob ? await blobToDataURL(cp.blob) : null, blob: undefined });
    }
    serialized.push(copy);
  }
  const payload = { format: 'visual-route-backup', version: 2, exportedAt: new Date().toISOString(), routes: serialized };
  const file = new File([JSON.stringify(payload)], `visual-route-backup-${new Date().toISOString().slice(0, 10)}.json`, { type: 'application/json' });
  if (navigator.share && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Visual Route backup' }); return; } catch (error) { if (error?.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(file); const a = document.createElement('a'); a.href = url; a.download = file.name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 3000);
}

async function importBackup(file) {
  try {
    const text = await file.text(); const payload = JSON.parse(text);
    if (payload?.format !== 'visual-route-backup' || !Array.isArray(payload.routes)) throw new Error('Visual Routeバックアップ形式ではありません');
    let count = 0;
    for (const raw of payload.routes) {
      const route = normalizeRoute(raw); route.checkpoints = [];
      for (const cp of raw.checkpoints || []) {
        route.checkpoints.push({ ...cp, blob: cp.blobDataURL ? await dataURLToBlob(cp.blobDataURL) : null, blobDataURL: undefined });
      }
      await putRoute(route); count += 1;
    }
    alert(`${count}ルートを復元しました。`); await refreshRoutes();
  } catch (error) { alert(`復元に失敗しました: ${error?.message || error}`); }
}

function switchView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $(`view-${name}`).classList.add('active');
  if (name === 'routes') refreshRoutes();
  if (name === 'nav') renderNav();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function handleVisibility() {
  if (document.visibilityState === 'hidden') {
    pauseMeasurement('Safariが非表示になりました。バックグラウンド中のセンサー値は信用せず停止しています。');
  } else if (!state.measurementPaused && (state.recording || state.navActive || state.calibrating)) {
    requestWakeLock();
  }
}

function bindUI() {
  document.querySelectorAll('nav button').forEach((button) => { button.onclick = () => switchView(button.dataset.view); });
  $('btnPermission').onclick = requestSensors;
  $('btnCalibration').onclick = toggleCalibration;
  $('btnResetCalibration').onclick = resetCalibration;
  $('threshold').value = String(state.detector.threshold);
  $('thresholdLabel').textContent = state.detector.threshold.toFixed(2);
  $('threshold').oninput = () => {
    state.detector.threshold = parseFloat($('threshold').value);
    localStorage.setItem('visualRoute.stepThreshold', String(state.detector.threshold));
    $('thresholdLabel').textContent = state.detector.threshold.toFixed(2);
  };
  $('btnStartRecord').onclick = startRecording;
  $('btnCapture').onclick = captureCamera;
  $('btnCloseCamera').onclick = closeCamera;
  $('btnStartNav').onclick = startNavigation;
  $('btnVisualMatch').onclick = () => openCamera('visual-match');
  $('btnApplyMatch').onclick = applyVisualMatch;
  $('navRouteSelect').onchange = () => loadNavRoute($('navRouteSelect').value);
  $('btnResumeMeasurement').onclick = resumeMeasurement;
  $('btnExport').onclick = exportBackup;
  $('btnImport').onclick = () => $('importFile').click();
  $('importFile').onchange = async () => { const file = $('importFile').files?.[0]; if (file) await importBackup(file); $('importFile').value = ''; };
  document.addEventListener('visibilitychange', handleVisibility);
  window.addEventListener('pagehide', () => pauseMeasurement('ページが非表示になりました。戻ったら「計測を再開」を押してください。'));
}

async function init() {
  bindUI();
  if (!window.isSecureContext) $('secureWarning').hidden = false;
  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('./sw.js?v=2.0.0').catch(() => {});
  setInterval(() => { if (state.recording) renderLive(); }, 500);
  try { await openDB(); await refreshRoutes(); } catch (error) { console.error(error); }
  renderLive(); renderNav(); renderCompassQuality();
}


/* ===========================
   V3 overlay
   =========================== */

const V3_AI_TFJS = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js';
const V3_AI_MOBILENET = 'https://cdn.jsdelivr.net/npm/@tensorflow-models/mobilenet@2.1.1/dist/mobilenet.min.js';
const V3_AI_MODEL_NAME = 'MobileNetV2 α0.25';
const BELIEF_HEADING_SIGMA = 38;
const BELIEF_VISUAL_SIGMA = 1.8;
const GRAPH_DESCRIPTOR_THRESHOLD = 0.86;
const GRAPH_AI_THRESHOLD = 0.90;

state.belief = null;
state.beliefRouteId = null;
state.ai = { status: 'idle', model: null, backend: null, error: null, loading: null };
state.graph = { nodes: [], edges: [], builtAt: null };

function normalizeProbabilities(arr) {
  let sum = 0;
  for (let i = 0; i < arr.length; i += 1) sum += arr[i];
  if (!Number.isFinite(sum) || sum <= 1e-30) {
    const uniform = 1 / Math.max(1, arr.length);
    for (let i = 0; i < arr.length; i += 1) arr[i] = uniform;
    return arr;
  }
  for (let i = 0; i < arr.length; i += 1) arr[i] /= sum;
  return arr;
}

function gaussian(x, sigma) {
  return Math.exp(-0.5 * (x / Math.max(0.001, sigma)) ** 2);
}

function initBelief(route, center = 0, sigma = 0.65) {
  if (!route) { state.belief = null; state.beliefRouteId = null; return; }
  const n = Math.max(1, Math.round(route.totalSteps)) + 1;
  const b = new Float64Array(n);
  for (let i = 0; i < n; i += 1) b[i] = gaussian(i - center, sigma) + 1e-9;
  normalizeProbabilities(b);
  state.belief = b;
  state.beliefRouteId = route.id;
}

function beliefPredictOneStep() {
  const b = state.belief;
  if (!b) return;
  const next = new Float64Array(b.length);
  // A detected step usually advances one route step, but can be a false/missed step.
  const transitions = [
    [0, 0.10],
    [1, 0.72],
    [2, 0.16],
    [3, 0.02],
  ];
  for (let i = 0; i < b.length; i += 1) {
    const p = b[i];
    if (p <= 0) continue;
    for (const [d, w] of transitions) {
      const j = Math.min(b.length - 1, i + d);
      next[j] += p * w;
    }
  }
  state.belief = normalizeProbabilities(next);
}

function routeHeadingAtStep(route, step) {
  if (!route?.events?.length) return 0;
  let best = route.events[0];
  let err = Infinity;
  for (const ev of route.events) {
    const e = Math.abs((ev.steps ?? 0) - step);
    if (e < err) { err = e; best = ev; }
  }
  return best?.relHeading ?? 0;
}

function beliefObserveHeading(currentRelHeading) {
  if (!state.belief || !state.navRoute || currentRelHeading == null) return;
  const b = state.belief;
  for (let i = 0; i < b.length; i += 1) {
    const expected = routeHeadingAtStep(state.navRoute, i);
    const d = angleDiff(expected, currentRelHeading);
    // Floor likelihood avoids catastrophic collapse when compass is temporarily poor.
    const likelihood = 0.08 + 0.92 * gaussian(d, BELIEF_HEADING_SIGMA);
    b[i] *= likelihood;
  }
  normalizeProbabilities(b);
}

function beliefObservePosition(step, sigma = BELIEF_VISUAL_SIGMA, strength = 4.0) {
  if (!state.belief) return;
  const b = state.belief;
  for (let i = 0; i < b.length; i += 1) {
    const local = gaussian(i - step, sigma);
    b[i] *= 1 + strength * local;
  }
  normalizeProbabilities(b);
}

function beliefObserveTurn(targetStep, strength = 3.4) {
  beliefObservePosition(targetStep, 2.2, strength);
}

function beliefStats() {
  const b = state.belief;
  if (!b?.length) return { map: 0, mean: 0, confidence: 0, peakMass: 0, entropy: 1, top: [] };
  let map = 0, maxP = -1, mean = 0, entropy = 0;
  const pairs = [];
  for (let i = 0; i < b.length; i += 1) {
    const p = b[i];
    mean += i * p;
    if (p > maxP) { maxP = p; map = i; }
    if (p > 0) entropy -= p * Math.log(p);
    pairs.push([i, p]);
  }
  const maxEntropy = Math.log(Math.max(2, b.length));
  const normalizedEntropy = clamp(entropy / maxEntropy, 0, 1);
  let peakMass = 0;
  for (let i = Math.max(0, map - 2); i <= Math.min(b.length - 1, map + 2); i += 1) peakMass += b[i];
  const confidence = clamp(0.58 * (1 - normalizedEntropy) + 0.42 * peakMass, 0, 1);
  pairs.sort((a, c) => c[1] - a[1]);
  return { map, mean, confidence, peakMass, entropy: normalizedEntropy, top: pairs.slice(0, 4) };
}

function drawBelief() {
  const canvas = $('beliefCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cssW = Math.max(280, canvas.clientWidth || 680);
  const cssH = 150;
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.fillStyle = '#0b1118'; ctx.fillRect(0, 0, cssW, cssH);
  const b = state.belief;
  if (!b?.length) {
    ctx.fillStyle = '#718096'; ctx.font = '12px -apple-system'; ctx.fillText('No probability distribution', 12, 24);
    return;
  }
  let maxP = 0;
  for (const p of b) maxP = Math.max(maxP, p);
  const padX = 12, baseY = 126, plotH = 96;
  const barW = Math.max(1, (cssW - padX * 2) / b.length);
  for (let i = 0; i < b.length; i += 1) {
    const h = maxP > 0 ? (b[i] / maxP) * plotH : 0;
    ctx.fillStyle = '#3d74bc';
    ctx.fillRect(padX + i * barW, baseY - h, Math.max(1, barW - 0.4), h);
  }
  const stats = beliefStats();
  const x = padX + stats.map / Math.max(1, b.length - 1) * (cssW - padX * 2);
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x, 18); ctx.lineTo(x, baseY + 2); ctx.stroke();
  ctx.fillStyle = '#9fb3cc'; ctx.font = '11px -apple-system';
  ctx.fillText('START', padX, 143);
  ctx.textAlign = 'right'; ctx.fillText('GOAL', cssW - padX, 143); ctx.textAlign = 'left';
}

function renderBeliefCandidates() {
  const el = $('beliefCandidates');
  if (!el) return;
  if (!state.belief || !state.navRoute) { el.textContent = 'ルートを選択してください。'; return; }
  const s = beliefStats();
  const top = s.top.map(([step, p]) => `${step}歩 ${(p * 100).toFixed(1)}%`).join(' / ');
  el.textContent = `最尤 ${s.map}歩・期待値 ${s.mean.toFixed(1)}歩・ピーク周辺 ${(s.peakMass * 100).toFixed(0)}% ｜ ${top}`;
}

function countStep() {
  if (state.calibrating) return;
  if (state.recording) {
    state.recordSteps += 1;
    state.recordEvents.push({
      t: Date.now(),
      steps: state.recordSteps,
      heading: state.heading,
      relHeading: relHeading(state.recordStartHeading, state.heading) ?? 0,
      orientation: { ...state.orientation },
    });
  }
  if (state.navActive) {
    state.navRawSteps += 1;
    const rel = relHeading(state.navStartHeading, state.heading) ?? 0;
    const ev = { t: Date.now(), steps: state.navRawSteps, relHeading: rel, heading: state.heading };
    state.navEvents.push(ev);
    beliefPredictOneStep();
    beliefObserveHeading(rel);
    maybeCorrectFromTurn(ev);
  }
  renderLive();
  renderNav();
}

function scriptOnce(src, globalName) {
  if (globalName && window[globalName]) return Promise.resolve(window[globalName]);
  return new Promise((resolve, reject) => {
    const existing = [...document.scripts].find((s) => s.src === src);
    if (existing) {
      const timer = setInterval(() => {
        if (!globalName || window[globalName]) { clearInterval(timer); resolve(globalName ? window[globalName] : true); }
      }, 100);
      setTimeout(() => { clearInterval(timer); reject(new Error(`timeout: ${src}`)); }, 20000);
      return;
    }
    const script = document.createElement('script');
    script.src = src; script.async = true; script.crossOrigin = 'anonymous';
    script.onload = () => resolve(globalName ? window[globalName] : true);
    script.onerror = () => reject(new Error(`load failed: ${src}`));
    document.head.appendChild(script);
  });
}

function renderAIStatus() {
  if (!$('aiStatus')) return;
  const s = state.ai.status;
  $('webgpuStatus').textContent = navigator.gpu ? '利用可能' : '未検出';
  if (s === 'ready') {
    $('aiStatus').textContent = `${V3_AI_MODEL_NAME} 準備完了`;
    $('aiStatus').className = 'ai-ready';
    $('aiBackend').textContent = state.ai.backend || '--';
    $('btnLoadAI').textContent = 'AIモデル読み込み済み';
    $('btnLoadAI').disabled = true;
    if ($('btnLoadAIGraph')) { $('btnLoadAIGraph').textContent = 'AIモデル読み込み済み'; $('btnLoadAIGraph').disabled = true; }
  } else if (s === 'loading') {
    $('aiStatus').textContent = 'モデルをダウンロード/初期化中…';
    $('aiStatus').className = 'ai-loading';
    $('aiBackend').textContent = '--';
  } else if (s === 'error') {
    $('aiStatus').textContent = `失敗: ${state.ai.error || 'unknown'}（V2特徴へフォールバック）`;
    $('aiStatus').className = 'ai-error';
    $('aiBackend').textContent = '--';
  } else {
    $('aiStatus').textContent = '未読み込み（V2画像特徴で動作）';
    $('aiStatus').className = '';
    $('aiBackend').textContent = '--';
  }
}

async function loadAIModel() {
  if (state.ai.status === 'ready') return state.ai.model;
  if (state.ai.loading) return state.ai.loading;
  state.ai.status = 'loading'; renderAIStatus();
  state.ai.loading = (async () => {
    try {
      await scriptOnce(V3_AI_TFJS, 'tf');
      await scriptOnce(V3_AI_MOBILENET, 'mobilenet');
      await window.tf.ready();
      // iOS Safari: standard tfjs bundle's WebGL backend is mature and reliable.
      if (window.tf.findBackend('webgl')) {
        await window.tf.setBackend('webgl');
        await window.tf.ready();
      }
      state.ai.backend = window.tf.getBackend();
      state.ai.model = await window.mobilenet.load({ version: 2, alpha: 0.25 });
      state.ai.status = 'ready'; state.ai.error = null;
      renderAIStatus();
      return state.ai.model;
    } catch (error) {
      state.ai.status = 'error';
      state.ai.error = error?.message || String(error);
      renderAIStatus();
      throw error;
    } finally {
      state.ai.loading = null;
    }
  })();
  return state.ai.loading;
}

async function computeAIEmbeddingFromCanvas(canvas) {
  if (state.ai.status !== 'ready' || !state.ai.model || !window.tf) return null;
  let tensor = null;
  try {
    tensor = state.ai.model.infer(canvas, true);
    const values = Array.from(await tensor.data());
    let norm = Math.sqrt(values.reduce((s, v) => s + v * v, 0)) || 1;
    return values.map((v) => Number((v / norm).toFixed(6)));
  } finally {
    tensor?.dispose?.();
  }
}

async function blobToCanvas(blob, maxWidth = 720) {
  let bitmap = null;
  try { if ('createImageBitmap' in window) bitmap = await createImageBitmap(blob); } catch (_) {}
  const canvas = document.createElement('canvas');
  if (bitmap) {
    const scale = Math.min(1, maxWidth / bitmap.width);
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    return canvas;
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image(); el.onload = () => resolve(el); el.onerror = reject; el.src = url;
    });
    const scale = Math.min(1, maxWidth / img.naturalWidth);
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally { URL.revokeObjectURL(url); }
}

async function ensureAIEmbedding(cp) {
  if (cp.aiEmbedding?.length) return cp.aiEmbedding;
  if (state.ai.status !== 'ready' || !(cp.blob instanceof Blob)) return null;
  const canvas = await blobToCanvas(cp.blob);
  cp.aiEmbedding = await computeAIEmbeddingFromCanvas(canvas);
  return cp.aiEmbedding;
}

function aiSimilarity(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return null;
  return clamp((cosine(a, b) + 1) / 2, 0, 1);
}

async function captureVideoFrame() {
  const video = $('video');
  if (video.videoWidth < 2 || video.videoHeight < 2) await sleep(250);
  const maxWidth = 720;
  const scale = Math.min(1, maxWidth / video.videoWidth);
  const width = Math.max(1, Math.round(video.videoWidth * scale));
  const height = Math.max(1, Math.round(video.videoHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  canvas.getContext('2d').drawImage(video, 0, 0, width, height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.76));
  const descriptor = computeDescriptorV2(canvas);
  const aiEmbedding = state.ai.status === 'ready' ? await computeAIEmbeddingFromCanvas(canvas) : null;
  return { blob, descriptor, aiEmbedding };
}

async function captureCamera() {
  try {
    const snap = await captureVideoFrame();
    if (state.cameraMode === 'checkpoint') {
      if (!state.recording) { closeCamera(); return; }
      const quality = imageQualityMessage(snap.descriptor);
      if (!quality.ok && !confirm(`画像品質に注意: ${quality.text}\nそれでも保存しますか？`)) {
        closeCamera(); return;
      }
      state.recordCheckpoints.push({
        id: `cp-${Date.now()}`,
        steps: state.recordSteps,
        heading: state.heading,
        relHeading: relHeading(state.recordStartHeading, state.heading),
        blob: snap.blob,
        descriptor: snap.descriptor,
        aiEmbedding: snap.aiEmbedding,
      });
      closeCamera();
      alert(`${state.recordSteps}歩地点の画像を保存しました。${snap.aiEmbedding ? '\nAI Embeddingも保存しました。' : ''}${quality.ok ? '' : `\n注意: ${quality.text}`}`);
    } else {
      closeCamera();
      await performVisualMatch(snap.descriptor, snap.aiEmbedding);
    }
  } catch (error) {
    alert(`撮影処理に失敗しました: ${error?.message || error}`);
  }
}

async function stopRecording() {
  state.recording = false;
  releaseWakeLock();
  if (state.recordSteps < 3) {
    alert('歩数が少なすぎるため保存しません。');
    resetRecordUI();
    return;
  }
  const route = {
    schemaVersion: 3,
    appVersion: APP_VERSION,
    id: `route-${Date.now()}`,
    name: $('routeName').value.trim() || '無題ルート',
    createdAt: new Date().toISOString(),
    durationMs: Date.now() - state.recordStartAt,
    totalSteps: state.recordSteps,
    strideM: STRIDE_M,
    startHeading: state.recordStartHeading,
    stepThreshold: state.detector.threshold,
    events: state.recordEvents,
    turns: detectTurns(state.recordEvents),
    checkpoints: state.recordCheckpoints,
  };
  await putRoute(route);
  alert(`保存しました\n${route.name}\n${route.totalSteps}歩 / 曲がり${route.turns.length} / 写真${route.checkpoints.length}枚`);
  resetRecordUI();
  await refreshRoutes();
}

async function performVisualMatch(descriptor, currentAIEmbedding = null) {
  if (!state.navRoute?.checkpoints?.length) {
    alert('このルートにはチェックポイント画像がありません。');
    return;
  }
  state.navRoute = await ensureCheckpointDescriptors(state.navRoute);
  const currentRel = relHeading(state.navStartHeading, state.heading) ?? 0;
  const candidates = [];
  let routeChanged = false;

  for (const cp of state.navRoute.checkpoints) {
    if (!cp.descriptor?.views) continue;
    const handScore = descriptorSimilarity(descriptor, cp.descriptor);
    let neuralScore = null;
    if (currentAIEmbedding && state.ai.status === 'ready') {
      const before = !!cp.aiEmbedding?.length;
      try { await ensureAIEmbedding(cp); } catch (_) {}
      if (!before && cp.aiEmbedding?.length) routeChanged = true;
      neuralScore = aiSimilarity(currentAIEmbedding, cp.aiEmbedding);
    }
    const imageScore = neuralScore == null ? handScore : 0.78 * neuralScore + 0.22 * handScore;
    const headingScore = typeof cp.relHeading === 'number'
      ? 1 - clamp(angleDiff(cp.relHeading, currentRel) / 100, 0, 1)
      : 0.5;
    const score = 0.93 * imageScore + 0.07 * headingScore;
    candidates.push({ cp, score, imageScore, neuralScore, handScore, headingScore });
  }
  if (routeChanged) await putRoute(state.navRoute);
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0], second = candidates[1];
  if (!best) { alert('比較可能なチェックポイントがありません。'); return; }

  const margin = second ? best.score - second.score : 1;
  const aiUsed = best.neuralScore != null;
  const strongThreshold = aiUsed ? 0.78 : 0.72;
  const acceptThreshold = aiUsed ? 0.69 : 0.63;
  const strong = best.score >= strongThreshold && margin >= 0.025;
  const acceptable = best.score >= acceptThreshold && margin >= 0.012;
  state.navCandidate = acceptable ? best : null;

  $('matchResult').hidden = false;
  $('matchScore').textContent = `一致 ${(best.score * 100).toFixed(0)}% / 候補差 ${(margin * 100).toFixed(1)}pt`;
  $('matchScore').className = `match ${strong ? 'good' : acceptable ? 'weak' : 'bad'}`;
  let detail = `最有力: ${best.cp.steps}歩地点。`;
  if (aiUsed) detail += ` MobileNet ${(best.neuralScore * 100).toFixed(0)}% + 軽量特徴 ${(best.handScore * 100).toFixed(0)}%。`;
  else detail += ` 軽量特徴 ${(best.handScore * 100).toFixed(0)}%。AIモデルは未使用。`;
  if (strong) detail += ' ベイズ位置観測として強く利用できます。';
  else if (acceptable) detail += ' 利用可能ですが、確率分布へ弱めに反映します。';
  else detail += ' 曖昧です。構図を合わせて再撮影してください。';
  if (second) detail += ` 第2候補は${second.cp.steps}歩地点。`;
  $('matchDetail').textContent = detail;
  $('btnApplyMatch').hidden = !acceptable;
}

function applyVisualMatch() {
  if (!state.navCandidate) return;
  const cp = state.navCandidate.cp;
  const strong = state.navCandidate.score >= (state.navCandidate.neuralScore != null ? 0.78 : 0.72);
  if (state.belief) {
    beliefObservePosition(cp.steps, strong ? 1.4 : 2.4, strong ? 7.0 : 3.0);
  } else {
    state.navOffset = cp.steps - state.navRawSteps;
  }
  state.navEstimateStep = cp.steps;
  state.lastVisualCorrection = { at: Date.now(), steps: cp.steps, score: state.navCandidate.score };
  $('visualCorrectionLabel').textContent = `${cp.steps}歩を観測`;
  $('matchDetail').textContent += ' 確率分布へ観測を反映しました。';
  renderNav();
}

function maybeCorrectFromTurn(navEvent) {
  const route = state.navRoute;
  if (!route?.turns?.length) return;
  const delta = signedAngle(state.navTurnAnchorHeading, navEvent.relHeading);
  if (Math.abs(delta) < TURN_THRESHOLD_DEG || navEvent.steps - state.navTurnAnchorStep < TURN_MIN_STEP_GAP) return;

  const navTurn = { steps: navEvent.steps, relHeading: navEvent.relHeading, delta };
  state.navTurnAnchorHeading = navEvent.relHeading;
  state.navTurnAnchorStep = navEvent.steps;

  let matchIndex = -1, bestError = Infinity;
  for (let i = 0; i < route.turns.length; i += 1) {
    const rt = route.turns[i];
    const sameDirection = Math.sign(rt.delta) === Math.sign(navTurn.delta);
    if (!sameDirection) continue;
    const magError = Math.abs(Math.abs(rt.delta) - Math.abs(navTurn.delta));
    if (magError > 70) continue;
    const beliefPenalty = state.belief ? Math.abs(rt.steps - beliefStats().map) * 2.5 : Math.abs(rt.steps - (state.navRawSteps + state.navOffset));
    const error = magError + beliefPenalty;
    if (error < bestError) { bestError = error; matchIndex = i; }
  }
  if (matchIndex < 0) return;
  const target = route.turns[matchIndex].steps;
  if (state.belief) beliefObserveTurn(target, 4.2);
  state.lastTurnCorrection = { at: Date.now(), routeTurn: matchIndex + 1, applied: 0, target };
  state.navMatchedTurnIndex = Math.max(state.navMatchedTurnIndex, matchIndex + 1);
}

function confidenceForNav() {
  const stats = beliefStats();
  if (!state.belief) return { label: '低', cls: 'confidence-low' };
  if (stats.confidence >= 0.64) return { label: '高', cls: 'confidence-high' };
  if (stats.confidence >= 0.36) return { label: '中', cls: 'confidence-medium' };
  return { label: '低', cls: 'confidence-low' };
}

function renderNav() {
  const route = state.navRoute;
  const currentRel = state.navActive ? relHeading(state.navStartHeading, state.heading) : null;
  $('navRawSteps').textContent = String(state.navRawSteps);
  $('navRelativeHeading').textContent = currentRel == null ? '--°' : `${currentRel.toFixed(0)}°`;

  if (!route) {
    $('navSteps').textContent = '0歩'; $('navProgressValue').textContent = '0%'; $('navProgressBar').style.width = '0%';
    $('navRecordedHeading').textContent = '--°'; $('navHeadingDiff').textContent = '--°'; $('nextTurn').textContent = 'ルートを選択してください';
    $('navConfidence').textContent = '--'; $('navConfidence').className = 'metric-value confidence-medium';
    clearCanvas($('navCanvas')); drawBelief(); renderBeliefCandidates(); return;
  }

  if (!state.belief || state.beliefRouteId !== route.id) initBelief(route, 0);
  const stats = beliefStats();
  const estimate = clamp(stats.map, 0, route.totalSteps);
  state.navEstimateStep = estimate;
  const progress = clamp(estimate / Math.max(1, route.totalSteps), 0, 1);
  const expectedHeading = routeHeadingAtStep(route, estimate);
  const headingDiff = currentRel == null ? null : angleDiff(expectedHeading, currentRel);
  const confidence = confidenceForNav();

  $('navSteps').textContent = `${Math.round(estimate)}歩`;
  $('navProgressValue').textContent = `${Math.round(progress * 100)}%`;
  $('navProgressBar').style.width = `${progress * 100}%`;
  $('navRecordedHeading').textContent = `${expectedHeading.toFixed(0)}°`;
  $('navHeadingDiff').textContent = headingDiff == null ? '--°' : `${headingDiff.toFixed(0)}°`;
  $('navConfidence').textContent = confidence.label;
  $('navConfidence').className = `metric-value ${confidence.cls}`;
  $('turnCorrectionLabel').textContent = state.lastTurnCorrection ? `${state.lastTurnCorrection.target}歩turn観測` : 'なし';
  $('visualCorrectionLabel').textContent = state.lastVisualCorrection ? `${state.lastVisualCorrection.steps}歩image観測` : 'なし';

  const turn = nextRouteTurn(route, estimate);
  $('nextTurn').textContent = progress >= 0.98
    ? 'GOAL付近です'
    : turn ? `次の大きな方向変化まで約 ${Math.max(0, Math.round(turn.steps - estimate))} 歩` : 'この先に大きな方向変化はありません';
  drawRoute($('navCanvas'), route, progress);
  drawBelief();
  renderBeliefCandidates();
}

async function loadNavRoute(id) {
  const routes = (await getRoutes()).map(normalizeRoute);
  state.navRoute = routes.find((r) => r.id === id) || null;
  state.navActive = false;
  state.navRawSteps = 0; state.navOffset = 0; state.navEstimateStep = 0; state.navEvents = [];
  state.lastTurnCorrection = null; state.lastVisualCorrection = null; state.navCandidate = null;
  state.navMatchedTurnIndex = 0;
  initBelief(state.navRoute, 0);
  $('matchResult').hidden = true;
  renderNav();
}

async function startNavigation() {
  if (!ensureSensorReadyForRoute()) return;
  if (!state.navRoute) { alert('ルートを選択してください。'); return; }
  state.navActive = true;
  state.navRawSteps = 0; state.navOffset = 0; state.navEstimateStep = 0; state.navEvents = [];
  state.navStartHeading = state.heading;
  state.navTurnAnchorHeading = 0; state.navTurnAnchorStep = 0; state.navMatchedTurnIndex = 0;
  state.lastTurnCorrection = null; state.lastVisualCorrection = null; state.navCandidate = null;
  state.measurementPaused = false;
  initBelief(state.navRoute, 0);
  resetDetectorTransient();
  renderNavButtons(true);
  await requestWakeLock();
  renderNav();
}

function checkpointPairSimilarity(a, b) {
  const ai = aiSimilarity(a.aiEmbedding, b.aiEmbedding);
  if (ai != null) return { score: ai, source: 'ai' };
  if (a.descriptor && b.descriptor) return { score: descriptorSimilarity(a.descriptor, b.descriptor), source: 'descriptor' };
  return { score: 0, source: 'none' };
}

async function prepareRouteEmbeddings(routes) {
  if (state.ai.status !== 'ready') return false;
  let changedAny = false;
  for (const route of routes) {
    let changed = false;
    for (const cp of route.checkpoints || []) {
      if (!cp.aiEmbedding?.length && cp.blob instanceof Blob) {
        try { await ensureAIEmbedding(cp); if (cp.aiEmbedding?.length) changed = true; } catch (_) {}
      }
    }
    if (changed) { route.schemaVersion = Math.max(3, route.schemaVersion || 1); await putRoute(route); changedAny = true; }
  }
  return changedAny;
}

function unionFind(n) {
  const p = Array.from({ length: n }, (_, i) => i);
  const find = (x) => p[x] === x ? x : (p[x] = find(p[x]));
  const join = (a, b) => { a = find(a); b = find(b); if (a !== b) p[b] = a; };
  return { p, find, join };
}

async function buildRouteGraph() {
  const routes = (await getRoutes()).map(normalizeRoute);
  if (!routes.length) {
    state.graph = { nodes: [], edges: [], builtAt: Date.now() };
    renderGraph(); return;
  }
  $('graphStatus').textContent = '構築中…';
  if (state.ai.status === 'ready') await prepareRouteEmbeddings(routes);

  const anchors = [];
  for (const route of routes) {
    const cps = [...(route.checkpoints || [])].sort((a, b) => a.steps - b.steps);
    const routeAnchors = [];

    // Always keep route-specific endpoints; attach nearby photo when available.
    const firstPhoto = cps.find((cp) => cp.steps <= 3) || null;
    const lastPhoto = [...cps].reverse().find((cp) => cp.steps >= route.totalSteps - 3) || null;
    routeAnchors.push({ routeId: route.id, routeName: route.name, step: 0, kind: 'start', cp: firstPhoto, key: `${route.id}:start` });
    for (const cp of cps) {
      if (cp === firstPhoto || cp === lastPhoto) continue;
      routeAnchors.push({ routeId: route.id, routeName: route.name, step: cp.steps, kind: 'checkpoint', cp, key: `${route.id}:${cp.id}` });
    }
    routeAnchors.push({ routeId: route.id, routeName: route.name, step: route.totalSteps, kind: 'goal', cp: lastPhoto, key: `${route.id}:goal` });
    routeAnchors.sort((a, b) => a.step - b.step);
    anchors.push(...routeAnchors);
  }

  const uf = unionFind(anchors.length);
  for (let i = 0; i < anchors.length; i += 1) {
    const a = anchors[i];
    if (!a.cp) continue;
    for (let j = i + 1; j < anchors.length; j += 1) {
      const b = anchors[j];
      if (!b.cp || a.routeId === b.routeId) continue;
      const sim = checkpointPairSimilarity(a.cp, b.cp);
      const threshold = sim.source === 'ai' ? GRAPH_AI_THRESHOLD : GRAPH_DESCRIPTOR_THRESHOLD;
      if (sim.score >= threshold) uf.join(i, j);
    }
  }

  const groups = new Map();
  for (let i = 0; i < anchors.length; i += 1) {
    const root = uf.find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push({ ...anchors[i], anchorIndex: i });
  }

  const nodes = [];
  const anchorToNode = new Map();
  let idx = 1;
  for (const members of groups.values()) {
    const node = {
      id: `N${idx++}`,
      members,
      label: members.length > 1
        ? `共通地点 ${members.map((m) => m.routeName).filter((v, i, a) => a.indexOf(v) === i).join(' / ')}`
        : `${members[0].routeName} ${members[0].kind === 'start' ? 'START' : members[0].kind === 'goal' ? 'GOAL' : `${members[0].step}歩`}`,
    };
    nodes.push(node);
    for (const m of members) anchorToNode.set(m.key, node.id);
  }

  const edges = [];
  for (const route of routes) {
    const ra = anchors.filter((a) => a.routeId === route.id).sort((a, b) => a.step - b.step);
    for (let i = 0; i < ra.length - 1; i += 1) {
      const from = anchorToNode.get(ra[i].key), to = anchorToNode.get(ra[i + 1].key);
      if (!from || !to || from === to) continue;
      edges.push({
        id: `${route.id}:${i}`,
        from, to,
        cost: Math.max(1, ra[i + 1].step - ra[i].step),
        routeId: route.id,
        routeName: route.name,
        fromStep: ra[i].step,
        toStep: ra[i + 1].step,
      });
    }
  }

  state.graph = { nodes, edges, builtAt: Date.now(), ai: state.ai.status === 'ready' };
  renderGraph();
}

function shortestGraphPath(from, to) {
  const { nodes, edges } = state.graph;
  if (!from || !to) return null;
  const dist = new Map(nodes.map((n) => [n.id, Infinity]));
  const prev = new Map();
  const prevEdge = new Map();
  const unvisited = new Set(nodes.map((n) => n.id));
  dist.set(from, 0);

  while (unvisited.size) {
    let u = null, best = Infinity;
    for (const id of unvisited) {
      const d = dist.get(id);
      if (d < best) { best = d; u = id; }
    }
    if (u == null || best === Infinity) break;
    unvisited.delete(u);
    if (u === to) break;
    for (const e of edges) {
      let v = null;
      if (e.from === u) v = e.to;
      else if (e.to === u) v = e.from;
      if (!v || !unvisited.has(v)) continue;
      const alt = best + e.cost;
      if (alt < dist.get(v)) {
        dist.set(v, alt); prev.set(v, u); prevEdge.set(v, e);
      }
    }
  }
  if (!Number.isFinite(dist.get(to))) return null;
  const nodePath = [];
  const edgePath = [];
  let cur = to;
  while (cur) {
    nodePath.push(cur);
    if (cur === from) break;
    edgePath.push(prevEdge.get(cur));
    cur = prev.get(cur);
  }
  nodePath.reverse(); edgePath.reverse();
  return { nodePath, edgePath, cost: dist.get(to) };
}

function renderGraph() {
  const graph = state.graph || { nodes: [], edges: [] };
  if (!$('graphNodeCount')) return;
  $('graphNodeCount').textContent = String(graph.nodes.length || 0);
  $('graphEdgeCount').textContent = String(graph.edges.length || 0);
  $('graphStatus').textContent = graph.builtAt
    ? `${new Date(graph.builtAt).toLocaleTimeString('ja-JP')} 構築。${graph.ai ? 'MobileNet Embedding優先。' : '軽量画像特徴でクラスタリング。'}`
    : '未構築。';

  const fill = (select) => {
    const prev = select.value;
    select.innerHTML = '<option value="">選択</option>';
    for (const node of graph.nodes) {
      const o = document.createElement('option'); o.value = node.id; o.textContent = `${node.id}: ${node.label}`; select.appendChild(o);
    }
    if (graph.nodes.some((n) => n.id === prev)) select.value = prev;
  };
  fill($('graphFrom')); fill($('graphTo'));

  const list = $('graphNodesList'); list.innerHTML = '';
  for (const node of graph.nodes) {
    const el = document.createElement('div'); el.className = 'graph-node';
    const members = node.members.map((m) => `${m.routeName} @ ${m.step}歩${m.cp ? ' 📷' : ''}`).join('<br>');
    el.innerHTML = `<div class="graph-node-title">${node.id}: ${node.label}</div><div class="graph-node-meta">${node.members.length} anchor(s)</div><div class="graph-members">${members}</div>`;
    list.appendChild(el);
  }
  if (!graph.nodes.length) list.innerHTML = '<div class="card"><div class="note">グラフはまだありません。</div></div>';
}

function calculateGraphPathUI() {
  const result = shortestGraphPath($('graphFrom').value, $('graphTo').value);
  if (!result) { $('graphPathResult').textContent = '到達できる経路がありません。共通地点となるチェックポイントを増やしてください。'; return; }
  const segments = result.edgePath.map((e) => `${e.routeName}: ${e.cost}歩`).join(' → ');
  $('graphPathResult').textContent = `推定合計 ${result.cost}歩 ｜ ${result.nodePath.join(' → ')}${segments ? ` ｜ ${segments}` : ''}`;
}

function switchView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $(`view-${name}`).classList.add('active');
  if (name === 'routes') refreshRoutes();
  if (name === 'nav') renderNav();
  if (name === 'graph') renderGraph();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function bindUI() {
  document.querySelectorAll('nav button').forEach((button) => { button.onclick = () => switchView(button.dataset.view); });
  $('btnPermission').onclick = requestSensors;
  $('btnCalibration').onclick = toggleCalibration;
  $('btnResetCalibration').onclick = resetCalibration;
  $('threshold').value = String(state.detector.threshold);
  $('thresholdLabel').textContent = state.detector.threshold.toFixed(2);
  $('threshold').oninput = () => {
    state.detector.threshold = parseFloat($('threshold').value);
    localStorage.setItem('visualRoute.stepThreshold', String(state.detector.threshold));
    $('thresholdLabel').textContent = state.detector.threshold.toFixed(2);
  };
  $('btnStartRecord').onclick = startRecording;
  $('btnCapture').onclick = captureCamera;
  $('btnCloseCamera').onclick = closeCamera;
  $('btnStartNav').onclick = startNavigation;
  $('btnVisualMatch').onclick = () => openCamera('visual-match');
  $('btnApplyMatch').onclick = applyVisualMatch;
  $('navRouteSelect').onchange = () => loadNavRoute($('navRouteSelect').value);
  $('btnResumeMeasurement').onclick = resumeMeasurement;
  $('btnExport').onclick = exportBackup;
  $('btnImport').onclick = () => $('importFile').click();
  $('importFile').onchange = async () => { const file = $('importFile').files?.[0]; if (file) await importBackup(file); $('importFile').value = ''; };
  $('btnLoadAI').onclick = () => loadAIModel().catch(() => {});
  $('btnLoadAIGraph').onclick = () => loadAIModel().then(renderGraph).catch(() => {});
  $('btnBuildGraph').onclick = () => buildRouteGraph().catch((e) => { $('graphStatus').textContent = `構築エラー: ${e?.message || e}`; });
  $('btnGraphPath').onclick = calculateGraphPathUI;
  document.addEventListener('visibilitychange', handleVisibility);
  window.addEventListener('pagehide', () => pauseMeasurement('ページが非表示になりました。戻ったら「計測を再開」を押してください。'));
  window.addEventListener('resize', () => { drawBelief(); });
}

async function init() {
  bindUI();
  if (!window.isSecureContext) $('secureWarning').hidden = false;
  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('./sw.js?v=3.0.0').catch(() => {});
  setInterval(() => { if (state.recording) renderLive(); }, 500);
  try { await openDB(); await refreshRoutes(); } catch (error) { console.error(error); }
  renderAIStatus();
  renderLive(); renderNav(); renderCompassQuality(); renderGraph();
}

init();
})();
