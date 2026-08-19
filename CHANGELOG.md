# CHANGELOG — v3.0.0

## 追加

- HMM型ベイズルートフィルタ
- 位置確率分布Canvas
- 確率分布から信頼度を算出
- 歩数観測の確率遷移
- 相対方角の尤度更新
- 曲がり角の位置尤度更新
- 画像一致の位置尤度更新
- TensorFlow.jsの遅延読み込み
- MobileNetV2 α0.25の画像Embedding
- V2画像特徴とのハイブリッド照合
- AIロード失敗時の自動フォールバック
- 複数ルートのTopological Graph生成
- チェックポイント画像による共通Nodeクラスタリング
- Dijkstra最短経路
- V1/V2ルート互換

## 設計変更

V2:
`歩数 + offset補正 → 1つの推定地点`

V3:
`全地点の確率分布 → 歩数/方角/turn/imageでBayes更新 → MAP地点`

これにより、画像が曖昧な場合でも即座に1地点へ飛ばず、過去の位置履歴を保持したまま補正できます。

## AI backendについて

当初のWebGPU案から、iPhone Safariの安定性を優先してV3のMobileNet推論はTensorFlow.js WebGLを使用します。
WebGPU availability自体は表示します。
