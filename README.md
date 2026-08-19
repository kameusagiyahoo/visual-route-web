# Visual Route Lab v5

iPhone Safariだけで動くマップレス屋内自己位置推定の研究基盤です。

## V5の中心

### Ground Truth / 定量評価
ナビ中に「今ここ」を登録ルート上の既知地点として記録し、以下を自動集計します。

- MAE（平均絶対誤差）
- Median error
- P95 error
- GOAL成功率（±3歩）
- Ground Truthで検証した画像補正成功率
- LOST遷移数 / GT時LOST率

### LOCALIZED / UNCERTAIN / LOST
Bayesian Filterが常に位置を返す問題を避けるため、信頼度・方角整合・直近画像観測から状態を判定します。
LOST時は位置を「不明」と表示し、自動画像再ローカライズを高頻度化します。

### Sequence Visual Place Recognition
単画像だけでなく、直近最大4回の画像照合候補と移動歩数の順序整合を使います。
登録側も5歩ごとの自動キーフレームを取れるため、画像系列を作れます。

### ベイズパラメータ自動学習
Ground Truth 5点以上から、ルート/全体ごとに以下を調整します。

- stepAdvance
- headingSigma
- visualSigma

### Graph context
共通Node判定に画像だけでなく、前後anchorまでの歩数差と局所turn signatureを追加しました。

### Runtime Diagnostics
- DeviceMotion event rate
- DINOv2 inference median / P95
- auto scan / accepted数
- sequence frames
- Battery API（対応時）
- JS heap（対応時）

## 技術スタック

- HTML5 / CSS / Vanilla JavaScript
- iPhone Safari / PWA
- DeviceMotionEvent + rotationRate
- DeviceOrientationEvent
- MediaDevices.getUserMedia
- IndexedDB
- Service Worker / Cache API
- Transformers.js
- DINOv2-small
- ONNX Runtime Web（Transformers.js内部）
- WebGPU優先 / WASM fallback
- Adaptive Step Detector
- Gyro yaw + compass drift correction
- Discrete Bayesian Route Filter
- Sequence VPR
- Topological Graph + Dijkstra
- GitHub Pages

## 更新
既存リポジトリの `index.html / style.css / app.js / manifest.webmanifest / sw.js` をV5へ上書きしてください。
V1〜V4の保存ルートは読み込みます。V5バックアップには評価データと学習パラメータも含みます。

## 制約
絶対座標(x,y,z)を出すSLAMではありません。評価単位は登録ルート上の「歩数地点」です。
