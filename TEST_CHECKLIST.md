# Visual Route Lab v4 — 実機チェック

## A. 更新
- [ ] ヘッダーが v4.0
- [ ] 登録 / ルート / ナビ / グラフ / 技術 / 仕様 の6タブ
- [ ] V3以前の保存ルートが残っている

## B. Adaptive Step Detector
- [ ] センサー許可
- [ ] 20歩キャリブレーション
- [ ] 適応しきい値が歩行中に変化する
- [ ] ケイデンスが歩行中に表示される
- [ ] 10歩×5回で過検出/未検出を記録
- [ ] スマホを振っただけでは歩数が大幅に増えない

## C. Gyro turn
- [ ] Gyro yaw rateが表示される
- [ ] iPhoneを平らに持って90°回る
- [ ] iPhoneを立てて持って90°回る
- [ ] どちらでもGyro相対角が概ね変化する
- [ ] 曲がり角がgyro観測として記録される

## D. DINOv2
- [ ] DINOv2-smallを読み込む
- [ ] WebGPUまたはWASM backendが表示される
- [ ] checkpointを撮影
- [ ] ナビ画像照合でDINOv2スコアが使われる
- [ ] AIロード失敗時もfallback特徴で動く

## E. 自動再ローカライズ
- [ ] ナビ開始時に自動カメラpreviewが表示
- [ ] 8秒程度で最終照合が更新される
- [ ] 一致地点で自動補正される
- [ ] 違う場所を映した時に遠距離jumpが抑制される
- [ ] ナビ停止時にカメラが停止する

## F. Graph誤結合防止
- [ ] 2ルート以上登録
- [ ] 共通地点写真あり
- [ ] グラフ再構築
- [ ] 採用match数が表示
- [ ] rejected mutual/margin/order/conflictが表示
- [ ] 同一route内の別地点が1Nodeに潰れない
- [ ] 共通地点は正しく1Nodeになる

## G. 技術タブ
- [ ] 技術スタックが表示
- [ ] rotationRate capabilityがセンサー許可後に更新
- [ ] WebGPU capabilityが表示
- [ ] AI backendがモデル読込後に更新
