# kuchiguse-ranking-worker

kuchiguse-counter の世界ランキング API（Cloudflare Workers + D1）。

## 受け取るデータ
名前（16文字まで）・通算回数・既定語の種類数・一番多い既定語とその回数だけです。プロンプトの文章や、利用者が追加した語は受け取りません（許可リストにない語は捨てます）。本人確認は、端末で作ったランダムな秘密のハッシュで行います。

## API
| メソッド | パス | 内容 |
| --- | --- | --- |
| POST | `/v1/submit` | 参加・更新・改名（5秒に1回まで） |
| GET | `/v1/ranking?limit=20` | 上位の一覧（IDと秘密は返さない） |
| POST | `/v1/leave` | 退会（データ削除） |

## デプロイ手順
`cf`（Cloudflare CLI）でデプロイします。設定は `cloudflare.config.ts` です。

```
npm install
cf auth login
cf d1 create --name kuchiguse-ranking        # 出力の uuid を cloudflare.config.ts に書く
npm run db:init                               # migrations/ を適用
npm run deploy                                # cf deploy
```

公開先は `kuchiguse.kazuumi.page`（独自ドメインのみ。workers.dev は無効）です。

## 個人情報の扱い
- IP アドレスや User-Agent は保存しません。Workers のログ・トレースも無効です。
- 名前は公開されるため、メール・URL・電話番号のような文字列は拒否します。
- ID と秘密は応答に含めません。秘密はハッシュだけを保存します。
- 90日更新のない参加者は、毎日の定期実行で削除します。`/v1/leave` で本人がいつでも削除できます。

## テスト
```
npm test
```

## 既知の限界
自己申告の数字なので、改ざんは防げません（IDと秘密が合わない更新は拒否します）。荒らし対策が要る場合は、Cloudflare のレート制限や WAF を足してください。
