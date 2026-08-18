# Visual Route Lab — Web版

iPhone 15 + Safariだけで動かす、依存ライブラリ0の簡易Visual Route Localizationです。

## 重要

`index.html` を「ファイル」アプリから直接開く方式では、カメラまで使えません。
GitHub Pagesなどの **HTTPS** で配信してください。

## 不要

- Expo / Expo Go
- npm / Node.js
- Xcode
- Mac
- Apple Developer Program
- 外部AI API

## 実装済み

- DeviceMotionから加速度取得
- 加速度ピークによる簡易歩数推定
- DeviceOrientation / `webkitCompassHeading`による方角
- 歩数 + 方角から相対軌跡を表示
- IndexedDBへのルート保存
- カメラでチェックポイント撮影
- 軽量画像特徴量によるチェックポイント照合
- 画像照合結果を使ったルート位置補正

## 精度上の注意

これはARKit/SLAMではありません。絶対座標 `(x,y,z)` や実寸距離を保証しません。
歩数検出しきい値は実機と持ち方に合わせて調整してください。
