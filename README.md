# Visual Route Lab v4

iPhone 15 + Safari + GitHub Pagesだけで動く、マップ不要の屋内ルート自己位置推定Webアプリです。

## V4の主な変更

- Adaptive Step Detector
  - rolling median / MADでノイズ床を推定
  - 最近の歩行ピーク振幅からしきい値を追従
  - 歩行周期（cadence）で二重検出/異常間隔を抑制
- Gyro turn detection
  - `DeviceMotionEvent.rotationRate`を利用
  - angular velocityを重力ベクトル方向へ射影し、端末の持ち角度に依存しにくいyaw proxyを生成
  - コンパスはslow drift correctionの補助へ格下げ
- Visual Place Embedding
  - `@huggingface/transformers@4.0.1`
  - `Xenova/dinov2-small`
  - `image-feature-extraction`
  - WebGPUを先に試し、失敗時WASM q8
  - AI未使用時はV2/V3の手作り画像特徴へfallback
- Automatic Visual Relocalization
  - ナビ中に低頻度でカメラ照合
  - 一意性・候補差・現在beliefから大きく飛ぶかを評価して安全な時だけ自動補正
- Safer Topological Graph
  - mutual nearest neighbor
  - best-vs-second margin
  - route pair内の順序整合
  - 1 nodeに同一routeが2回入るunionを禁止
- 「技術」タブ
  - 技術スタック
  - アーキテクチャ
  - ブラウザCapability

## 不要

Expo / npm / Node.js / Mac / Xcode / Apple Developer Program / 自前バックエンド / 有料AI API

## 更新方法

既存GitHub Pages repositoryのrootで以下を上書きしてください。

- index.html
- style.css
- app.js
- manifest.webmanifest
- sw.js

Commit後、Safariでヘッダーが `v4.0` になれば完了です。

## 重要な制約

これはARKit/SLAMではありません。絶対座標 `(x,y,z)` は出ません。
DINOv2は汎用視覚特徴であり、Visual Place Recognition専用fine-tuningモデルではありません。
