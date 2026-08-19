# Visual Route Lab v5 — 実機テスト

## 更新
- [ ] ヘッダー v5.0
- [ ] 「評価」タブが追加
- [ ] 「技術」タブが残っている

## 登録
- [ ] 20歩キャリブレーション
- [ ] 自動キーフレームON
- [ ] STARTでrecord cameraが起動
- [ ] 5歩程度ごとにキーフレーム枚数が増える
- [ ] STOP後に画像付きroute保存

## ナビ / LOST
- [ ] 初期状態 LOCALIZING
- [ ] 安定時 LOCALIZED
- [ ] 画像/方角が崩れたときUNCERTAINへ遷移
- [ ] 低信頼が継続した場合LOST
- [ ] LOST中は推定地点が「不明」
- [ ] 強い画像系列一致でLOCALIZEDへ復帰

## Sequence VPR
- [ ] auto scanごとに「画像系列 1/4 → 4/4」
- [ ] 最終照合にframe数表示
- [ ] 単画像score + 系列supportが手動照合詳細に出る

## Ground Truth
- [ ] checkpoint/turn/GOALを選択
- [ ] 「今ここをGT記録」
- [ ] 推定誤差が表示
- [ ] 評価タブへ反映

## 評価
- [ ] GT 5点以上
- [ ] MAE / Median / P95
- [ ] GOAL成功率
- [ ] CSV書き出し
- [ ] GTから学習
- [ ] Step advance / Heading σ / Visual σ更新

## Graph
- [ ] Graph再構築
- [ ] 前後文脈NGカウンタが表示
- [ ] 反復する似た場所が安易に同一Node化されない

## Diagnostics
- [ ] Motion Hz
- [ ] AI inference median/P95（AI読込時）
- [ ] Auto scans / accepted
- [ ] Sequence frames
