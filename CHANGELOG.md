# CHANGELOG — v5.0.0

## 追加
- Ground Truth記録
- MAE / Median / P95
- GOAL成功率
- 画像補正のGT検証
- LOCALIZED / UNCERTAIN / LOST FSM
- LOST時の再ローカライズ高頻度化
- 最大4フレームのSequence Place Recognition
- 記録中の自動画像キーフレーム
- Ground TruthからBayesian parameter自動調整
- Graphの前後anchor/turn context検証
- Runtime Diagnostics
- 評価CSV出力
- 評価データをIndexedDBに永続化
- V5バックアップに評価/学習パラメータを追加

## 継承
V4のAdaptive Step Detector、Gyro主体turn、DINOv2、Bayesian Filter、自動画像再ローカライズ、Graph MNN/order consistencyを継承。
