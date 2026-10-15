// 口癖ワールドランキング API。受け取るのは「名前・回数・語の種類数・一番多い既定語」だけで、
// プロンプトの文章や、利用者が追加した語は受け取らない（許可リストにない語は捨てる）。

export interface Env {
  DB: D1Database
}

// 最小限の D1 型（テストで差し替えられるように自前で宣言する）
export interface D1Database {
  prepare(sql: string): D1Statement
}
export interface D1Statement {
  bind(...values: unknown[]): D1Statement
  first<T = Record<string, unknown>>(): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>
  run(): Promise<unknown>
}

export const ALLOWED_PHRASES = [
  'とりあえず',
  'いい感じに',
  '良き感じに',
  'よしなに',
  'ちょっと',
  'なんか',
  'たぶん',
  '一応',
  'ざっくり',
  'さくっと',
  '適当に',
  'いったん',
]

const MIN_INTERVAL_MS = 5_000
const MAX_TOTAL = 10_000_000
const MAX_BODY = 2_000

// ブラウザからの読み取りは想定しないので CORS は付けない。個人ごとの応答はキャッシュさせない
const json = (body: unknown, status = 200, cache = 'no-store') =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': cache,
      'x-content-type-options': 'nosniff',
    },
  })

const sha256 = async (text: string) => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))

  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

const sameText = (a: string, b: string) => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)

  return diff === 0
}

// 名前は全員に公開される。メール・URL・電話番号のように見えるものは受け付けない
const LOOKS_PERSONAL = /@|＠|https?:|www\.|\.(com|jp|net|org|io)\b|[0-9０-９][-ー−\s]?[0-9０-９][-ー−\s]?[0-9０-９][-ー−\s]?[0-9０-９][-ー−\s]?[0-9０-９][-ー−\s]?[0-9０-９][-ー−\s]?[0-9０-９]/i

export const cleanName = (raw: unknown) => {
  if (typeof raw !== 'string') return null
  const name = raw.normalize('NFKC').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 16)

  return name === '' || LOOKS_PERSONAL.test(name) ? null : name
}

// 90日更新のないプレイヤーは自動で削除する
export const RETENTION_MS = 90 * 24 * 60 * 60 * 1000

const readBody = async (request: Request) => {
  const text = await request.text()
  if (text.length > MAX_BODY) return null
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
}

const isInt = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max
const isToken = (v: unknown, min: number, max: number): v is string =>
  typeof v === 'string' && v.length >= min && v.length <= max && /^[A-Za-z0-9_-]+$/.test(v)

type Row = { id: string; secret_hash: string; updated_at: number }

const authenticate = async (env: Env, id: string, secret: string) => {
  const row = await env.DB.prepare('SELECT id, secret_hash, updated_at FROM players WHERE id = ?').bind(id).first<Row>()
  const hash = await sha256(`${id}:${secret}`)

  return { row, hash, isOwner: row !== null && sameText(row.secret_hash, hash) }
}

const rankOf = async (env: Env, total: number) => {
  const r = await env.DB.prepare('SELECT COUNT(*) + 1 AS rank FROM players WHERE total > ?').bind(total).first<{ rank: number }>()
  const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM players').first<{ n: number }>()

  return { rank: r?.rank ?? 1, players: c?.n ?? 1 }
}


const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)

const INSTALL_COMMAND = '/plugin install kuchiguse-counter --marketplace KazuumiN/kuchiguse-counter'

// 紹介ページ。名前は利用者が入力した文字列なので必ずエスケープして出す
export const landingPage = (rows: { name: string; total: number }[], count: number) => `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>口癖カウンター</title>
<style>
:root { color-scheme: light dark; --bg: #fffdf7; --fg: #26231e; --sub: #5f594f; --accent: #b45309; --card: #f6efe1; --line: #d9ceb8; }
@media (prefers-color-scheme: dark) { :root { --bg: #1c1a17; --fg: #f3eee3; --sub: #b9b2a3; --accent: #fbbf6a; --card: #2a2722; --line: #4a453c; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.8 system-ui, "Hiragino Sans", "Noto Sans JP", sans-serif; }
main { max-width: 42rem; margin: 0 auto; padding: 2rem 1rem 4rem; }
h1 { font-size: 1.6rem; margin: 0 0 .5rem; }
h2 { font-size: 1.15rem; margin: 2.2rem 0 .5rem; border-bottom: 2px solid var(--line); padding-bottom: .2rem; }
p, li { color: var(--fg); }
.lead { color: var(--sub); }
pre, code { font-family: ui-monospace, Menlo, monospace; }
pre { background: var(--card); border: 1px solid var(--line); border-radius: .5rem; padding: .8rem 1rem; overflow-x: auto; }
code { background: var(--card); padding: .1rem .3rem; border-radius: .25rem; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid var(--line); }
th { color: var(--sub); font-weight: 600; }
a { color: var(--accent); }
a:focus-visible, pre:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
</style>
</head>
<body>
<main>
<h1>口癖カウンター</h1>
<p class="lead">「とりあえず」「いい感じに」など、プロンプトに混ざった口癖を数えて、楽しく振り返れる Claude Code の mod です。</p>

<h2>インストール</h2>
<p>ターミナルの Claude Code で、次を入力します。</p>
<pre tabindex="0"><code>${INSTALL_COMMAND}</code></pre>
<p>マーケットプレイスの追加を聞かれたら <code>y</code>、スコープは <code>user</code> を選びます。</p>

<h2>使い方</h2>
<ul>
<li>入れるだけで、口癖を送るたびに数えます。お祝いバナーと、口癖が出た箇所の引用、言い換えのヒントが出ます。</li>
<li><code>/kuchiguse</code> でランキング・パネルを開きます。</li>
<li><code>/kuchiguse settings</code> で、バナーなどを個別にオフにできます。</li>
<li><code>/kuchiguse add 語</code> と <code>/kuchiguse remove 語</code> で、数える語を変えられます。</li>
</ul>

<h2>世界ランキング（任意）</h2>
<p><code>/kuchiguse join</code> で参加すると、ここに載ります。名前を省略すると、ランダムな名前になります。<code>/kuchiguse rename 名前</code> で変えられ、<code>/kuchiguse leave</code> で、データごと退会できます。</p>

<h3>送る情報と、送らない情報</h3>
<table>
<caption class="lead" style="text-align:left">参加中に、このサーバーへ送る情報</caption>
<thead><tr><th scope="col">送る</th><th scope="col">送らない</th></tr></thead>
<tbody><tr>
<td>名前（公開されます）・通算回数・既定の語の種類数・一番多い既定語</td>
<td>プロンプトの文章・自分で追加した語・IP アドレスの記録</td>
</tr></tbody>
</table>
<p>名前は全員に公開されます。本名・会社名・連絡先は入れないでください。メールアドレス、URL、電話番号に見える名前は受け付けません。90日更新がないと、自動で削除します。参加しなければ、何も送りません。</p>

<h2>現在のランキング${count > 0 ? `（${count}人）` : ''}</h2>
${
  rows.length === 0
    ? '<p class="lead">まだ参加者はいません。</p>'
    : `<table><caption class="lead" style="text-align:left">通算回数の上位</caption><thead><tr><th scope="col">順位</th><th scope="col">名前</th><th scope="col">回数</th></tr></thead><tbody>${rows
        .map((r, i) => `<tr><td>${i + 1}</td><td>${escapeHtml(r.name)}</td><td>${r.total}</td></tr>`)
        .join('')}</tbody></table>`
}
</main>
</body>
</html>`

export const handle = async (request: Request, env: Env, now = Date.now()): Promise<Response> => {
  const url = new URL(request.url)

  if (request.method === 'GET' && url.pathname === '/') {
    const { results } = await env.DB.prepare(
      'SELECT name, total, distinct_count, top_phrase, top_count FROM players ORDER BY total DESC, updated_at ASC LIMIT ?',
    )
      .bind(10)
      .all<{ name: string; total: number }>()
    const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM players').first<{ n: number }>()

    return new Response(landingPage(results, c?.n ?? 0), {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'public, max-age=60',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
        'referrer-policy': 'no-referrer',
      },
    })
  }

  if (request.method === 'GET' && url.pathname === '/v1/ranking') {
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') ?? 20) || 20))
    const { results } = await env.DB.prepare(
      'SELECT name, total, distinct_count, top_phrase, top_count FROM players ORDER BY total DESC, updated_at ASC LIMIT ?',
    )
      .bind(limit)
      .all<{ name: string; total: number; distinct_count: number; top_phrase: string | null; top_count: number }>()
    const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM players').first<{ n: number }>()

    return json(
      {
      players: results.map((p, i) => ({
        rank: i + 1,
        name: p.name,
        total: p.total,
        distinct: p.distinct_count,
        topPhrase: p.top_phrase,
        topCount: p.top_count,
      })),
      count: c?.n ?? 0,
      },
      200,
      'public, max-age=30',
    )
  }

  if (request.method === 'POST' && url.pathname === '/v1/submit') {
    const body = await readBody(request)
    if (body === null) return json({ error: 'bad_request' }, 400)
    const { id, secret, stats } = body as { id?: unknown; secret?: unknown; stats?: Record<string, unknown> }
    const name = cleanName(body.name)
    if (name === null && typeof body.name === 'string' && body.name.trim() !== '') {
      return json({ error: 'name_rejected' }, 400)
    }
    if (!isToken(id, 16, 64) || !isToken(secret, 16, 64) || name === null || typeof stats !== 'object' || stats === null) {
      return json({ error: 'bad_request' }, 400)
    }
    if (!isInt(stats.total, MAX_TOTAL) || !isInt(stats.distinct, 100) || !isInt(stats.topCount, MAX_TOTAL)) {
      return json({ error: 'bad_request' }, 400)
    }
    const topPhrase = typeof stats.topPhrase === 'string' && ALLOWED_PHRASES.includes(stats.topPhrase) ? stats.topPhrase : null

    const { row, hash, isOwner } = await authenticate(env, id, secret)
    if (row !== null && !isOwner) return json({ error: 'forbidden' }, 403)
    if (row !== null && now - row.updated_at < MIN_INTERVAL_MS) {
      return json({ error: 'too_fast', ...(await rankOf(env, stats.total)) }, 429)
    }

    await env.DB.prepare(
      `INSERT INTO players (id, secret_hash, name, total, distinct_count, top_phrase, top_count, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, total = excluded.total,
         distinct_count = excluded.distinct_count, top_phrase = excluded.top_phrase,
         top_count = excluded.top_count, updated_at = excluded.updated_at`,
    )
      .bind(id, hash, name, stats.total, stats.distinct, topPhrase, topPhrase === null ? 0 : stats.topCount, now)
      .run()

    return json({ ok: true, name, ...(await rankOf(env, stats.total)) })
  }

  if (request.method === 'POST' && url.pathname === '/v1/leave') {
    const body = await readBody(request)
    if (body === null) return json({ error: 'bad_request' }, 400)
    const { id, secret } = body as { id?: unknown; secret?: unknown }
    if (!isToken(id, 16, 64) || !isToken(secret, 16, 64)) return json({ error: 'bad_request' }, 400)

    const { row, isOwner } = await authenticate(env, id, secret)
    if (row === null) return json({ ok: true })
    if (!isOwner) return json({ error: 'forbidden' }, 403)
    await env.DB.prepare('DELETE FROM players WHERE id = ?').bind(id).run()

    return json({ ok: true })
  }

  return json({ error: 'not_found' }, 404)
}

export const purgeStale = async (env: Env, now = Date.now()) => {
  await env.DB.prepare('DELETE FROM players WHERE updated_at < ?').bind(now - RETENTION_MS).run()
}

export default {
  fetch: (request: Request, env: Env) => handle(request, env),
  scheduled: (_event: unknown, env: Env) => purgeStale(env),
}
