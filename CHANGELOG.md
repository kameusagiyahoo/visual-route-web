# CHANGELOG — v4.0.0

## 対応した課題

1. 歩数誤差
   - 固定threshold中心からAdaptive Step Detectorへ変更。
   - rolling MAD、recent peak amplitude、cadence consistencyを利用。

2. 曲がり角の磁気依存
   - rotationRateとgravity vectorからworld-vertical yaw proxyを算出。
   - turn detectionはgyro主体、compassはdrift補助。

3. 分類モデルEmbedding
   - MobileNetV2からDINOv2-small image-feature-extractionへ変更。
   - Place model adapterとして独立させた。

4. 手動画像補正
   - ナビ中の自動再ローカライズを追加。
   - interval/minimum steps/遠距離jump guardを実装。

5. Graph誤結合
   - Mutual nearest neighbor。
   - best-second margin。
   - route順序整合。
   - same-route cluster conflict禁止。

6. 技術スタックの可視化
   - 専用「技術」タブを追加。
   - Runtime / Browser APIs / algorithms / AI / privacy / live capabilityを表示。

## 互換性

V1〜V3のIndexedDBルートを読み込み可能です。
旧checkpointにはDINOv2 embeddingがないため、モデル読込時に必要に応じて遅延生成します。
