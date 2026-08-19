# Visual Route Lab v3

iPhone 15 + Safariだけで動かす、マップ不要の屋内ルート自己位置推定プロトタイプです。

## 不要

- Expo / Expo Go
- npm / Node.js
- Mac / Xcode
- Apple Developer Program
- 自前バックエンド
- 有料AI API

## V3の中心

### 1. ベイズ自己位置推定
ルートの `0歩〜GOAL` の各地点について「現在そこにいる確率」を保持します。

- 1歩検出 → 確率を前方へ遷移
- 相対方角 → 合わない地点の確率を低下
- 曲がり角 → 対応する登録turn周辺の確率を上昇
- 画像一致 → 対応checkpoint周辺の確率を強く上昇

単純な `現在歩数 / 総歩数` より、センサー誤差を統合しやすい構造です。

### 2. MobileNet画像Embedding（任意）
「MobileNetを読み込む」を押すと、TensorFlow.js + MobileNetV2 α0.25をブラウザ内で読み込みます。

- 推論は端末内
- 画像はサーバーへ送らない
- npm不要
- モデルが失敗/オフラインでもV2の軽量特徴へフォールバック

iOS Safariの安定性を優先し、V3ではTensorFlow.jsのWebGL backendを使用します。WebGPUが存在する場合はUIに表示しますが、この版のAI推論backendとしては使いません。

### 3. Topological Route Graph
複数ルートのチェックポイント画像が同じ場所と判定された場合、共通Nodeとしてクラスタリングします。

例:

玄関 → 廊下 → リビング
          └→ 洗面所

実寸の2D/3Dマップを作らず、場所の接続関係をGraphとして構築します。
Node間はDijkstra法で最短経路を計算します。

## V2から継承

- 20歩キャリブレーション
- 平滑化 + 局所ピーク歩数検出
- START基準の相対方角
- 写真品質判定
- IndexedDB保存
- JSONバックアップ/復元
- Screen Wake Lock
- バックグラウンド時の計測停止
- GitHub Pages向けService Worker
- V1/V2データ読み込み

## 更新

既存GitHub Pagesリポジトリで以下を上書きしてください。

- `index.html`
- `style.css`
- `app.js`
- `manifest.webmanifest`
- `sw.js`

Commit後、Safariでページを開き直し、ヘッダーが `v3.0` なら更新成功です。

## 重要な制約

ARKit / Visual SLAMではありません。絶対座標 `(x,y,z)` は出ません。
目的は「一度登録したルート上の現在地点」と「登録ルート同士の接続関係」を推定することです。
