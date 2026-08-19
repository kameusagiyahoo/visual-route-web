(() => {
'use strict';

const APP_VERSION = '5.0.0';
const DB_NAME = 'visual-route-web-v1';
const DB_VERSION = 3;
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
      if (!db.objectStoreNames.contains('evaluations')) {
        db.createObjectStore('evaluations', { keyPath: 'id' });
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


/* ===========================
   V4 overlay
   =========================== */

const V4_HF_CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.0.1';
const V4_PLACE_MODEL = 'Xenova/dinov2-small';
const V4_PLACE_MODEL_LABEL = 'DINOv2-small';
const V4_AUTO_STRONG = 0.86;
const V4_AUTO_VERY_STRONG = 0.92;
const V4_GRAPH_AI_THRESHOLD = 0.90;
const V4_GRAPH_HAND_THRESHOLD = 0.91;

state.gyro = {
  available: false,
  yawRate: 0,
  yaw: 0,
  lastT: null,
  lastRotationAt: 0,
  source: 'compass fallback',
};
state.stepAdaptive = {
  samples: [],
  acceptedPeaks: [],
  intervals: [],
  effectiveThreshold: state.detector.threshold,
  cadenceSpm: null,
  lastAdaptAt: 0,
};
state.recordTurns = [];
state.navTurns = [];
state.turnDetector = { anchorYaw: 0, lastRotatingAt: 0, emittedAt: 0, maxDelta: 0 };
state.autoReloc = {
  enabled: true,
  stream: null,
  timer: null,
  busy: false,
  lastScanAt: 0,
  lastScanSteps: 0,
  lastAppliedAt: 0,
};
state.ai = { status: 'idle', model: null, backend: null, error: null, loading: null, kind: 'dinov2' };
state.graph.stats = { accepted: 0, rejectedMutual: 0, rejectedMargin: 0, rejectedOrder: 0, rejectedConflict: 0 };

function median(values) {
  if (!values?.length) return null;
  const a = [...values].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function rollingMAD(values, center = null) {
  if (!values?.length) return 0;
  const c = center ?? median(values) ?? 0;
  return median(values.map((v) => Math.abs(v - c))) || 0;
}

function currentRelativeHeading() {
  if (state.gyro.available && (state.recording || state.navActive)) return state.gyro.yaw;
  const start = state.recording ? state.recordStartHeading : state.navActive ? state.navStartHeading : null;
  return relHeading(start, state.heading) ?? 0;
}

function resetGyroRouteFrame() {
  state.gyro.yaw = 0;
  state.gyro.lastT = null;
  state.gyro.lastRotationAt = 0;
  state.turnDetector = { anchorYaw: 0, lastRotatingAt: performance.now(), emittedAt: 0, maxDelta: 0 };
}

function updateGyro(event, now) {
  const rr = event.rotationRate;
  const ag = event.accelerationIncludingGravity;
  if (!rr || !ag) {
    state.gyro.available = false;
    state.gyro.source = 'compass fallback';
    return;
  }
  const wx = Number(rr.beta), wy = Number(rr.gamma), wz = Number(rr.alpha);
  const gx = Number(ag.x), gy = Number(ag.y), gz = Number(ag.z);
  if (![wx, wy, wz, gx, gy, gz].every(Number.isFinite)) {
    state.gyro.available = false; return;
  }
  const gnorm = Math.sqrt(gx * gx + gy * gy + gz * gz) || 1;
  // rotationRate axes: beta=x, gamma=y, alpha=z. Project angular velocity onto gravity axis.
  // This approximates rotation around world vertical regardless of whether the phone is flat or upright.
  const yawRate = (wx * gx + wy * gy + wz * gz) / gnorm;
  state.gyro.yawRate = 0.68 * state.gyro.yawRate + 0.32 * yawRate;
  state.gyro.available = true;
  state.gyro.source = 'rotationRate · gravity projection';

  if (state.gyro.lastT != null && (state.recording || state.navActive) && !state.measurementPaused) {
    const dt = clamp((now - state.gyro.lastT) / 1000, 0, 0.12);
    state.gyro.yaw += state.gyro.yawRate * dt;
    if (Math.abs(state.gyro.yawRate) >= 7) state.gyro.lastRotationAt = now;
    processGyroTurn(now);
  }
  state.gyro.lastT = now;
}

function compassCorrectionWeight() {
  if (state.headingSource !== 'webkitCompassHeading') return 0.0015;
  if (typeof state.compassAccuracy !== 'number' || state.compassAccuracy < 0) return 0.0025;
  if (state.compassAccuracy <= 20) return 0.006;
  if (state.compassAccuracy <= 40) return 0.002;
  return 0.0005;
}

function applyCompassDriftCorrection() {
  if (!state.gyro.available || !(state.recording || state.navActive) || Math.abs(state.gyro.yawRate) > 14) return;
  const start = state.recording ? state.recordStartHeading : state.navStartHeading;
  const target = relHeading(start, state.heading);
  if (target == null) return;
  const correction = signedAngle(normDeg(state.gyro.yaw), normDeg(target));
  state.gyro.yaw += correction * compassCorrectionWeight();
}

function processGyroTurn(now) {
  const td = state.turnDetector;
  const delta = state.gyro.yaw - td.anchorYaw;
  td.maxDelta = Math.max(td.maxDelta || 0, Math.abs(delta));
  const settled = now - state.gyro.lastRotationAt >= 220;
  const enoughTurn = Math.abs(delta) >= 36;
  const cooldown = now - td.emittedAt >= 900;
  if (!enoughTurn || !settled || !cooldown) return;

  const turn = {
    t: Date.now(),
    steps: state.recording ? state.recordSteps : state.navRawSteps,
    relHeading: state.gyro.yaw,
    delta,
    source: 'gyro',
  };
  td.anchorYaw = state.gyro.yaw;
  td.maxDelta = 0;
  td.emittedAt = now;

  if (state.recording) {
    state.recordTurns.push(turn);
    $('gyroTurnStatus').textContent = `記録: ${turn.steps}歩 / ${turn.delta > 0 ? '右' : '左'} ${Math.abs(turn.delta).toFixed(0)}°`;
  }
  if (state.navActive) {
    state.navTurns.push(turn);
    matchGyroTurnToRoute(turn);
    $('gyroTurnStatus').textContent = `ナビ: ${turn.steps}歩 / ${turn.delta > 0 ? '右' : '左'} ${Math.abs(turn.delta).toFixed(0)}°`;
  }
}

function matchGyroTurnToRoute(navTurn) {
  const route = state.navRoute;
  if (!route?.turns?.length) return;
  const stats = beliefStats();
  let best = null;
  for (let i = 0; i < route.turns.length; i += 1) {
    const rt = route.turns[i];
    if (Math.sign(rt.delta) !== Math.sign(navTurn.delta)) continue;
    const angleError = Math.abs(Math.abs(rt.delta) - Math.abs(navTurn.delta));
    if (angleError > 65) continue;
    const positionError = Math.abs((rt.steps ?? 0) - stats.map);
    const score = angleError * 0.55 + positionError * 2.2;
    if (!best || score < best.score) best = { index: i, rt, score };
  }
  if (!best) return;
  beliefObserveTurn(best.rt.steps, best.score < 35 ? 5.2 : 3.2);
  state.lastTurnCorrection = { at: Date.now(), routeTurn: best.index + 1, target: best.rt.steps, source: 'gyro' };
}

function updateAdaptiveThreshold(now, value) {
  const a = state.stepAdaptive;
  a.samples.push({ t: now, v: value });
  while (a.samples.length && now - a.samples[0].t > 5000) a.samples.shift();
  if (now - a.lastAdaptAt < 500) return;
  a.lastAdaptAt = now;

  const vals = a.samples.map((x) => x.v);
  const med = median(vals) ?? 0;
  const mad = rollingMAD(vals, med);
  const noiseThreshold = med + Math.max(0.18, mad * 3.0);
  const recentPeaks = a.acceptedPeaks.filter((p) => now - p.t < 12000).map((p) => p.v);
  const gaitPeak = median(recentPeaks);
  const gaitThreshold = gaitPeak ? gaitPeak * 0.52 : state.detector.threshold;
  const baseFloor = state.detector.threshold * 0.58;
  a.effectiveThreshold = clamp(Math.max(baseFloor, noiseThreshold, gaitThreshold), 0.32, 2.8);

  const intervals = a.intervals.filter((x) => now - x.t < 12000).map((x) => x.dt);
  const cadenceMs = median(intervals);
  a.cadenceSpm = cadenceMs ? 60000 / cadenceMs : null;
}

function acceptAdaptivePeak(now, amplitude) {
  const a = state.stepAdaptive;
  const dt = now - state.detector.lastStepAt;
  const recentIntervals = a.intervals.slice(-7).map((x) => x.dt);
  const cadence = median(recentIntervals);
  let minDt = 270, maxDt = 1200;
  if (cadence && cadence >= 300 && cadence <= 1000) {
    minDt = Math.max(260, cadence * 0.52);
    maxDt = Math.min(1300, cadence * 1.75);
  }
  if (dt < minDt) return false;
  // After a long stop, allow re-acquisition immediately instead of rejecting by old cadence.
  if (dt > 2200) a.intervals = [];
  else if (dt > maxDt && cadence && a.intervals.length >= 3) return false;

  // Large arbitrary phone rotation can create acceleration spikes. Require a stronger peak while rotating fast.
  const gyroPenalty = Math.abs(state.gyro.yawRate) > 180 ? 1.22 : 1.0;
  if (amplitude < a.effectiveThreshold * gyroPenalty) return false;

  if (state.detector.lastStepAt > 0 && dt < 1800) a.intervals.push({ t: now, dt });
  a.acceptedPeaks.push({ t: now, v: amplitude });
  while (a.acceptedPeaks.length && now - a.acceptedPeaks[0].t > 15000) a.acceptedPeaks.shift();
  while (a.intervals.length && now - a.intervals[0].t > 15000) a.intervals.shift();
  state.detector.lastStepAt = now;
  countStep();
  return true;
}

function detectPeak(now, value) {
  const d = state.detector;
  const p2 = d.p2, p1 = d.p1;
  const threshold = state.stepAdaptive.effectiveThreshold || d.threshold;
  const isPeak = p1 > p2 && p1 >= value && p1 >= threshold;
  if (isPeak) acceptAdaptivePeak(now, p1);
  d.p2 = p1; d.p1 = value;
}

function onMotion(event) {
  const now = performance.now();
  const raw = calculateDynamicAcceleration(event);
  if (raw == null) return;
  state.detector.smooth = 0.70 * state.detector.smooth + 0.30 * raw;
  state.dynamicAcc = state.detector.smooth;
  state.motionActive = true;
  setDot('motionDot', 'ok');
  $('motionStatus').textContent = 'DeviceMotion: 受信中';

  updateGyro(event, now);
  updateAdaptiveThreshold(now, state.detector.smooth);

  if (state.calibrating && !state.measurementPaused) state.calibrationSamples.push({ t: now, v: state.detector.smooth });
  if (!state.measurementPaused) detectPeak(now, state.detector.smooth);
  renderLive();
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
  applyCompassDriftCorrection();
  renderCompassQuality(); renderLive(); renderNav();
}

function countStep() {
  if (state.calibrating) return;
  const h = currentRelativeHeading();
  if (state.recording) {
    state.recordSteps += 1;
    state.recordEvents.push({
      t: Date.now(), steps: state.recordSteps, heading: state.heading,
      relHeading: h, gyroRelHeading: h,
      orientation: { ...state.orientation },
      cadenceSpm: state.stepAdaptive.cadenceSpm,
      effectiveThreshold: state.stepAdaptive.effectiveThreshold,
    });
  }
  if (state.navActive) {
    state.navRawSteps += 1;
    const ev = { t: Date.now(), steps: state.navRawSteps, relHeading: h, gyroRelHeading: h, heading: state.heading };
    state.navEvents.push(ev);
    beliefPredictOneStep();
    beliefObserveHeading(h);
  }
  renderLive(); renderNav();
}

function detectTurns(events) {
  if (!events?.length) return [];
  const out = [];
  let anchor = events[0].gyroRelHeading ?? events[0].relHeading ?? 0;
  let anchorStep = events[0].steps ?? 0;
  for (const ev of events) {
    const current = ev.gyroRelHeading ?? ev.relHeading ?? 0;
    const delta = current - anchor;
    if (Math.abs(delta) >= 38 && (ev.steps ?? 0) - anchorStep >= 1) {
      out.push({ steps: ev.steps, relHeading: current, delta, source: ev.gyroRelHeading != null ? 'gyro' : 'orientation' });
      anchor = current; anchorStep = ev.steps ?? anchorStep;
    }
  }
  return out;
}

function resetAdaptiveWalkingState() {
  state.stepAdaptive.samples = [];
  state.stepAdaptive.acceptedPeaks = [];
  state.stepAdaptive.intervals = [];
  state.stepAdaptive.effectiveThreshold = state.detector.threshold;
  state.stepAdaptive.cadenceSpm = null;
  state.stepAdaptive.lastAdaptAt = 0;
}

async function startRecording() {
  if (!ensureSensorReadyForRoute()) return;
  if (state.calibrating) return;
  state.recording = true;
  state.recordSteps = 0;
  state.recordStartAt = Date.now();
  state.recordStartHeading = state.heading;
  state.recordEvents = [{ t: Date.now(), steps: 0, heading: state.heading, relHeading: 0, gyroRelHeading: 0, orientation: { ...state.orientation } }];
  state.recordCheckpoints = [];
  state.recordTurns = [];
  state.measurementPaused = false;
  resetDetectorTransient(); resetAdaptiveWalkingState(); resetGyroRouteFrame();
  $('recordButtons').innerHTML = `
    <button id="btnStopRecord" class="btn danger">STOP 保存</button>
    <button id="btnCheckpoint" class="btn secondary">現在地点を写真で記録</button>`;
  $('btnStopRecord').onclick = stopRecording;
  $('btnCheckpoint').onclick = () => openCamera('checkpoint');
  await requestWakeLock(); renderLive();
}

async function stopRecording() {
  state.recording = false; releaseWakeLock();
  if (state.recordSteps < 3) { alert('歩数が少なすぎるため保存しません。'); resetRecordUI(); return; }
  const turns = state.recordTurns.length ? state.recordTurns : detectTurns(state.recordEvents);
  const route = {
    schemaVersion: 4, appVersion: APP_VERSION,
    id: `route-${Date.now()}`,
    name: $('routeName').value.trim() || '無題ルート',
    createdAt: new Date().toISOString(), durationMs: Date.now() - state.recordStartAt,
    totalSteps: state.recordSteps, strideM: STRIDE_M,
    startHeading: state.recordStartHeading, stepThreshold: state.detector.threshold,
    adaptiveStep: true, headingMode: state.gyro.available ? 'gyro-gravity-projection+compass-drift' : 'compass-fallback',
    events: state.recordEvents, turns, checkpoints: state.recordCheckpoints,
  };
  await putRoute(route);
  alert(`保存しました\n${route.name}\n${route.totalSteps}歩 / Gyro曲がり${route.turns.length} / 写真${route.checkpoints.length}枚`);
  resetRecordUI(); await refreshRoutes();
}

function renderLive() {
  $('recordSteps').textContent = state.recordSteps;
  $('dynamicAcc').textContent = state.dynamicAcc.toFixed(2);
  $('absoluteHeading').textContent = state.heading == null ? '--°' : `${state.heading.toFixed(0)}°`;
  const relative = state.recording ? currentRelativeHeading() : null;
  $('relativeHeading').textContent = relative == null ? '--°' : `${relative.toFixed(0)}°`;
  $('compassAccuracy').textContent = typeof state.compassAccuracy === 'number' && state.compassAccuracy >= 0 ? `±${state.compassAccuracy.toFixed(0)}°` : '--';
  ['alpha', 'beta', 'gamma'].forEach((key) => { const v = state.orientation[key]; $(key).textContent = typeof v === 'number' ? `${v.toFixed(1)}°` : '--°'; });
  $('effectiveThreshold').textContent = `${(state.stepAdaptive.effectiveThreshold || state.detector.threshold).toFixed(2)} m/s²`;
  $('cadenceStatus').textContent = state.stepAdaptive.cadenceSpm ? `${state.stepAdaptive.cadenceSpm.toFixed(0)} steps/min` : '-- steps/min';
  $('gyroRate').textContent = state.gyro.available ? `${state.gyro.yawRate.toFixed(1)} °/s` : 'rotationRate unavailable';
  $('gyroYaw').textContent = state.gyro.available && (state.recording || state.navActive) ? `${state.gyro.yaw.toFixed(1)}°` : '--°';
  if (!state.gyro.available) $('gyroTurnStatus').textContent = 'rotationRateなし → 方角fallback';
  if (state.recording) $('elapsed').textContent = fmtTime(Date.now() - state.recordStartAt);
}

function flattenFeatureOutput(output) {
  let data = null, dims = null;
  if (output?.data && ArrayBuffer.isView(output.data)) { data = Array.from(output.data); dims = output.dims || output.shape || null; }
  else if (typeof output?.tolist === 'function') {
    const nested = output.tolist();
    const flat = [];
    const walk = (x) => Array.isArray(x) ? x.forEach(walk) : flat.push(Number(x));
    walk(nested); data = flat; dims = output.dims || output.shape || null;
  } else if (Array.isArray(output)) {
    const flat = []; const walk = (x) => Array.isArray(x) ? x.forEach(walk) : flat.push(Number(x)); walk(output); data = flat;
  }
  if (!data?.length) return null;
  // DINO can expose token embeddings. Use the CLS token instead of flattening all patch tokens.
  if (dims?.length >= 3 && Number(dims[dims.length - 1]) > 0) {
    data = data.slice(0, Number(dims[dims.length - 1]));
  }
  let norm = Math.sqrt(data.reduce((s, v) => s + v * v, 0)) || 1;
  return data.map((v) => Number((v / norm).toFixed(6)));
}

async function loadAIModel() {
  if (state.ai.status === 'ready') return state.ai.model;
  if (state.ai.loading) return state.ai.loading;
  state.ai.status = 'loading'; renderAIStatus();
  state.ai.loading = (async () => {
    try {
      const hf = await import(V4_HF_CDN);
      let extractor = null;
      if (navigator.gpu) {
        try {
          extractor = await hf.pipeline('image-feature-extraction', V4_PLACE_MODEL, { device: 'webgpu', dtype: 'fp16' });
          state.ai.backend = 'WebGPU / fp16';
        } catch (webgpuError) {
          console.warn('WebGPU DINOv2 load failed, fallback to WASM', webgpuError);
        }
      }
      if (!extractor) {
        extractor = await hf.pipeline('image-feature-extraction', V4_PLACE_MODEL, { dtype: 'q8' });
        state.ai.backend = 'WASM / q8';
      }
      state.ai.model = extractor;
      state.ai.status = 'ready'; state.ai.error = null; state.ai.kind = 'dinov2';
      renderAIStatus(); renderTechCapabilities();
      return extractor;
    } catch (error) {
      state.ai.status = 'error'; state.ai.error = error?.message || String(error);
      renderAIStatus(); renderTechCapabilities(); throw error;
    } finally { state.ai.loading = null; }
  })();
  return state.ai.loading;
}

function renderAIStatus() {
  if (!$('aiStatus')) return;
  $('webgpuStatus').textContent = navigator.gpu ? '利用可能' : '未検出';
  if (state.ai.status === 'ready') {
    $('aiStatus').textContent = `${V4_PLACE_MODEL_LABEL} 準備完了`;
    $('aiStatus').className = 'ai-ready'; $('aiBackend').textContent = state.ai.backend || '--';
    $('btnLoadAI').textContent = 'DINOv2読み込み済み'; $('btnLoadAI').disabled = true;
    if ($('btnLoadAIGraph')) { $('btnLoadAIGraph').textContent = 'DINOv2読み込み済み'; $('btnLoadAIGraph').disabled = true; }
  } else if (state.ai.status === 'loading') {
    $('aiStatus').textContent = 'DINOv2をダウンロード/初期化中…'; $('aiStatus').className = 'ai-loading'; $('aiBackend').textContent = '--';
  } else if (state.ai.status === 'error') {
    $('aiStatus').textContent = `失敗: ${state.ai.error || 'unknown'}（軽量特徴へfallback）`; $('aiStatus').className = 'ai-error'; $('aiBackend').textContent = '--';
  } else {
    $('aiStatus').textContent = '未読み込み（軽量画像特徴で動作）'; $('aiStatus').className = ''; $('aiBackend').textContent = '--';
  }
}

async function extractPlaceEmbedding(blob) {
  if (state.ai.status !== 'ready' || !state.ai.model || !(blob instanceof Blob)) return null;
  const url = URL.createObjectURL(blob);
  try {
    const output = await state.ai.model(url);
    return flattenFeatureOutput(output);
  } finally { URL.revokeObjectURL(url); }
}

async function ensureAIEmbedding(cp) {
  if (cp.placeEmbedding?.model === V4_PLACE_MODEL && cp.placeEmbedding?.values?.length) return cp.placeEmbedding.values;
  if (state.ai.status !== 'ready' || !(cp.blob instanceof Blob)) return null;
  const values = await extractPlaceEmbedding(cp.blob);
  if (values?.length) cp.placeEmbedding = { model: V4_PLACE_MODEL, values };
  return values;
}

function checkpointPlaceEmbedding(cp) {
  return cp?.placeEmbedding?.model === V4_PLACE_MODEL ? cp.placeEmbedding.values : null;
}

async function captureVideoFrameFrom(video, maxWidth = 640) {
  if (!video || video.videoWidth < 2 || video.videoHeight < 2) throw new Error('カメラ映像がまだ準備できていません');
  const scale = Math.min(1, maxWidth / video.videoWidth);
  const width = Math.max(1, Math.round(video.videoWidth * scale));
  const height = Math.max(1, Math.round(video.videoHeight * scale));
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  canvas.getContext('2d').drawImage(video, 0, 0, width, height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.74));
  const descriptor = computeDescriptorV2(canvas);
  const placeEmbedding = state.ai.status === 'ready' ? await extractPlaceEmbedding(blob) : null;
  return { blob, descriptor, placeEmbedding };
}

async function captureVideoFrame() {
  const video = $('video');
  if (video.videoWidth < 2 || video.videoHeight < 2) await sleep(250);
  return captureVideoFrameFrom(video, 720);
}

async function captureCamera() {
  try {
    const snap = await captureVideoFrame();
    if (state.cameraMode === 'checkpoint') {
      if (!state.recording) { closeCamera(); return; }
      const quality = imageQualityMessage(snap.descriptor);
      if (!quality.ok && !confirm(`画像品質に注意: ${quality.text}\nそれでも保存しますか？`)) { closeCamera(); return; }
      state.recordCheckpoints.push({
        id: `cp-${Date.now()}`, steps: state.recordSteps, heading: state.heading,
        relHeading: currentRelativeHeading(), blob: snap.blob, descriptor: snap.descriptor,
        placeEmbedding: snap.placeEmbedding ? { model: V4_PLACE_MODEL, values: snap.placeEmbedding } : null,
      });
      closeCamera(); alert(`${state.recordSteps}歩地点の画像を保存しました。${snap.placeEmbedding ? '\nDINOv2 Embeddingも保存しました。' : ''}`);
    } else {
      closeCamera(); await performVisualMatch(snap.descriptor, snap.placeEmbedding, { manual: true });
    }
  } catch (error) { alert(`撮影処理に失敗しました: ${error?.message || error}`); }
}

function visualCandidateScores(route, descriptor, placeEmbedding) {
  const currentRel = currentRelativeHeading();
  const prior = state.belief;
  const out = [];
  for (const cp of route.checkpoints || []) {
    if (!cp.descriptor?.views) continue;
    const hand = descriptorSimilarity(descriptor, cp.descriptor);
    const stored = checkpointPlaceEmbedding(cp);
    const neural = placeEmbedding && stored ? aiSimilarity(placeEmbedding, stored) : null;
    const image = neural == null ? hand : 0.86 * neural + 0.14 * hand;
    const heading = typeof cp.relHeading === 'number' ? 1 - clamp(angleDiff(cp.relHeading, currentRel) / 110, 0, 1) : 0.5;
    const priorP = prior?.length ? prior[clamp(Math.round(cp.steps), 0, prior.length - 1)] : 0;
    // Strongly visual, weakly temporal. This still allows recovery after a large dead-reckoning error.
    const priorScore = priorP > 0 ? clamp(Math.log1p(priorP * prior.length * 3) / Math.log(4), 0, 1) : 0;
    const score = 0.90 * image + 0.05 * heading + 0.05 * priorScore;
    out.push({ cp, score, imageScore: image, neuralScore: neural, handScore: hand, priorScore });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

async function ensureRoutePlaceEmbeddings(route) {
  if (state.ai.status !== 'ready') return false;
  let changed = false;
  for (const cp of route.checkpoints || []) {
    if (!checkpointPlaceEmbedding(cp) && cp.blob instanceof Blob) {
      try { const x = await ensureAIEmbedding(cp); if (x?.length) changed = true; } catch (_) {}
    }
  }
  if (changed) await putRoute(route);
  return changed;
}

async function performVisualMatch(descriptor, currentPlaceEmbedding = null, options = {}) {
  if (!state.navRoute?.checkpoints?.length) {
    if (options.manual) alert('このルートにはチェックポイント画像がありません。');
    return null;
  }
  state.navRoute = await ensureCheckpointDescriptors(state.navRoute);
  if (state.ai.status === 'ready') await ensureRoutePlaceEmbeddings(state.navRoute);
  const candidates = visualCandidateScores(state.navRoute, descriptor, currentPlaceEmbedding);
  const best = candidates[0], second = candidates[1];
  if (!best) return null;
  const margin = second ? best.score - second.score : 1;
  const aiUsed = best.neuralScore != null;
  const strong = best.score >= (aiUsed ? 0.82 : 0.75) && margin >= (aiUsed ? 0.025 : 0.035);
  const acceptable = best.score >= (aiUsed ? 0.72 : 0.65) && margin >= 0.015;
  const result = { ...best, second, margin, strong, acceptable, aiUsed };

  if (options.manual) {
    state.navCandidate = acceptable ? result : null;
    $('matchResult').hidden = false;
    $('matchScore').textContent = `一致 ${(best.score * 100).toFixed(0)}% / 候補差 ${(margin * 100).toFixed(1)}pt`;
    $('matchScore').className = `match ${strong ? 'good' : acceptable ? 'weak' : 'bad'}`;
    let detail = `最有力: ${best.cp.steps}歩地点。`;
    if (aiUsed) detail += ` DINOv2 ${(best.neuralScore * 100).toFixed(0)}% + fallback特徴 ${(best.handScore * 100).toFixed(0)}%。`;
    else detail += ` fallback特徴 ${(best.handScore * 100).toFixed(0)}%。DINOv2未使用。`;
    detail += strong ? ' 強い観測です。' : acceptable ? ' 弱めの観測として利用可能です。' : ' 曖昧なので自動補正しません。';
    if (second) detail += ` 第2候補: ${second.cp.steps}歩。`;
    $('matchDetail').textContent = detail;
    $('btnApplyMatch').hidden = !acceptable;
  }
  return result;
}

function applyVisualMatch() {
  if (!state.navCandidate) return;
  const r = state.navCandidate;
  beliefObservePosition(r.cp.steps, r.strong ? 1.25 : 2.4, r.strong ? 8.0 : 3.0);
  state.lastVisualCorrection = { at: Date.now(), steps: r.cp.steps, score: r.score, source: r.aiUsed ? 'DINOv2' : 'fallback' };
  $('visualCorrectionLabel').textContent = `${r.cp.steps}歩 image観測`;
  $('matchDetail').textContent += ' 確率分布へ反映しました。'; renderNav();
}

async function startAutoRelocCamera() {
  if (!state.navActive || !$('autoRelocEnabled').checked || !state.navRoute?.checkpoints?.length) return;
  stopAutoRelocCamera();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 640 }, height: { ideal: 360 } }, audio: false });
    state.autoReloc.stream = stream; $('autoVideo').srcObject = stream;
    state.autoReloc.enabled = true; state.autoReloc.lastScanAt = 0; state.autoReloc.lastScanSteps = -999;
    $('autoRelocStatus').textContent = 'カメラ稼働中。低頻度で自動照合します。';
    scheduleAutoReloc();
  } catch (error) {
    state.autoReloc.enabled = false;
    $('autoRelocStatus').textContent = `自動カメラ開始失敗: ${error?.message || error}`;
  }
}

function stopAutoRelocCamera() {
  if (state.autoReloc.timer) { clearTimeout(state.autoReloc.timer); state.autoReloc.timer = null; }
  if (state.autoReloc.stream) { state.autoReloc.stream.getTracks().forEach((t) => t.stop()); state.autoReloc.stream = null; }
  if ($('autoVideo')) $('autoVideo').srcObject = null;
  state.autoReloc.busy = false;
}

function scheduleAutoReloc() {
  if (!state.navActive || !state.autoReloc.stream) return;
  const sec = Number($('autoRelocInterval').value) || 8;
  state.autoReloc.timer = setTimeout(runAutoRelocalization, sec * 1000);
}

async function runAutoRelocalization(force = false) {
  if (state.autoReloc.timer) { clearTimeout(state.autoReloc.timer); state.autoReloc.timer = null; }
  if (!state.navActive || !state.autoReloc.stream || state.measurementPaused || document.visibilityState !== 'visible') { scheduleAutoReloc(); return; }
  if (state.autoReloc.busy) { scheduleAutoReloc(); return; }
  const minSteps = Number($('autoRelocMinSteps').value) || 4;
  if (!force && Math.abs(state.navRawSteps - state.autoReloc.lastScanSteps) < minSteps) { scheduleAutoReloc(); return; }
  state.autoReloc.busy = true;
  try {
    $('autoRelocStatus').textContent = '画像照合中…';
    const snap = await captureVideoFrameFrom($('autoVideo'), state.ai.status === 'ready' ? 448 : 320);
    state.autoReloc.lastScanAt = Date.now(); state.autoReloc.lastScanSteps = state.navRawSteps;
    const result = await performVisualMatch(snap.descriptor, snap.placeEmbedding, { manual: false });
    if (!result) { $('autoRelocStatus').textContent = '比較候補なし'; return; }
    const stats = beliefStats();
    const distance = Math.abs(result.cp.steps - stats.map);
    const farJump = distance > Math.max(10, state.navRoute.totalSteps * 0.22);
    const uniqueEnough = result.margin >= (result.aiUsed ? 0.035 : 0.05);
    const autoAccept = result.strong && uniqueEnough && (!farJump || (result.score >= V4_AUTO_VERY_STRONG && result.margin >= 0.06));
    $('autoRelocLast').textContent = `最終照合: ${result.cp.steps}歩 ${(result.score * 100).toFixed(0)}% / Δ${(result.margin * 100).toFixed(1)}pt`;
    if (autoAccept) {
      beliefObservePosition(result.cp.steps, result.aiUsed ? 1.3 : 1.8, result.aiUsed ? 6.5 : 4.0);
      state.lastVisualCorrection = { at: Date.now(), steps: result.cp.steps, score: result.score, source: result.aiUsed ? 'auto DINOv2' : 'auto fallback' };
      state.autoReloc.lastAppliedAt = Date.now();
      $('autoRelocStatus').textContent = `自動補正: ${result.cp.steps}歩地点`;
      renderNav();
    } else {
      $('autoRelocStatus').textContent = farJump ? '候補は遠距離ジャンプのため保留' : '候補の一意性不足 → 補正保留';
    }
  } catch (error) {
    $('autoRelocStatus').textContent = `自動照合失敗: ${error?.message || error}`;
  } finally { state.autoReloc.busy = false; scheduleAutoReloc(); }
}

async function manualVisualReloc() {
  if (state.autoReloc.stream && $('autoVideo').videoWidth > 2) {
    await runAutoRelocalization(true);
    return;
  }
  openCamera('visual-match');
}

async function startNavigation() {
  if (!ensureSensorReadyForRoute()) return;
  if (!state.navRoute) { alert('ルートを選択してください。'); return; }
  state.navActive = true; state.navRawSteps = 0; state.navOffset = 0; state.navEstimateStep = 0; state.navEvents = []; state.navTurns = [];
  state.navStartHeading = state.heading; state.navMatchedTurnIndex = 0; state.lastTurnCorrection = null; state.lastVisualCorrection = null; state.navCandidate = null;
  state.measurementPaused = false;
  resetDetectorTransient(); resetAdaptiveWalkingState(); resetGyroRouteFrame(); initBelief(state.navRoute, 0);
  renderNavButtons(true); await requestWakeLock(); renderNav();
  if ($('autoRelocEnabled').checked && state.navRoute.checkpoints?.length) await startAutoRelocCamera();
}

function stopNavigation() {
  state.navActive = false; releaseWakeLock(); stopAutoRelocCamera(); renderNavButtons(false); renderNav();
  $('autoRelocStatus').textContent = 'ナビ停止。';
}

function pauseMeasurement(reason) {
  if (!(state.recording || state.navActive || state.calibrating)) return;
  state.measurementPaused = true; releaseWakeLock();
  if (state.navActive) stopAutoRelocCamera();
  $('resumeReason').textContent = reason; $('resumeBanner').hidden = false;
}

async function resumeMeasurement() {
  state.measurementPaused = false; resetDetectorTransient(); state.gyro.lastT = null;
  $('resumeBanner').hidden = true; await requestWakeLock();
  if (state.navActive && $('autoRelocEnabled').checked) await startAutoRelocCamera();
}

function routeHeadingAtStep(route, step) {
  if (!route?.events?.length) return 0;
  let best = route.events[0], err = Infinity;
  for (const ev of route.events) {
    const e = Math.abs((ev.steps ?? 0) - step);
    if (e < err) { err = e; best = ev; }
  }
  return best?.gyroRelHeading ?? best?.relHeading ?? 0;
}

function renderNav() {
  const route = state.navRoute;
  const currentRel = state.navActive ? currentRelativeHeading() : null;
  $('navRawSteps').textContent = String(state.navRawSteps);
  $('navRelativeHeading').textContent = currentRel == null ? '--°' : `${currentRel.toFixed(0)}°`;
  if (!route) {
    $('navSteps').textContent = '0歩'; $('navProgressValue').textContent = '0%'; $('navProgressBar').style.width = '0%';
    $('navRecordedHeading').textContent = '--°'; $('navHeadingDiff').textContent = '--°'; $('nextTurn').textContent = 'ルートを選択してください';
    $('navConfidence').textContent = '--'; $('navConfidence').className = 'metric-value confidence-medium'; clearCanvas($('navCanvas')); drawBelief(); renderBeliefCandidates(); return;
  }
  if (!state.belief || state.beliefRouteId !== route.id) initBelief(route, 0);
  const stats = beliefStats(); const estimate = clamp(stats.map, 0, route.totalSteps); state.navEstimateStep = estimate;
  const progress = clamp(estimate / Math.max(1, route.totalSteps), 0, 1);
  const expectedHeading = routeHeadingAtStep(route, estimate);
  const headingDiff = currentRel == null ? null : angleDiff(expectedHeading, currentRel);
  const confidence = confidenceForNav();
  $('navSteps').textContent = `${Math.round(estimate)}歩`; $('navProgressValue').textContent = `${Math.round(progress * 100)}%`; $('navProgressBar').style.width = `${progress * 100}%`;
  $('navRecordedHeading').textContent = `${expectedHeading.toFixed(0)}°`; $('navHeadingDiff').textContent = headingDiff == null ? '--°' : `${headingDiff.toFixed(0)}°`;
  $('navConfidence').textContent = confidence.label; $('navConfidence').className = `metric-value ${confidence.cls}`;
  $('turnCorrectionLabel').textContent = state.lastTurnCorrection ? `${state.lastTurnCorrection.target}歩 gyro観測` : 'なし';
  $('visualCorrectionLabel').textContent = state.lastVisualCorrection ? `${state.lastVisualCorrection.steps}歩 ${state.lastVisualCorrection.source}` : 'なし';
  const turn = nextRouteTurn(route, estimate);
  $('nextTurn').textContent = progress >= 0.98 ? 'GOAL付近です' : turn ? `次の大きな方向変化まで約 ${Math.max(0, Math.round(turn.steps - estimate))} 歩` : 'この先に大きな方向変化はありません';
  drawRoute($('navCanvas'), route, progress); drawBelief(); renderBeliefCandidates(); renderLive();
}

function checkpointPairSimilarity(a, b) {
  const ai = aiSimilarity(checkpointPlaceEmbedding(a), checkpointPlaceEmbedding(b));
  if (ai != null) return { score: ai, source: 'dinov2' };
  if (a.descriptor && b.descriptor) return { score: descriptorSimilarity(a.descriptor, b.descriptor), source: 'descriptor' };
  return { score: 0, source: 'none' };
}

function bestAndSecond(candidates) {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  return { best: sorted[0] || null, second: sorted[1] || null };
}

function safeUnionFind(items) {
  const parent = items.map((_, i) => i);
  const routes = items.map((x) => new Set([x.routeId]));
  const find = (x) => parent[x] === x ? x : (parent[x] = find(parent[x]));
  const join = (a, b) => {
    a = find(a); b = find(b); if (a === b) return true;
    for (const r of routes[a]) if (routes[b].has(r)) return false;
    parent[b] = a; for (const r of routes[b]) routes[a].add(r); return true;
  };
  return { parent, find, join };
}

function enforceOrderConsistency(matches) {
  if (matches.length <= 1) return { keep: matches, rejected: [] };
  const sorted = [...matches].sort((a, b) => a.a.step - b.a.step);
  const first = sorted[0], last = sorted[sorted.length - 1];
  const increasing = last.b.step >= first.b.step;
  const keep = [], rejected = [];
  let prev = increasing ? -Infinity : Infinity;
  for (const m of sorted) {
    const ok = increasing ? m.b.step > prev : m.b.step < prev;
    if (ok) { keep.push(m); prev = m.b.step; } else rejected.push(m);
  }
  return { keep, rejected };
}

async function buildRouteGraph() {
  const routes = (await getRoutes()).map(normalizeRoute);
  const stats = { accepted: 0, rejectedMutual: 0, rejectedMargin: 0, rejectedOrder: 0, rejectedConflict: 0 };
  if (!routes.length) { state.graph = { nodes: [], edges: [], builtAt: Date.now(), stats }; renderGraph(); return; }
  $('graphStatus').textContent = '構築中…';
  if (state.ai.status === 'ready') {
    for (const route of routes) await ensureRoutePlaceEmbeddings(route);
  }

  const anchors = [];
  for (const route of routes) {
    const cps = [...(route.checkpoints || [])].sort((a, b) => a.steps - b.steps);
    const ra = [];
    const first = cps.find((cp) => cp.steps <= 3) || null;
    const last = [...cps].reverse().find((cp) => cp.steps >= route.totalSteps - 3) || null;
    ra.push({ routeId: route.id, routeName: route.name, step: 0, kind: 'start', cp: first, key: `${route.id}:start` });
    for (const cp of cps) if (cp !== first && cp !== last) ra.push({ routeId: route.id, routeName: route.name, step: cp.steps, kind: 'checkpoint', cp, key: `${route.id}:${cp.id}` });
    ra.push({ routeId: route.id, routeName: route.name, step: route.totalSteps, kind: 'goal', cp: last, key: `${route.id}:goal` });
    anchors.push(...ra.sort((a, b) => a.step - b.step));
  }

  const acceptedPairs = [];
  for (let ri = 0; ri < routes.length; ri += 1) {
    for (let rj = ri + 1; rj < routes.length; rj += 1) {
      const A = anchors.filter((x) => x.routeId === routes[ri].id && x.cp);
      const B = anchors.filter((x) => x.routeId === routes[rj].id && x.cp);
      if (!A.length || !B.length) continue;
      const matrix = [];
      for (let i = 0; i < A.length; i += 1) for (let j = 0; j < B.length; j += 1) {
        const sim = checkpointPairSimilarity(A[i].cp, B[j].cp);
        matrix.push({ i, j, a: A[i], b: B[j], score: sim.score, source: sim.source });
      }
      const provisional = [];
      for (let i = 0; i < A.length; i += 1) {
        const ai = bestAndSecond(matrix.filter((m) => m.i === i));
        if (!ai.best) continue;
        const bj = bestAndSecond(matrix.filter((m) => m.j === ai.best.j));
        if (!bj.best || bj.best.i !== i) { stats.rejectedMutual += 1; continue; }
        const threshold = ai.best.source === 'dinov2' ? V4_GRAPH_AI_THRESHOLD : V4_GRAPH_HAND_THRESHOLD;
        const marginA = ai.best.score - (ai.second?.score ?? 0);
        const marginB = bj.best.score - (bj.second?.score ?? 0);
        const highSingle = ai.best.score >= threshold + 0.045;
        const marginsOK = marginA >= 0.025 && marginB >= 0.025;
        if (ai.best.score < threshold || (!marginsOK && !highSingle)) { stats.rejectedMargin += 1; continue; }
        provisional.push(ai.best);
      }
      const ordered = enforceOrderConsistency(provisional);
      stats.rejectedOrder += ordered.rejected.length;
      acceptedPairs.push(...ordered.keep);
    }
  }

  const uf = safeUnionFind(anchors);
  const anchorIndex = new Map(anchors.map((a, i) => [a.key, i]));
  for (const m of acceptedPairs.sort((a, b) => b.score - a.score)) {
    const ia = anchorIndex.get(m.a.key), ib = anchorIndex.get(m.b.key);
    if (!uf.join(ia, ib)) { stats.rejectedConflict += 1; continue; }
    stats.accepted += 1;
  }

  const groups = new Map();
  anchors.forEach((a, i) => { const root = uf.find(i); if (!groups.has(root)) groups.set(root, []); groups.get(root).push({ ...a, anchorIndex: i }); });
  const nodes = [], anchorToNode = new Map(); let n = 1;
  for (const members of groups.values()) {
    const node = { id: `N${n++}`, members, label: members.length > 1 ? `共通地点 ${[...new Set(members.map((m) => m.routeName))].join(' / ')}` : `${members[0].routeName} ${members[0].kind === 'start' ? 'START' : members[0].kind === 'goal' ? 'GOAL' : `${members[0].step}歩`}` };
    nodes.push(node); members.forEach((m) => anchorToNode.set(m.key, node.id));
  }
  const edges = [];
  for (const route of routes) {
    const ra = anchors.filter((a) => a.routeId === route.id).sort((a, b) => a.step - b.step);
    for (let i = 0; i < ra.length - 1; i += 1) {
      const from = anchorToNode.get(ra[i].key), to = anchorToNode.get(ra[i + 1].key);
      if (!from || !to || from === to) continue;
      edges.push({ id: `${route.id}:${i}`, from, to, cost: Math.max(1, ra[i + 1].step - ra[i].step), routeId: route.id, routeName: route.name, fromStep: ra[i].step, toStep: ra[i + 1].step });
    }
  }
  state.graph = { nodes, edges, builtAt: Date.now(), ai: state.ai.status === 'ready', stats };
  renderGraph();
}

function renderGraph() {
  const graph = state.graph || { nodes: [], edges: [], stats: {} };
  $('graphNodeCount').textContent = String(graph.nodes.length || 0); $('graphEdgeCount').textContent = String(graph.edges.length || 0);
  $('graphStatus').textContent = graph.builtAt ? `${new Date(graph.builtAt).toLocaleTimeString('ja-JP')} 構築。${graph.ai ? 'DINOv2優先。' : '軽量特徴。'} MNN+順序整合で誤結合を抑制。` : '未構築。';
  const s = graph.stats || {};
  $('graphAccepted').textContent = String(s.accepted || 0); $('graphRejectedMutual').textContent = String(s.rejectedMutual || 0); $('graphRejectedMargin').textContent = String(s.rejectedMargin || 0); $('graphRejectedOrder').textContent = String(s.rejectedOrder || 0); $('graphRejectedConflict').textContent = String(s.rejectedConflict || 0);
  const fill = (select) => { const prev = select.value; select.innerHTML = '<option value="">選択</option>'; for (const node of graph.nodes) { const o = document.createElement('option'); o.value = node.id; o.textContent = `${node.id}: ${node.label}`; select.appendChild(o); } if (graph.nodes.some((x) => x.id === prev)) select.value = prev; };
  fill($('graphFrom')); fill($('graphTo'));
  const list = $('graphNodesList'); list.innerHTML = '';
  for (const node of graph.nodes) {
    const el = document.createElement('div'); el.className = 'graph-node';
    const members = node.members.map((m) => `${m.routeName} @ ${m.step}歩${m.cp ? ' 📷' : ''}`).join('<br>');
    el.innerHTML = `<div class="graph-node-title">${node.id}: ${node.label}</div><div class="graph-node-meta">${node.members.length} anchor(s)</div><div class="graph-members">${members}</div>`; list.appendChild(el);
  }
  if (!graph.nodes.length) list.innerHTML = '<div class="card"><div class="note">グラフはまだありません。</div></div>';
}

function renderTechCapabilities() {
  const set = (id, ok, yes, no = '未対応') => { if (!$(id)) return; $(id).textContent = ok ? yes : no; $(id).className = ok ? 'cap-ok' : 'cap-warn'; };
  set('capSecure', window.isSecureContext, 'HTTPS / secure');
  set('capMotion', 'DeviceMotionEvent' in window, '利用可能');
  set('capGyro', state.gyro.available, state.gyro.source, '未確認（センサー許可後に判定）');
  set('capCamera', !!navigator.mediaDevices?.getUserMedia, '利用可能');
  set('capIndexedDB', 'indexedDB' in window, '利用可能');
  set('capWakeLock', 'wakeLock' in navigator, '利用可能');
  set('capWebGPU', !!navigator.gpu, '利用可能');
  if ($('capAIBackend')) $('capAIBackend').textContent = state.ai.status === 'ready' ? `${V4_PLACE_MODEL_LABEL} / ${state.ai.backend}` : state.ai.status === 'error' ? 'AI fallback中' : '未読み込み';
}

function switchView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $(`view-${name}`).classList.add('active');
  if (name === 'routes') refreshRoutes();
  if (name === 'nav') renderNav();
  if (name === 'graph') renderGraph();
  if (name === 'tech') renderTechCapabilities();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function bindUI() {
  document.querySelectorAll('nav button').forEach((button) => { button.onclick = () => switchView(button.dataset.view); });
  $('btnPermission').onclick = requestSensors;
  $('btnCalibration').onclick = toggleCalibration; $('btnResetCalibration').onclick = resetCalibration;
  $('threshold').value = String(state.detector.threshold); $('thresholdLabel').textContent = state.detector.threshold.toFixed(2);
  $('threshold').oninput = () => { state.detector.threshold = parseFloat($('threshold').value); localStorage.setItem('visualRoute.stepThreshold', String(state.detector.threshold)); $('thresholdLabel').textContent = state.detector.threshold.toFixed(2); state.stepAdaptive.effectiveThreshold = state.detector.threshold; };
  $('btnStartRecord').onclick = startRecording; $('btnCapture').onclick = captureCamera; $('btnCloseCamera').onclick = closeCamera;
  $('btnStartNav').onclick = startNavigation; $('btnVisualMatch').onclick = manualVisualReloc; $('btnApplyMatch').onclick = applyVisualMatch;
  $('navRouteSelect').onchange = () => loadNavRoute($('navRouteSelect').value);
  $('btnResumeMeasurement').onclick = resumeMeasurement;
  $('btnExport').onclick = exportBackup; $('btnImport').onclick = () => $('importFile').click();
  $('importFile').onchange = async () => { const file = $('importFile').files?.[0]; if (file) await importBackup(file); $('importFile').value = ''; };
  $('btnLoadAI').onclick = () => loadAIModel().catch(() => {}); $('btnLoadAIGraph').onclick = () => loadAIModel().then(renderGraph).catch(() => {});
  $('btnBuildGraph').onclick = () => buildRouteGraph().catch((e) => { $('graphStatus').textContent = `構築エラー: ${e?.message || e}`; }); $('btnGraphPath').onclick = calculateGraphPathUI;
  $('autoRelocEnabled').onchange = async () => { if (!state.navActive) return; if ($('autoRelocEnabled').checked) await startAutoRelocCamera(); else { stopAutoRelocCamera(); $('autoRelocStatus').textContent = '自動補正OFF'; } };
  document.addEventListener('visibilitychange', handleVisibility);
  window.addEventListener('pagehide', () => pauseMeasurement('ページが非表示になりました。戻ったら「計測を再開」を押してください。'));
  window.addEventListener('resize', () => drawBelief());
}

async function init() {
  bindUI();
  if (!window.isSecureContext) $('secureWarning').hidden = false;
  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('./sw.js?v=4.0.0').catch(() => {});
  setInterval(() => { if (state.recording) renderLive(); }, 500);
  try { await openDB(); await refreshRoutes(); } catch (error) { console.error(error); }
  renderAIStatus(); renderLive(); renderNav(); renderCompassQuality(); renderGraph(); renderTechCapabilities();
}

/* V4 consistency hotfixes */
function normalizeRoute(route) {
  const r = { ...route };
  r.schemaVersion = r.schemaVersion || 1;
  r.strideM = r.strideM || STRIDE_M;
  r.events = Array.isArray(r.events) ? r.events.map((e) => ({ ...e })) : [];
  const firstHeading = r.startHeading ?? r.events.find((e) => typeof e.heading === 'number')?.heading ?? 0;
  for (const e of r.events) {
    if (typeof e.relHeading !== 'number') e.relHeading = typeof e.heading === 'number' ? signedAngle(firstHeading, e.heading) : 0;
    if (typeof e.gyroRelHeading !== 'number' && r.schemaVersion >= 4) e.gyroRelHeading = e.relHeading;
  }
  // Preserve real-time gyro turns recorded by v4; reconstruct only for older schemas or missing data.
  r.turns = Array.isArray(route.turns) && route.turns.length && r.schemaVersion >= 4
    ? route.turns.map((t) => ({ ...t }))
    : detectTurns(r.events);
  r.checkpoints = Array.isArray(r.checkpoints) ? r.checkpoints.map((cp) => {
    const next = { ...cp };
    if (typeof next.relHeading !== 'number') next.relHeading = typeof next.heading === 'number' ? signedAngle(firstHeading, next.heading) : null;
    return next;
  }) : [];
  return r;
}

async function toggleCalibration() {
  if (!state.sensorGranted) { alert('先に「センサーを許可」を押してください。'); return; }
  if (state.recording || state.navActive) { alert('ルート記録/ナビ中はキャリブレーションできません。'); return; }
  if (!state.calibrating) {
    state.calibrating = true; state.calibrationSamples = []; resetDetectorTransient(); resetAdaptiveWalkingState();
    $('btnCalibration').textContent = '20歩終わった → 調整する';
    $('calibrationResult').textContent = '普段の持ち方で、正確に20歩歩いてからこのボタンをもう一度押してください。';
    await requestWakeLock(); return;
  }
  state.calibrating = false; releaseWakeLock();
  if (state.calibrationSamples.length < 30) {
    $('calibrationResult').textContent = 'データが少なすぎます。もう一度20歩歩いてください。';
    $('btnCalibration').textContent = '20歩キャリブレーション'; return;
  }
  const result = chooseThresholdForTarget(state.calibrationSamples, 20);
  state.detector.threshold = result.threshold; state.stepAdaptive.effectiveThreshold = result.threshold;
  localStorage.setItem('visualRoute.stepThreshold', String(result.threshold));
  $('threshold').value = String(result.threshold); $('thresholdLabel').textContent = result.threshold.toFixed(2);
  $('calibrationResult').textContent = `基準値: ${result.threshold.toFixed(2)} m/s²（キャリブレーションデータでは${result.count}歩）。歩行中はV4適応しきい値が自動追従します。`;
  $('btnCalibration').textContent = '20歩キャリブレーション'; resetDetectorTransient(); resetAdaptiveWalkingState(); renderLive();
}

function resetCalibration() {
  state.detector.threshold = DEFAULT_THRESHOLD; state.stepAdaptive.effectiveThreshold = DEFAULT_THRESHOLD;
  localStorage.removeItem('visualRoute.stepThreshold'); $('threshold').value = String(DEFAULT_THRESHOLD); $('thresholdLabel').textContent = DEFAULT_THRESHOLD.toFixed(2);
  $('calibrationResult').textContent = '基準値を初期値へ戻しました。'; resetAdaptiveWalkingState(); renderLive();
}

function renderNavButtons(active) {
  $('navButtons').innerHTML = active
    ? '<button id="btnStopNav" class="btn danger">ナビ停止</button><button id="btnVisualMatch" class="btn secondary">画像で現在地点を補正</button>'
    : '<button id="btnStartNav" class="btn">同じSTART地点からナビ開始</button><button id="btnVisualMatch" class="btn secondary">画像で現在地点を補正</button>';
  if (active) $('btnStopNav').onclick = stopNavigation; else $('btnStartNav').onclick = startNavigation;
  // Manual mode opens the aiming view even when automatic relocalization is active.
  $('btnVisualMatch').onclick = () => openCamera('visual-match');
}



/* ===========================
   V5 research / evaluation overlay
   =========================== */
const V5_DEFAULT_PARAMS = { stepAdvance: 1.10, headingSigma: 38, visualSigma: 1.8 };
const V5_SEQUENCE_MAX = 4;
const V5_LOST_HOLD_MS = 10000;
const V5_RECENT_VISUAL_MS = 14000;
const V5_GT_GOAL_TOL = 3;

function loadV5Tuning() {
  try {
    const x = JSON.parse(localStorage.getItem('visualRoute.v5Tuning') || '{}');
    return { global: { ...V5_DEFAULT_PARAMS, ...(x.global || {}) }, routes: x.routes || {}, samples: x.samples || 0 };
  } catch (_) { return { global: { ...V5_DEFAULT_PARAMS }, routes: {}, samples: 0 }; }
}
function saveV5Tuning() { localStorage.setItem('visualRoute.v5Tuning', JSON.stringify(state.tuning)); }
function activeV5Params(routeId = state.navRoute?.id) { return { ...state.tuning.global, ...(routeId && state.tuning.routes?.[routeId] ? state.tuning.routes[routeId] : {}) }; }

state.tuning = loadV5Tuning();
state.localization = { status: 'IDLE', changedAt: Date.now(), badSince: null, reason: 'ナビ開始待ち' };
state.sequence = { history: [] };
state.evalSession = null;
state.diagnostics = { startedAt: Date.now(), motionTimes: [], aiInferenceMs: [], autoScans: 0, autoAccepted: 0, autoRejected: 0, sequenceFrames: 0, cameraErrors: 0, battery: null };
state.recordVision = { stream: null, busy: false, lastStep: -999, count: 0 };
state.graph.stats = { ...(state.graph.stats || {}), rejectedContext: 0 };

async function putEvaluation(record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('evaluations', 'readwrite'); tx.objectStore('evaluations').put(record);
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
}
async function getEvaluations() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('evaluations', 'readonly'); const req = tx.objectStore('evaluations').getAll();
    req.onsuccess = () => resolve(req.result || []); req.onerror = () => reject(req.error);
  });
}
async function deleteEvaluations() {
  const db = await openDB();
  return new Promise((resolve, reject) => { const tx = db.transaction('evaluations','readwrite'); tx.objectStore('evaluations').clear(); tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error); });
}

function percentile(values, q) {
  if (!values.length) return null;
  const a = [...values].sort((x,y)=>x-y); const pos=(a.length-1)*q; const lo=Math.floor(pos), hi=Math.ceil(pos);
  return lo===hi ? a[lo] : a[lo] + (a[hi]-a[lo])*(pos-lo);
}
function mean(values) { return values.length ? values.reduce((a,b)=>a+b,0)/values.length : null; }

function beliefPredictOneStep() {
  const b = state.belief; if (!b) return;
  const m = clamp(activeV5Params().stepAdvance, 0.65, 1.45);
  let core;
  if (m <= 1) core = [[0, 1-m], [1, m], [2, 0]];
  else core = [[0,0], [1,2-m], [2,m-1]];
  const noise = [[0,.08],[1,.76],[2,.14],[3,.02]];
  const weights = new Map();
  for (const [d,w] of core) weights.set(d,(weights.get(d)||0)+w*.82);
  for (const [d,w] of noise) weights.set(d,(weights.get(d)||0)+w*.18);
  const next = new Float64Array(b.length);
  for (let i=0;i<b.length;i++) for (const [d,w] of weights) next[Math.min(b.length-1,i+d)] += b[i]*w;
  state.belief = normalizeProbabilities(next);
}

function beliefObserveHeading(currentRelHeading) {
  if (!state.belief || !state.navRoute || currentRelHeading == null) return;
  const sigma = activeV5Params().headingSigma;
  for (let i=0;i<state.belief.length;i++) {
    const expected=routeHeadingAtStep(state.navRoute,i); const d=angleDiff(expected,currentRelHeading);
    state.belief[i] *= 0.08 + 0.92*gaussian(d,sigma);
  }
  normalizeProbabilities(state.belief);
}

function sequenceAdjustedCandidates(baseCandidates) {
  const history = state.sequence.history.slice(-V5_SEQUENCE_MAX + 1);
  if (!history.length) return baseCandidates.map((c)=>({...c, sequenceSupport:null, singleScore:c.score, sequenceScore:c.score}));
  const currentRaw = state.navRawSteps;
  const adjusted = baseCandidates.map((c) => {
    let weighted=0, wsum=0;
    history.forEach((h,idx) => {
      const ageWeight=(idx+1)/history.length; const expectedDelta=Math.max(0,currentRaw-h.rawStep);
      let bestSupport=0;
      for (const p of h.candidates) {
        const routeDelta=c.cp.steps-p.cp.steps;
        const dirPenalty=routeDelta < -2 ? 0.12 : 1;
        const sigma=Math.max(3,expectedDelta*.6+2);
        const continuity=gaussian(routeDelta-expectedDelta,sigma)*dirPenalty;
        bestSupport=Math.max(bestSupport,p.score*continuity);
      }
      weighted += bestSupport*ageWeight; wsum += ageWeight;
    });
    const support=wsum?weighted/wsum:0;
    const sequenceScore=0.68*c.score+0.32*support;
    return {...c,singleScore:c.score,sequenceSupport:support,sequenceScore,score:sequenceScore};
  });
  return adjusted.sort((a,b)=>b.score-a.score);
}
function pushSequenceObservation(baseCandidates) {
  state.sequence.history.push({ t:Date.now(), rawStep:state.navRawSteps, candidates:baseCandidates.slice(0,6).map((x)=>({cp:x.cp,score:x.score})) });
  while(state.sequence.history.length>V5_SEQUENCE_MAX) state.sequence.history.shift();
  state.diagnostics.sequenceFrames += 1;
  if ($('sequenceStatus')) $('sequenceStatus').textContent=`画像系列: ${state.sequence.history.length} / ${V5_SEQUENCE_MAX} frames`;
}

async function performVisualMatch(descriptor, currentPlaceEmbedding = null, options = {}) {
  if (!state.navRoute?.checkpoints?.length) { if(options.manual) alert('このルートにはチェックポイント画像がありません。'); return null; }
  state.navRoute=await ensureCheckpointDescriptors(state.navRoute); if(state.ai.status==='ready') await ensureRoutePlaceEmbeddings(state.navRoute);
  const base=visualCandidateScores(state.navRoute,descriptor,currentPlaceEmbedding);
  const candidates=sequenceAdjustedCandidates(base); const best=candidates[0], second=candidates[1];
  pushSequenceObservation(base);
  if(!best) return null;
  const margin=second?best.score-second.score:1; const aiUsed=best.neuralScore!=null;
  const sequenceStrong=(best.sequenceSupport??0)>=0.68 && state.sequence.history.length>=2;
  const strong=best.score>=(aiUsed?0.80:0.74) && margin>=(sequenceStrong?0.015:(aiUsed?0.025:0.035));
  const acceptable=best.score>=(aiUsed?0.70:0.64) && margin>=0.012;
  const result={...best,second,margin,strong,acceptable,aiUsed,sequenceStrong,sequenceLength:state.sequence.history.length};
  if(options.manual){
    state.navCandidate=acceptable?result:null; $('matchResult').hidden=false;
    $('matchScore').textContent=`系列一致 ${(best.score*100).toFixed(0)}% / Δ${(margin*100).toFixed(1)}pt`;
    $('matchScore').className=`match ${strong?'good':acceptable?'weak':'bad'}`;
    let detail=`最有力: ${best.cp.steps}歩地点。単画像 ${(best.singleScore*100).toFixed(0)}%`;
    if(best.sequenceSupport!=null) detail+=` + 系列support ${(best.sequenceSupport*100).toFixed(0)}%`;
    detail+=aiUsed?` / DINOv2 ${(best.neuralScore*100).toFixed(0)}%。`:' / fallback画像特徴。';
    detail+=strong?' 強い観測です。':acceptable?' 弱めの観測です。':' 曖昧です。';
    if(second) detail+=` 第2候補: ${second.cp.steps}歩。`;
    $('matchDetail').textContent=detail; $('btnApplyMatch').hidden=!acceptable;
  }
  return result;
}

function updateLocalizationState() {
  if(!state.navActive || !state.navRoute){ state.localization.status='IDLE'; state.localization.reason='ナビ開始待ち'; renderLocalizationState(); return; }
  const now=Date.now(); const stats=beliefStats(); const elapsed=now-(state.evalSession?.startedAt||now);
  const recentVisual=state.lastVisualCorrection && now-state.lastVisualCorrection.at<V5_RECENT_VISUAL_MS;
  const currentRel=currentRelativeHeading(); const headingErr=angleDiff(routeHeadingAtStep(state.navRoute,stats.map),currentRel);
  const good=stats.confidence>=0.46 || (recentVisual && (state.lastVisualCorrection.score||0)>=0.78);
  const bad=stats.confidence<0.22 && !recentVisual && headingErr>55;
  let next=state.localization.status, reason='';
  if(elapsed<3500){ next='LOCALIZING'; reason='初期位置分布を収束中'; state.localization.badSince=null; }
  else if(good){ next='LOCALIZED'; reason=recentVisual?'画像観測 + 確率分布が整合':'確率分布が集中'; state.localization.badSince=null; }
  else if(bad){
    if(!state.localization.badSince) state.localization.badSince=now;
    if(now-state.localization.badSince>=V5_LOST_HOLD_MS){ next='LOST'; reason='低信頼 + 方角不整合が継続'; }
    else { next='UNCERTAIN'; reason='低信頼が継続中'; }
  } else { next='UNCERTAIN'; reason=recentVisual?'画像観測はあるが分布が広い':'確率分布が広い'; state.localization.badSince=null; }
  if(next!==state.localization.status){
    state.localization.status=next; state.localization.changedAt=now;
    if(next==='LOST' && state.evalSession){ state.evalSession.lostTransitions=(state.evalSession.lostTransitions||0)+1; state.evalSession.events.push({t:now,type:'LOST'}); }
    if(next==='LOCALIZED' && state.evalSession) state.evalSession.events.push({t:now,type:'LOCALIZED'});
  }
  state.localization.reason=reason; renderLocalizationState();
}
function renderLocalizationState(){
  if(!$('localizationState')) return; const s=state.localization.status;
  $('localizationState').textContent=s; $('localizationState').className=`loc-state ${s.toLowerCase()}`;
  $('localizationReason').textContent=state.localization.reason||'--';
  $('localizationTimer').textContent=state.navActive?`状態継続 ${fmtTime(Date.now()-state.localization.changedAt)}`:'--';
}

function confidenceForNav(){
  const stats=beliefStats(); if(!state.belief) return {label:'低',cls:'confidence-low'};
  if(state.localization.status==='LOST') return {label:'LOST',cls:'confidence-low'};
  if(stats.confidence>=0.64) return {label:'高',cls:'confidence-high'};
  if(stats.confidence>=0.36) return {label:'中',cls:'confidence-medium'};
  return {label:'低',cls:'confidence-low'};
}

function populateGroundTruthAnchors(){
  const select=$('gtAnchorSelect'); if(!select) return; select.innerHTML='<option value="">地点を選択</option>';
  const r=state.navRoute; if(!r) return;
  const anchors=[{step:0,label:'START'}];
  (r.turns||[]).forEach((t,i)=>anchors.push({step:t.steps,label:`Turn ${i+1} (${t.steps}歩)`}));
  (r.checkpoints||[]).forEach((cp,i)=>anchors.push({step:cp.steps,label:`Photo ${i+1} (${cp.steps}歩)`}));
  anchors.push({step:r.totalSteps,label:`GOAL (${r.totalSteps}歩)`});
  const seen=new Set(); anchors.sort((a,b)=>a.step-b.step).forEach(a=>{const k=Math.round(a.step);if(seen.has(k))return;seen.add(k);const o=document.createElement('option');o.value=String(k);o.textContent=a.label;select.appendChild(o);});
}

async function markGroundTruth(){
  if(!state.navActive||!state.navRoute||!state.evalSession){alert('ナビ中に記録してください。');return;}
  const fromInput=$('gtStepInput').value; const fromSelect=$('gtAnchorSelect').value; const truth=Number(fromInput!==''?fromInput:fromSelect);
  if(!Number.isFinite(truth)){alert('Ground Truth地点を選ぶか、歩数地点を入力してください。');return;}
  const stats=beliefStats(); const map=stats.map; const currentRel=currentRelativeHeading(); const headingError=angleDiff(routeHeadingAtStep(state.navRoute,truth),currentRel);
  const recentVisual=state.lastVisualCorrection && Date.now()-state.lastVisualCorrection.at<16000 ? state.lastVisualCorrection : null;
  const sample={t:Date.now(),truthStep:truth,mapStep:map,meanStep:stats.mean,rawStep:state.navRawSteps,confidence:stats.confidence,status:state.localization.status,absError:Math.abs(map-truth),headingError,recentVisual:recentVisual?{steps:recentVisual.steps,score:recentVisual.score,source:recentVisual.source,error:Math.abs(recentVisual.steps-truth)}:null};
  state.evalSession.groundTruth.push(sample);
  $('gtLastResult').textContent=`GT ${truth}歩 / 推定 ${map}歩 / 誤差 ${sample.absError.toFixed(1)}歩 / ${sample.status}`;
  $('gtStepInput').value=''; await saveCurrentEvalSession(false); await renderEvaluation();
}

function newEvalSession(){
  return {id:`eval-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,routeId:state.navRoute.id,routeName:state.navRoute.name,startedAt:Date.now(),endedAt:null,groundTruth:[],lostTransitions:0,events:[],visual:{attempts:0,accepted:0,rejected:0},diagnosticsStart:{...state.diagnostics},params:{...activeV5Params(state.navRoute.id)}};
}
async function saveCurrentEvalSession(finalize=false){
  if(!state.evalSession)return; if(finalize)state.evalSession.endedAt=Date.now();
  state.evalSession.visual={attempts:state.diagnostics.autoScans,accepted:state.diagnostics.autoAccepted,rejected:state.diagnostics.autoRejected};
  state.evalSession.runtime={aiInferenceMs:[...state.diagnostics.aiInferenceMs],motionHz:diagnosticMotionHz(),sequenceFrames:state.diagnostics.sequenceFrames};
  await putEvaluation(state.evalSession);
}

function startNavigationV5Session(){ state.evalSession=newEvalSession(); state.localization={status:'LOCALIZING',changedAt:Date.now(),badSince:null,reason:'初期位置分布を収束中'}; state.sequence.history=[]; state.diagnostics.startedAt=Date.now(); state.diagnostics.autoScans=0;state.diagnostics.autoAccepted=0;state.diagnostics.autoRejected=0;state.diagnostics.sequenceFrames=0; populateGroundTruthAnchors(); }

async function startNavigation(){
  if(!ensureSensorReadyForRoute())return; if(!state.navRoute){alert('ルートを選択してください。');return;}
  state.navActive=true;state.navRawSteps=0;state.navOffset=0;state.navEstimateStep=0;state.navEvents=[];state.navTurns=[];
  state.navStartHeading=state.heading;state.navMatchedTurnIndex=0;state.lastTurnCorrection=null;state.lastVisualCorrection=null;state.navCandidate=null;state.measurementPaused=false;
  resetDetectorTransient();resetAdaptiveWalkingState();resetGyroRouteFrame();initBelief(state.navRoute,0);startNavigationV5Session();
  renderNavButtons(true);await requestWakeLock();renderNav();if($('autoRelocEnabled').checked&&state.navRoute.checkpoints?.length)await startAutoRelocCamera();
}
async function stopNavigation(){
  if(state.evalSession)await saveCurrentEvalSession(true); state.navActive=false;releaseWakeLock();stopAutoRelocCamera();renderNavButtons(false);renderNav();$('autoRelocStatus').textContent='ナビ停止。';state.localization={status:'IDLE',changedAt:Date.now(),badSince:null,reason:'ナビ停止'};renderLocalizationState();await renderEvaluation();
}

function applyVisualMatch(){
  if(!state.navCandidate)return;const r=state.navCandidate;const sigma=activeV5Params().visualSigma*(r.strong?.8:1.35);beliefObservePosition(r.cp.steps,sigma,r.strong?8:3);
  state.lastVisualCorrection={at:Date.now(),steps:r.cp.steps,score:r.score,source:r.aiUsed?'DINOv2 sequence':'fallback sequence'};
  $('visualCorrectionLabel').textContent=`${r.cp.steps}歩 image系列観測`;$('matchDetail').textContent+=' 確率分布へ反映しました。';updateLocalizationState();renderNav();
}

function scheduleAutoReloc(){
  if(!state.navActive||!state.autoReloc.stream)return;const requested=Number($('autoRelocInterval').value)||8;const sec=state.localization.status==='LOST'?Math.min(3,requested):requested;state.autoReloc.timer=setTimeout(runAutoRelocalization,sec*1000);
}
async function runAutoRelocalization(force=false){
  if(state.autoReloc.timer){clearTimeout(state.autoReloc.timer);state.autoReloc.timer=null;}
  if(!state.navActive||!state.autoReloc.stream||state.measurementPaused||document.visibilityState!=='visible'){scheduleAutoReloc();return;}
  if(state.autoReloc.busy){scheduleAutoReloc();return;}
  const minSteps=state.localization.status==='LOST'?0:(Number($('autoRelocMinSteps').value)||4);
  if(!force&&Math.abs(state.navRawSteps-state.autoReloc.lastScanSteps)<minSteps){scheduleAutoReloc();return;}
  state.autoReloc.busy=true;state.diagnostics.autoScans+=1;
  try{
    $('autoRelocStatus').textContent=state.localization.status==='LOST'?'LOST: 再ローカライズ探索中…':'画像系列を照合中…';
    const snap=await captureVideoFrameFrom($('autoVideo'),state.ai.status==='ready'?448:320);state.autoReloc.lastScanAt=Date.now();state.autoReloc.lastScanSteps=state.navRawSteps;
    const result=await performVisualMatch(snap.descriptor,snap.placeEmbedding,{manual:false});if(!result){state.diagnostics.autoRejected+=1;$('autoRelocStatus').textContent='比較候補なし';return;}
    const stats=beliefStats();const distance=Math.abs(result.cp.steps-stats.map);const farJump=distance>Math.max(10,state.navRoute.totalSteps*.22);const unique=result.margin>=(result.sequenceStrong?.018:(result.aiUsed?.035:.05));
    const recovery=state.localization.status==='LOST'&&result.strong&&(result.sequenceStrong||result.score>=.88);
    const autoAccept=result.strong&&unique&&(!farJump||recovery||(result.score>=V4_AUTO_VERY_STRONG&&result.margin>=.06));
    $('autoRelocLast').textContent=`最終系列: ${result.cp.steps}歩 ${(result.score*100).toFixed(0)}% / Δ${(result.margin*100).toFixed(1)}pt / ${result.sequenceLength}f`;
    if(autoAccept){const sigma=activeV5Params().visualSigma*(recovery?.7:1);beliefObservePosition(result.cp.steps,sigma,result.sequenceStrong?7.5:6);state.lastVisualCorrection={at:Date.now(),steps:result.cp.steps,score:result.score,source:result.aiUsed?'auto DINOv2 sequence':'auto fallback sequence'};state.autoReloc.lastAppliedAt=Date.now();state.diagnostics.autoAccepted+=1;$('autoRelocStatus').textContent=`自動補正: ${result.cp.steps}歩地点${recovery?' (LOST recovery)':''}`;updateLocalizationState();renderNav();}
    else{state.diagnostics.autoRejected+=1;$('autoRelocStatus').textContent=farJump&&!recovery?'遠距離ジャンプ候補 → 保留':'系列一意性不足 → 保留';}
  }catch(error){state.diagnostics.autoRejected+=1;state.diagnostics.cameraErrors+=1;$('autoRelocStatus').textContent=`自動照合失敗: ${error?.message||error}`;}finally{state.autoReloc.busy=false;scheduleAutoReloc();}
}

async function startRecordVisionCamera(){
  if(!$('recordAutoKeyframes')?.checked||!navigator.mediaDevices?.getUserMedia)return;
  stopRecordVisionCamera();try{const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:640},height:{ideal:360}},audio:false});state.recordVision.stream=stream;$('recordVisionVideo').srcObject=stream;state.recordVision.lastStep=-999;state.recordVision.count=0;$('recordVisionStatus').textContent='自動キーフレーム取得中';setTimeout(()=>{if(state.recording)captureRecordKeyframe(true)},900);}catch(e){$('recordVisionStatus').textContent=`カメラ開始失敗: ${e?.message||e}`;}}
function stopRecordVisionCamera(){if(state.recordVision.stream){state.recordVision.stream.getTracks().forEach(t=>t.stop());state.recordVision.stream=null;}if($('recordVisionVideo'))$('recordVisionVideo').srcObject=null;state.recordVision.busy=false;}
async function captureRecordKeyframe(force=false){
  if(!state.recording||!state.recordVision.stream||state.recordVision.busy)return;const interval=Number($('recordKeyframeSteps').value)||5;if(!force&&state.recordSteps-state.recordVision.lastStep<interval)return;state.recordVision.busy=true;
  try{const snap=await captureVideoFrameFrom($('recordVisionVideo'),state.ai.status==='ready'?448:320);const q=imageQualityMessage(snap.descriptor);if(!q.ok&&!force)return;state.recordCheckpoints.push({id:`auto-cp-${Date.now()}`,steps:state.recordSteps,heading:state.heading,relHeading:currentRelativeHeading(),blob:snap.blob,descriptor:snap.descriptor,placeEmbedding:snap.placeEmbedding?{model:V4_PLACE_MODEL,values:snap.placeEmbedding}:null,autoKeyframe:true});state.recordVision.lastStep=state.recordSteps;state.recordVision.count+=1;$('recordVisionCount').textContent=`自動キーフレーム: ${state.recordVision.count}`;}catch(e){$('recordVisionStatus').textContent=`自動撮影失敗: ${e?.message||e}`;}finally{state.recordVision.busy=false;}}

async function startRecording(){
  if(!ensureSensorReadyForRoute())return;if(state.calibrating)return;state.recording=true;state.recordSteps=0;state.recordStartAt=Date.now();state.recordStartHeading=state.heading;
  state.recordEvents=[{t:Date.now(),steps:0,heading:state.heading,relHeading:0,gyroRelHeading:0,orientation:{...state.orientation}}];state.recordCheckpoints=[];state.recordTurns=[];state.measurementPaused=false;resetDetectorTransient();resetAdaptiveWalkingState();resetGyroRouteFrame();
  $('recordButtons').innerHTML='<button id="btnStopRecord" class="btn danger">STOP 保存</button><button id="btnCheckpoint" class="btn secondary">現在地点を写真で記録</button>';$('btnStopRecord').onclick=stopRecording;$('btnCheckpoint').onclick=()=>openCamera('checkpoint');await requestWakeLock();renderLive();if($('recordAutoKeyframes').checked)await startRecordVisionCamera();
}
async function stopRecording(){
  if(state.recording&&state.recordVision.stream&&state.recordSteps-state.recordVision.lastStep>=2)await captureRecordKeyframe(true);state.recording=false;releaseWakeLock();stopRecordVisionCamera();if(state.recordSteps<3){alert('歩数が少なすぎるため保存しません。');resetRecordUI();return;}
  const turns=state.recordTurns.length?state.recordTurns:detectTurns(state.recordEvents);const route={schemaVersion:5,appVersion:APP_VERSION,id:`route-${Date.now()}`,name:$('routeName').value.trim()||'無題ルート',createdAt:new Date().toISOString(),durationMs:Date.now()-state.recordStartAt,totalSteps:state.recordSteps,strideM:STRIDE_M,startHeading:state.recordStartHeading,stepThreshold:state.detector.threshold,adaptiveStep:true,headingMode:state.gyro.available?'gyro-gravity-projection+compass-drift':'compass-fallback',autoKeyframes:state.recordVision.count,events:state.recordEvents,turns,checkpoints:state.recordCheckpoints};await putRoute(route);alert(`保存しました\n${route.name}\n${route.totalSteps}歩 / 曲がり${route.turns.length} / 画像${route.checkpoints.length}枚`);resetRecordUI();await refreshRoutes();
}

function countStep(){
  if(state.calibrating)return;const h=currentRelativeHeading();if(state.recording){state.recordSteps+=1;state.recordEvents.push({t:Date.now(),steps:state.recordSteps,heading:state.heading,relHeading:h,gyroRelHeading:h,orientation:{...state.orientation},cadenceSpm:state.stepAdaptive.cadenceSpm,effectiveThreshold:state.stepAdaptive.effectiveThreshold});if($('recordAutoKeyframes')?.checked)captureRecordKeyframe(false);}
  if(state.navActive){state.navRawSteps+=1;const ev={t:Date.now(),steps:state.navRawSteps,relHeading:h,gyroRelHeading:h,heading:state.heading};state.navEvents.push(ev);beliefPredictOneStep();beliefObserveHeading(h);}
  renderLive();renderNav();
}

function diagnosticMotionHz(){const now=performance.now();const a=state.diagnostics.motionTimes.filter(t=>now-t<5000);return a.length>=2?(a.length-1)/((a[a.length-1]-a[0])/1000):0;}
function onMotion(event){
  const now=performance.now();state.diagnostics.motionTimes.push(now);while(state.diagnostics.motionTimes.length&&now-state.diagnostics.motionTimes[0]>7000)state.diagnostics.motionTimes.shift();
  const raw=calculateDynamicAcceleration(event);if(raw==null)return;state.detector.smooth=.70*state.detector.smooth+.30*raw;state.dynamicAcc=state.detector.smooth;state.motionActive=true;setDot('motionDot','ok');$('motionStatus').textContent='DeviceMotion: 受信中';updateGyro(event,now);updateAdaptiveThreshold(now,state.detector.smooth);if(state.calibrating&&!state.measurementPaused)state.calibrationSamples.push({t:now,v:state.detector.smooth});if(!state.measurementPaused)detectPeak(now,state.detector.smooth);renderLive();
}

async function extractPlaceEmbedding(blob){
  if(state.ai.status!=='ready'||!state.ai.model||!(blob instanceof Blob))return null;const t0=performance.now();const url=URL.createObjectURL(blob);try{const output=await state.ai.model(url);return flattenFeatureOutput(output);}finally{URL.revokeObjectURL(url);const ms=performance.now()-t0;state.diagnostics.aiInferenceMs.push(ms);if(state.diagnostics.aiInferenceMs.length>200)state.diagnostics.aiInferenceMs.shift();}}

function renderNav(){
  const route=state.navRoute;const currentRel=state.navActive?currentRelativeHeading():null;$('navRawSteps').textContent=String(state.navRawSteps);$('navRelativeHeading').textContent=currentRel==null?'--°':`${currentRel.toFixed(0)}°`;
  if(!route){$('navSteps').textContent='0歩';$('navProgressValue').textContent='0%';$('navProgressBar').style.width='0%';$('navRecordedHeading').textContent='--°';$('navHeadingDiff').textContent='--°';$('nextTurn').textContent='ルートを選択してください';$('navConfidence').textContent='--';clearCanvas($('navCanvas'));drawBelief();renderBeliefCandidates();renderLocalizationState();return;}
  if(!state.belief||state.beliefRouteId!==route.id)initBelief(route,0);const stats=beliefStats();const estimate=clamp(stats.map,0,route.totalSteps);state.navEstimateStep=estimate;const progress=clamp(estimate/Math.max(1,route.totalSteps),0,1);const expected=routeHeadingAtStep(route,estimate);const diff=currentRel==null?null:angleDiff(expected,currentRel);updateLocalizationState();const confidence=confidenceForNav();
  $('navSteps').textContent=state.localization.status==='LOST'?'不明':`${Math.round(estimate)}歩`;$('navProgressValue').textContent=state.localization.status==='LOST'?'--':`${Math.round(progress*100)}%`;$('navProgressBar').style.width=state.localization.status==='LOST'?'0%':`${progress*100}%`;$('navRecordedHeading').textContent=`${expected.toFixed(0)}°`;$('navHeadingDiff').textContent=diff==null?'--°':`${diff.toFixed(0)}°`;$('navConfidence').textContent=confidence.label;$('navConfidence').className=`metric-value ${confidence.cls}`;
  $('turnCorrectionLabel').textContent=state.lastTurnCorrection?`${state.lastTurnCorrection.target}歩 gyro観測`:'なし';$('visualCorrectionLabel').textContent=state.lastVisualCorrection?`${state.lastVisualCorrection.steps}歩 ${state.lastVisualCorrection.source}`:'なし';const turn=nextRouteTurn(route,estimate);$('nextTurn').textContent=state.localization.status==='LOST'?'現在地を見失いました。周囲をゆっくり映してください。':progress>=.98?'GOAL付近です':turn?`次の大きな方向変化まで約 ${Math.max(0,Math.round(turn.steps-estimate))} 歩`:'この先に大きな方向変化はありません';drawRoute($('navCanvas'),route,progress);drawBelief();renderBeliefCandidates();renderLive();renderDiagnostics();
}

function buildAnchorContext(anchors,routes){
  const map=new Map();const routeMap=new Map(routes.map(r=>[r.id,r]));
  for(const route of routes){const ra=anchors.filter(a=>a.routeId===route.id).sort((a,b)=>a.step-b.step);for(let i=0;i<ra.length;i++){const a=ra[i],prev=ra[i-1],next=ra[i+1];const h=routeHeadingAtStep(route,a.step),hp=prev?routeHeadingAtStep(route,prev.step):null,hn=next?routeHeadingAtStep(route,next.step):null;map.set(a.key,{prevGap:prev?a.step-prev.step:null,nextGap:next?next.step-a.step:null,turnIn:hp==null?null:signedAngle(hp,h),turnOut:hn==null?null:signedAngle(h,hn)});}}
  return map;
}
function scalarContextSim(a,b,scale){if(a==null||b==null)return null;return Math.exp(-Math.abs(a-b)/scale);}
function gapContextSim(a,b){if(a==null||b==null)return null;return Math.exp(-Math.abs(Math.log((a+1)/(b+1))));}
function anchorContextSimilarity(ca,cb){
  const score=(reverse=false)=>{const vals=[];const pg=reverse?cb.nextGap:cb.prevGap,ng=reverse?cb.prevGap:cb.nextGap;const ti=reverse&&cb.turnOut!=null?-cb.turnOut:cb.turnIn,to=reverse&&cb.turnIn!=null?-cb.turnIn:cb.turnOut;[[gapContextSim(ca.prevGap,pg),1],[gapContextSim(ca.nextGap,ng),1],[scalarContextSim(ca.turnIn,ti,55),.8],[scalarContextSim(ca.turnOut,to,55),.8]].forEach(([v,w])=>{if(v!=null)vals.push([v,w]);});if(!vals.length)return{value:.5,coverage:0};return{value:vals.reduce((s,[v,w])=>s+v*w,0)/vals.reduce((s,[v,w])=>s+w,0),coverage:vals.length/4};};const f=score(false),r=score(true);return f.value>=r.value?f:r;
}

async function buildRouteGraph(){
  const routes=(await getRoutes()).map(normalizeRoute);const stats={accepted:0,rejectedMutual:0,rejectedMargin:0,rejectedOrder:0,rejectedConflict:0,rejectedContext:0};if(!routes.length){state.graph={nodes:[],edges:[],builtAt:Date.now(),stats};renderGraph();return;}$('graphStatus').textContent='構築中…';if(state.ai.status==='ready')for(const route of routes)await ensureRoutePlaceEmbeddings(route);
  const anchors=[];for(const route of routes){const cps=[...(route.checkpoints||[])].sort((a,b)=>a.steps-b.steps),ra=[];const first=cps.find(cp=>cp.steps<=3)||null,last=[...cps].reverse().find(cp=>cp.steps>=route.totalSteps-3)||null;ra.push({routeId:route.id,routeName:route.name,step:0,kind:'start',cp:first,key:`${route.id}:start`});for(const cp of cps)if(cp!==first&&cp!==last)ra.push({routeId:route.id,routeName:route.name,step:cp.steps,kind:'checkpoint',cp,key:`${route.id}:${cp.id}`});ra.push({routeId:route.id,routeName:route.name,step:route.totalSteps,kind:'goal',cp:last,key:`${route.id}:goal`});anchors.push(...ra.sort((a,b)=>a.step-b.step));}
  const contexts=buildAnchorContext(anchors,routes),acceptedPairs=[];
  for(let ri=0;ri<routes.length;ri++)for(let rj=ri+1;rj<routes.length;rj++){
    const A=anchors.filter(x=>x.routeId===routes[ri].id&&x.cp),B=anchors.filter(x=>x.routeId===routes[rj].id&&x.cp);if(!A.length||!B.length)continue;const matrix=[];for(let i=0;i<A.length;i++)for(let j=0;j<B.length;j++){const sim=checkpointPairSimilarity(A[i].cp,B[j].cp);matrix.push({i,j,a:A[i],b:B[j],score:sim.score,source:sim.source});}
    const provisional=[];for(let i=0;i<A.length;i++){const ai=bestAndSecond(matrix.filter(m=>m.i===i));if(!ai.best)continue;const bj=bestAndSecond(matrix.filter(m=>m.j===ai.best.j));if(!bj.best||bj.best.i!==i){stats.rejectedMutual++;continue;}const threshold=ai.best.source==='dinov2'?V4_GRAPH_AI_THRESHOLD:V4_GRAPH_HAND_THRESHOLD;const marginA=ai.best.score-(ai.second?.score??0),marginB=bj.best.score-(bj.second?.score??0),high=ai.best.score>=threshold+.045;if(ai.best.score<threshold||(!(marginA>=.025&&marginB>=.025)&&!high)){stats.rejectedMargin++;continue;}const ctx=anchorContextSimilarity(contexts.get(ai.best.a.key),contexts.get(ai.best.b.key));if(ctx.coverage>=.5&&ctx.value<.34&&ai.best.score<threshold+.09){stats.rejectedContext++;continue;}provisional.push({...ai.best,contextScore:ctx.value,score:.84*ai.best.score+.16*ctx.value});}
    const ordered=enforceOrderConsistency(provisional);stats.rejectedOrder+=ordered.rejected.length;acceptedPairs.push(...ordered.keep);
  }
  const uf=safeUnionFind(anchors),anchorIndex=new Map(anchors.map((a,i)=>[a.key,i]));for(const m of acceptedPairs.sort((a,b)=>b.score-a.score)){const ia=anchorIndex.get(m.a.key),ib=anchorIndex.get(m.b.key);if(!uf.join(ia,ib)){stats.rejectedConflict++;continue;}stats.accepted++;}
  const groups=new Map();anchors.forEach((a,i)=>{const root=uf.find(i);if(!groups.has(root))groups.set(root,[]);groups.get(root).push({...a,anchorIndex:i});});const nodes=[],anchorToNode=new Map();let n=1;for(const members of groups.values()){const node={id:`N${n++}`,members,label:members.length>1?`共通地点 ${[...new Set(members.map(m=>m.routeName))].join(' / ')}`:`${members[0].routeName} ${members[0].kind==='start'?'START':members[0].kind==='goal'?'GOAL':`${members[0].step}歩`}`};nodes.push(node);members.forEach(m=>anchorToNode.set(m.key,node.id));}
  const edges=[];for(const route of routes){const ra=anchors.filter(a=>a.routeId===route.id).sort((a,b)=>a.step-b.step);for(let i=0;i<ra.length-1;i++){const from=anchorToNode.get(ra[i].key),to=anchorToNode.get(ra[i+1].key);if(!from||!to||from===to)continue;edges.push({id:`${route.id}:${i}`,from,to,cost:Math.max(1,ra[i+1].step-ra[i].step),routeId:route.id,routeName:route.name,fromStep:ra[i].step,toStep:ra[i+1].step});}}
  state.graph={nodes,edges,builtAt:Date.now(),ai:state.ai.status==='ready',stats};renderGraph();
}
function renderGraph(){
  const graph=state.graph||{nodes:[],edges:[],stats:{}};$('graphNodeCount').textContent=String(graph.nodes.length||0);$('graphEdgeCount').textContent=String(graph.edges.length||0);$('graphStatus').textContent=graph.builtAt?`${new Date(graph.builtAt).toLocaleTimeString('ja-JP')} 構築。画像 + 前後文脈で統合。`:'未構築。';const s=graph.stats||{};$('graphAccepted').textContent=String(s.accepted||0);$('graphRejectedMutual').textContent=String(s.rejectedMutual||0);$('graphRejectedMargin').textContent=String(s.rejectedMargin||0);$('graphRejectedOrder').textContent=String(s.rejectedOrder||0);$('graphRejectedConflict').textContent=String(s.rejectedConflict||0);$('graphRejectedContext').textContent=String(s.rejectedContext||0);
  const fill=select=>{const prev=select.value;select.innerHTML='<option value="">選択</option>';for(const node of graph.nodes){const o=document.createElement('option');o.value=node.id;o.textContent=`${node.id}: ${node.label}`;select.appendChild(o);}if(graph.nodes.some(x=>x.id===prev))select.value=prev;};fill($('graphFrom'));fill($('graphTo'));const list=$('graphNodesList');list.innerHTML='';for(const node of graph.nodes){const el=document.createElement('div');el.className='graph-node';const members=node.members.map(m=>`${m.routeName} @ ${m.step}歩${m.cp?' 📷':''}`).join('<br>');el.innerHTML=`<div class="graph-node-title">${node.id}: ${node.label}</div><div class="graph-node-meta">${node.members.length} anchor(s)</div><div class="graph-members">${members}</div>`;list.appendChild(el);}if(!graph.nodes.length)list.innerHTML='<div class="card"><div class="note">グラフはまだありません。</div></div>';
}

async function aggregateEvaluation(routeId=''){
  let records=await getEvaluations();if(routeId)records=records.filter(r=>r.routeId===routeId);const samples=records.flatMap(r=>r.groundTruth||[]);const errors=samples.map(s=>s.absError).filter(Number.isFinite);const goalSamples=samples.filter(s=>{const rec=records.find(r=>r.groundTruth?.includes(s));const routeEnd=rec?null:null;return false;});
  const routes=(await getRoutes()).map(normalizeRoute),rmap=new Map(routes.map(r=>[r.id,r]));let goalN=0,goalOK=0,visualN=0,visualOK=0,lostAtGt=0;
  for(const rec of records)for(const s of rec.groundTruth||[]){const route=rmap.get(rec.routeId);if(route&&Math.abs(s.truthStep-route.totalSteps)<=1){goalN++;if(s.absError<=V5_GT_GOAL_TOL)goalOK++;}if(s.recentVisual){visualN++;if(s.recentVisual.error<=3)visualOK++;}if(s.status==='LOST')lostAtGt++;}
  return{records,samples,errors,mae:mean(errors),median:percentile(errors,.5),p95:percentile(errors,.95),goalN,goalOK,visualN,visualOK,lostTransitions:records.reduce((s,r)=>s+(r.lostTransitions||0),0),lostAtGt};
}
async function populateEvalRoutes(){const routes=(await getRoutes()).map(normalizeRoute);const select=$('evalRouteSelect'),prev=select.value;select.innerHTML='<option value="">全ルート</option>';for(const r of routes){const o=document.createElement('option');o.value=r.id;o.textContent=r.name;select.appendChild(o);}if(routes.some(r=>r.id===prev))select.value=prev;}
async function renderEvaluation(){if(!$('evalGtCount'))return;await populateEvalRoutes();const routeId=$('evalRouteSelect').value;const a=await aggregateEvaluation(routeId);$('evalGtCount').textContent=String(a.samples.length);$('evalMAE').textContent=a.mae==null?'--':a.mae.toFixed(2);$('evalMedian').textContent=a.median==null?'--':a.median.toFixed(2);$('evalP95').textContent=a.p95==null?'--':a.p95.toFixed(2);$('evalGoalRate').textContent=a.goalN?`${Math.round(a.goalOK/a.goalN*100)}%`:'--';$('evalVisualRate').textContent=a.visualN?`${Math.round(a.visualOK/a.visualN*100)}%`:'--';$('evalSessionCount').textContent=String(a.records.length);$('evalLostCount').textContent=String(a.lostTransitions);$('evalLostRate').textContent=a.samples.length?`${Math.round(a.lostAtGt/a.samples.length*100)}%`:'--';renderTuning();renderDiagnostics();
  const list=$('evalRecordsList');list.innerHTML='';const rows=a.records.flatMap(r=>(r.groundTruth||[]).map(s=>({r,s}))).sort((x,y)=>y.s.t-x.s.t).slice(0,40);for(const {r,s} of rows){const el=document.createElement('div');el.className='eval-record';const cls=s.absError<=2?'eval-error-good':s.absError<=5?'eval-error-mid':'eval-error-bad';el.innerHTML=`<strong>${r.routeName} <span class="${cls}">誤差 ${s.absError.toFixed(1)}歩</span></strong><div class="small">GT ${s.truthStep} / MAP ${s.mapStep} / raw ${s.rawStep} / ${(s.confidence*100).toFixed(0)}% / ${s.status}</div>`;list.appendChild(el);}if(!rows.length)list.innerHTML='<div class="note">ナビ画面でGround Truthを記録してください。</div>';
}

async function trainV5Params(){
  const routeId=$('evalRouteSelect').value;const a=await aggregateEvaluation(routeId);if(a.samples.length<5){$('tuneStatus').textContent='Ground Truthが5点以上必要です。';return;}
  const ratios=a.samples.filter(s=>s.rawStep>=5&&s.truthStep>0).map(s=>s.truthStep/s.rawStep).filter(x=>x>=.6&&x<=1.5);const headingErrors=a.samples.map(s=>s.headingError).filter(Number.isFinite);const visualErrors=a.samples.filter(s=>s.recentVisual).map(s=>s.recentVisual.error).filter(Number.isFinite);
  const params={...V5_DEFAULT_PARAMS};if(ratios.length)params.stepAdvance=clamp(percentile(ratios,.5),.72,1.38);if(headingErrors.length)params.headingSigma=clamp(Math.max(18,(percentile(headingErrors,.5)||20)*1.6),18,65);if(visualErrors.length)params.visualSigma=clamp((percentile(visualErrors,.5)||1)+1,1.1,4.5);
  if(routeId)state.tuning.routes[routeId]=params;else state.tuning.global=params;state.tuning.samples=a.samples.length;saveV5Tuning();$('tuneStatus').textContent=`${routeId?'選択ルート':'全体'}の${a.samples.length} GT点から学習しました。`;renderTuning();
}
function resetV5Params(){const routeId=$('evalRouteSelect').value;if(routeId)delete state.tuning.routes[routeId];else state.tuning={global:{...V5_DEFAULT_PARAMS},routes:{},samples:0};saveV5Tuning();$('tuneStatus').textContent='既定値へ戻しました。';renderTuning();}
function renderTuning(){if(!$('tuneStepAdvance'))return;const p=activeV5Params($('evalRouteSelect')?.value||state.navRoute?.id);$('tuneStepAdvance').textContent=p.stepAdvance.toFixed(3);$('tuneHeadingSigma').textContent=`${p.headingSigma.toFixed(1)}°`;$('tuneVisualSigma').textContent=`${p.visualSigma.toFixed(2)} steps`;$('tuneSamples').textContent=String(state.tuning.samples||0);}

async function exportEvalCSV(){const routeId=$('evalRouteSelect').value;const a=await aggregateEvaluation(routeId);const lines=['session_id,route,datetime,truth_step,map_step,mean_step,raw_step,abs_error,confidence,status,heading_error,visual_step,visual_error'];for(const r of a.records)for(const s of r.groundTruth||[])lines.push([r.id,JSON.stringify(r.routeName),new Date(s.t).toISOString(),s.truthStep,s.mapStep,s.meanStep.toFixed(2),s.rawStep,s.absError.toFixed(2),s.confidence.toFixed(4),s.status,s.headingError.toFixed(2),s.recentVisual?.steps??'',s.recentVisual?.error??''].join(','));const file=new File([lines.join('\n')],`visual-route-eval-${new Date().toISOString().slice(0,10)}.csv`,{type:'text/csv'});if(navigator.share&&navigator.canShare?.({files:[file]})){try{await navigator.share({files:[file],title:'Visual Route evaluation'});return;}catch(e){if(e?.name==='AbortError')return;}}const url=URL.createObjectURL(file),ael=document.createElement('a');ael.href=url;ael.download=file.name;ael.click();setTimeout(()=>URL.revokeObjectURL(url),3000);}

function renderDiagnostics(){if(!$('diagSession'))return;const d=state.diagnostics;$('diagSession').textContent=fmtTime(Date.now()-d.startedAt);$('diagMotionHz').textContent=`${diagnosticMotionHz().toFixed(1)} Hz`;const vals=d.aiInferenceMs;$('diagAiMedian').textContent=vals.length?`${percentile(vals,.5).toFixed(0)} ms`:'-- ms';$('diagAiP95').textContent=vals.length?`${percentile(vals,.95).toFixed(0)} ms`:'-- ms';$('diagAutoScans').textContent=String(d.autoScans);$('diagAutoAccepted').textContent=String(d.autoAccepted);$('diagSequenceFrames').textContent=String(d.sequenceFrames);$('diagBattery').textContent=d.battery==null?'API unavailable':`${Math.round(d.battery.level*100)}%${d.battery.charging?' charging':''}`;$('diagMemory').textContent=performance.memory?`${(performance.memory.usedJSHeapSize/1024/1024).toFixed(1)} MB`:'API unavailable';}
async function initBatteryDiagnostic(){try{if(navigator.getBattery){const b=await navigator.getBattery();state.diagnostics.battery=b;}}catch(_){}}

async function exportBackup(){
  const routes=(await getRoutes()).map(normalizeRoute),serialized=[];for(const route of routes){const copy={...route,checkpoints:[]};for(const cp of route.checkpoints)copy.checkpoints.push({...cp,blobDataURL:cp.blob instanceof Blob?await blobToDataURL(cp.blob):null,blob:undefined});serialized.push(copy);}const evaluations=await getEvaluations();const payload={format:'visual-route-backup',version:5,exportedAt:new Date().toISOString(),routes:serialized,evaluations,tuning:state.tuning};const file=new File([JSON.stringify(payload)],`visual-route-backup-v5-${new Date().toISOString().slice(0,10)}.json`,{type:'application/json'});if(navigator.share&&navigator.canShare?.({files:[file]})){try{await navigator.share({files:[file],title:'Visual Route backup'});return;}catch(e){if(e?.name==='AbortError')return;}}const url=URL.createObjectURL(file),a=document.createElement('a');a.href=url;a.download=file.name;a.click();setTimeout(()=>URL.revokeObjectURL(url),3000);
}
async function importBackup(file){try{const payload=JSON.parse(await file.text());if(payload?.format!=='visual-route-backup'||!Array.isArray(payload.routes))throw new Error('Visual Routeバックアップ形式ではありません');let count=0;for(const raw of payload.routes){const route=normalizeRoute(raw);route.checkpoints=[];for(const cp of raw.checkpoints||[])route.checkpoints.push({...cp,blob:cp.blobDataURL?await dataURLToBlob(cp.blobDataURL):null,blobDataURL:undefined});await putRoute(route);count++;}for(const e of payload.evaluations||[])await putEvaluation(e);if(payload.tuning){state.tuning=payload.tuning;saveV5Tuning();}alert(`${count}ルートと評価データを復元しました。`);await refreshRoutes();await renderEvaluation();}catch(e){alert(`復元に失敗しました: ${e?.message||e}`);}}

async function loadNavRoute(id){const routes=(await getRoutes()).map(normalizeRoute);state.navRoute=routes.find(r=>r.id===id)||null;state.navActive=false;state.navRawSteps=0;state.navOffset=0;state.navEstimateStep=0;state.navEvents=[];state.lastTurnCorrection=null;state.lastVisualCorrection=null;state.navCandidate=null;state.navMatchedTurnIndex=0;state.sequence.history=[];initBelief(state.navRoute,0);$('matchResult').hidden=true;populateGroundTruthAnchors();renderNav();}

function renderTechCapabilities(){
  const set=(id,ok,yes,no='未対応')=>{if(!$(id))return;$(id).textContent=ok?yes:no;$(id).className=ok?'cap-ok':'cap-warn';};set('capSecure',window.isSecureContext,'HTTPS / secure');set('capMotion','DeviceMotionEvent'in window,'利用可能');set('capGyro',state.gyro.available,state.gyro.source,'未確認（センサー許可後に判定）');set('capCamera',!!navigator.mediaDevices?.getUserMedia,'利用可能');set('capIndexedDB','indexedDB'in window,'利用可能');set('capWakeLock','wakeLock'in navigator,'利用可能');set('capWebGPU',!!navigator.gpu,'利用可能');if($('capAIBackend'))$('capAIBackend').textContent=state.ai.status==='ready'?`${V4_PLACE_MODEL_LABEL} / ${state.ai.backend}`:state.ai.status==='error'?'AI fallback中':'未読み込み';renderDiagnostics();
}

function switchView(name){document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('active',b.dataset.view===name));$(`view-${name}`).classList.add('active');if(name==='routes')refreshRoutes();if(name==='nav')renderNav();if(name==='graph')renderGraph();if(name==='eval')renderEvaluation();if(name==='tech')renderTechCapabilities();window.scrollTo({top:0,behavior:'instant'});}

function bindUI(){
  document.querySelectorAll('nav button').forEach(button=>{button.onclick=()=>switchView(button.dataset.view);});$('btnPermission').onclick=requestSensors;$('btnCalibration').onclick=toggleCalibration;$('btnResetCalibration').onclick=resetCalibration;$('threshold').value=String(state.detector.threshold);$('thresholdLabel').textContent=state.detector.threshold.toFixed(2);$('threshold').oninput=()=>{state.detector.threshold=parseFloat($('threshold').value);localStorage.setItem('visualRoute.stepThreshold',String(state.detector.threshold));$('thresholdLabel').textContent=state.detector.threshold.toFixed(2);state.stepAdaptive.effectiveThreshold=state.detector.threshold;};$('btnStartRecord').onclick=startRecording;$('btnCapture').onclick=captureCamera;$('btnCloseCamera').onclick=closeCamera;$('btnStartNav').onclick=startNavigation;$('btnVisualMatch').onclick=manualVisualReloc;$('btnApplyMatch').onclick=applyVisualMatch;$('navRouteSelect').onchange=()=>loadNavRoute($('navRouteSelect').value);$('btnResumeMeasurement').onclick=resumeMeasurement;$('btnExport').onclick=exportBackup;$('btnImport').onclick=()=>$('importFile').click();$('importFile').onchange=async()=>{const file=$('importFile').files?.[0];if(file)await importBackup(file);$('importFile').value='';};$('btnLoadAI').onclick=()=>loadAIModel().catch(()=>{});$('btnLoadAIGraph').onclick=()=>loadAIModel().then(renderGraph).catch(()=>{});$('btnBuildGraph').onclick=()=>buildRouteGraph().catch(e=>{$('graphStatus').textContent=`構築エラー: ${e?.message||e}`;});$('btnGraphPath').onclick=calculateGraphPathUI;$('autoRelocEnabled').onchange=async()=>{if(!state.navActive)return;if($('autoRelocEnabled').checked)await startAutoRelocCamera();else{stopAutoRelocCamera();$('autoRelocStatus').textContent='自動補正OFF';}};$('btnMarkGT').onclick=markGroundTruth;$('gtAnchorSelect').onchange=()=>{if($('gtAnchorSelect').value)$('gtStepInput').value='';};$('btnRefreshEval').onclick=renderEvaluation;$('evalRouteSelect').onchange=renderEvaluation;$('btnExportEvalCSV').onclick=exportEvalCSV;$('btnTrainParams').onclick=trainV5Params;$('btnResetParams').onclick=resetV5Params;document.addEventListener('visibilitychange',handleVisibility);window.addEventListener('pagehide',()=>pauseMeasurement('ページが非表示になりました。戻ったら「計測を再開」を押してください。'));window.addEventListener('resize',()=>drawBelief());
}

async function init(){bindUI();if(!window.isSecureContext)$('secureWarning').hidden=false;if('serviceWorker'in navigator&&window.isSecureContext)navigator.serviceWorker.register('./sw.js?v=5.0.0').catch(()=>{});setInterval(()=>{if(state.recording)renderLive();renderLocalizationState();renderDiagnostics();},1000);try{await openDB();await refreshRoutes();}catch(e){console.error(e);}await initBatteryDiagnostic();renderAIStatus();renderLive();renderNav();renderCompassQuality();renderGraph();renderTechCapabilities();renderEvaluation();renderTuning();}

init();
})();
