import assert from 'node:assert/strict'
import { test } from 'node:test'

import { handle, purgeStale, RETENTION_MS, type Env } from '../src/index.ts'

type Player = { id: string; secret_hash: string; name: string; total: number; distinct_count: number; top_phrase: string | null; top_count: number; updated_at: number }

// ごく小さなインメモリ D1。使う SQL だけを解釈する
const fakeDb = () => {
  const rows = new Map<string, Player>()
  const db = {
    prepare(sql: string) {
      let args: unknown[] = []
      const st = {
        bind(...v: unknown[]) {
          args = v
          return st
        },
        async first() {
          if (sql.startsWith('SELECT id, secret_hash')) return rows.get(args[0] as string) ?? null
          if (sql.includes('COUNT(*) + 1')) return { rank: [...rows.values()].filter(p => p.total > (args[0] as number)).length + 1 }
          if (sql.includes('COUNT(*) AS n')) return { n: rows.size }
          return null
        },
        async all() {
          const list = [...rows.values()].sort((a, b) => b.total - a.total || a.updated_at - b.updated_at).slice(0, args[0] as number)
          return { results: list.map(p => ({ ...p, is_sample: p.id.startsWith('sample') ? 1 : 0 })) }
        },
        async run() {
          if (sql.startsWith('INSERT')) {
            const [id, secret_hash, name, total, distinct_count, top_phrase, top_count, updated_at] = args as [string, string, string, number, number, string | null, number, number]
            rows.set(id, { id, secret_hash, name, total, distinct_count, top_phrase, top_count, updated_at })
          } else if (sql.includes('WHERE id')) rows.delete(args[0] as string)
          else if (sql.includes('updated_at <')) {
            for (const [k, v] of rows) if (v.updated_at < (args[0] as number)) rows.delete(k)
          }
        },
      }
      return st
    },
  }
  const bytes = new Uint8Array(Array.from({ length: 100 }, (_, i) => i))
  const ASSETS = {
    async head() { return { size: bytes.length } },
    async get(_key: string, o?: { range?: { offset: number; length?: number } }) {
      const from = o?.range?.offset ?? 0
      const slice = bytes.slice(from, from + (o?.range?.length ?? bytes.length))
      return { size: bytes.length, body: new Response(slice).body as ReadableStream }
    },
  }
  return { env: { DB: db, ASSETS } as unknown as Env, rows }
}

const post = (path: string, body: unknown, env: Env, now: number) =>
  handle(new Request(`https://x.test${path}`, { method: 'POST', body: JSON.stringify(body) }), env, now)

const ID = 'abcdefghijklmnop1234'
const SECRET = 'secret-secret-secret-1'
const stats = { total: 12, distinct: 3, topPhrase: 'とりあえず', topCount: 7 }

test('参加して順位が返り、ランキングに載る（IDと秘密は返さない）', async () => {
  const { env } = fakeDb()
  const res = await post('/v1/submit', { id: ID, secret: SECRET, name: 'ふわふわ', stats }, env, 1000)
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true, name: 'ふわふわ', rank: 1, players: 1 })

  const list = await (await handle(new Request('https://x.test/v1/ranking'), env)).json() as { players: Record<string, unknown>[] }
  assert.equal(list.players[0]?.name, 'ふわふわ')
  assert.equal(list.players[0]?.topPhrase, 'とりあえず')
  assert.equal('id' in (list.players[0] ?? {}), false)
})

test('他人の ID は秘密が違えば更新も退会もできない', async () => {
  const { env } = fakeDb()
  await post('/v1/submit', { id: ID, secret: SECRET, name: 'a', stats }, env, 1000)
  assert.equal((await post('/v1/submit', { id: ID, secret: 'wrong-wrong-wrong-1', name: 'x', stats }, env, 99_000)).status, 403)
  assert.equal((await post('/v1/leave', { id: ID, secret: 'wrong-wrong-wrong-1' }, env, 99_000)).status, 403)
})

test('短時間の連続送信は 429、許可リスト外の語は保存しない', async () => {
  const { env, rows } = fakeDb()
  await post('/v1/submit', { id: ID, secret: SECRET, name: 'a', stats: { ...stats, topPhrase: '社外秘の言葉' } }, env, 1000)
  assert.equal(rows.get(ID)?.top_phrase, null)
  assert.equal((await post('/v1/submit', { id: ID, secret: SECRET, name: 'a', stats }, env, 2000)).status, 429)
  assert.equal((await post('/v1/submit', { id: ID, secret: SECRET, name: 'b', stats }, env, 9000)).status, 200)
  assert.equal(rows.get(ID)?.name, 'b')
})

test('不正な入力は 400、退会するとデータが消える', async () => {
  const { env, rows } = fakeDb()
  assert.equal((await post('/v1/submit', { id: 'x', secret: SECRET, name: 'a', stats }, env, 1000)).status, 400)
  assert.equal((await post('/v1/submit', { id: ID, secret: SECRET, name: '  ', stats }, env, 1000)).status, 400)
  assert.equal((await post('/v1/submit', { id: ID, secret: SECRET, name: 'a', stats: { ...stats, total: -1 } }, env, 1000)).status, 400)
  await post('/v1/submit', { id: ID, secret: SECRET, name: 'a', stats }, env, 1000)
  assert.equal((await post('/v1/leave', { id: ID, secret: SECRET }, env, 9000)).status, 200)
  assert.equal(rows.size, 0)
})

test('メール・URL・電話番号のような名前は拒否する', async () => {
  const { env, rows } = fakeDb()
  for (const name of ['taro@example.com', 'https://x.test', '090-1234-5678', 'ＡＢＣ＠ｇｍａｉｌ', 'mysite.com']) {
    const res = await post('/v1/submit', { id: ID, secret: SECRET, name, stats }, env, 1000)
    assert.equal(res.status, 400, name)
    assert.deepEqual(await res.json(), { error: 'name_rejected' })
  }
  assert.equal(rows.size, 0)
  assert.equal((await post('/v1/submit', { id: ID, secret: SECRET, name: 'ふわふわたぬき1234', stats }, env, 1000)).status, 200)
})

test('応答にIDや秘密を含めず、CORSも付けない。90日更新のない人は消える', async () => {
  const { env, rows } = fakeDb()
  const res = await post('/v1/submit', { id: ID, secret: SECRET, name: 'a', stats }, env, 1000)
  const text = await res.text()
  assert.equal(text.includes(ID) || text.includes(SECRET), false)
  assert.equal(res.headers.get('access-control-allow-origin'), null)
  assert.equal(res.headers.get('cache-control'), 'no-store')

  await purgeStale(env, 1000 + RETENTION_MS - 1)
  assert.equal(rows.size, 1)
  await purgeStale(env, 1000 + RETENTION_MS + 1)
  assert.equal(rows.size, 0)
})

test('GET / は紹介ページを返し、名前はエスケープされる', async () => {
  const { env } = fakeDb()
  await post('/v1/submit', { id: ID, secret: SECRET, name: '"><img src=x onerror=1>', stats }, env, 1000)
  const res = await handle(new Request('https://x.test/'), env, 2000)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') ?? '', /text\/html/)
  assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'none'/)
  const html = await res.text()
  assert.match(html, /\/plugin install kuchiguse-counter/)
  assert.match(html, /送らない/)
  assert.equal(html.includes('<img src=x'), false)
  assert.equal(html.includes('&lt;img'), false) // < > は入力時に取り除かれる
  assert.equal(html.includes(ID) || html.includes(SECRET), false)
})

test('参加者がいなくても紹介ページは表示できる', async () => {
  const { env } = fakeDb()
  const html = await (await handle(new Request('https://x.test/'), env)).text()
  assert.match(html, /まだ参加者はいません/)
})

test('サンプル参加者は API と紹介ページで見分けられ、通常の参加では sample 始まりの ID を使えない', async () => {
  const { env, rows } = fakeDb()
  rows.set('sample0abcdef0123456789', { id: 'sample0abcdef0123456789', secret_hash: 'x', name: '見本たぬき', total: 20, distinct_count: 3, top_phrase: null, top_count: 0, updated_at: 1 })
  await post('/v1/submit', { id: ID, secret: SECRET, name: '本物', stats }, env, 1000)

  const list = (await (await handle(new Request('https://x.test/v1/ranking'), env)).json()) as { players: { name: string; isSample: boolean }[] }
  assert.deepEqual(list.players.map(p => [p.name, p.isSample]), [['見本たぬき', true], ['本物', false]])

  const html = await (await handle(new Request('https://x.test/'), env)).text()
  assert.match(html, /見本たぬき <small class="lead">（サンプル）<\/small>/)
  assert.match(html, /架空の参加者/)
  assert.equal(html.includes('本物 <small'), false)

  const res = await post('/v1/submit', { id: 'sampleabcdefghijklmn0123', secret: SECRET, name: 'x', stats }, env, 1000)
  assert.equal(res.status, 400)
})

test('紹介ページに動画があり、CSP が自分のメディアだけ許可する', async () => {
  const { env } = fakeDb()
  const res = await handle(new Request('https://x.test/'), env)
  const html = await res.text()
  assert.match(html, /<video controls/)
  assert.match(html, /動画の内容/)
  assert.match(res.headers.get('content-security-policy') ?? '', /media-src 'self'/)
})

test('動画は Range に応え、不正な範囲は 416', async () => {
  const { env } = fakeDb()
  const whole = await handle(new Request('https://x.test/intro.mp4'), env)
  assert.equal(whole.status, 200)
  assert.equal(whole.headers.get('content-type'), 'video/mp4')
  assert.equal((await whole.arrayBuffer()).byteLength, 100)

  const part = await handle(new Request('https://x.test/intro.mp4', { headers: { range: 'bytes=10-19' } }), env)
  assert.equal(part.status, 206)
  assert.equal(part.headers.get('content-range'), 'bytes 10-19/100')
  assert.deepEqual([...new Uint8Array(await part.arrayBuffer())], [10, 11, 12, 13, 14, 15, 16, 17, 18, 19])

  const tail = await handle(new Request('https://x.test/intro.mp4', { headers: { range: 'bytes=95-' } }), env)
  assert.equal(tail.headers.get('content-range'), 'bytes 95-99/100')

  const bad = await handle(new Request('https://x.test/intro.mp4', { headers: { range: 'bytes=500-600' } }), env)
  assert.equal(bad.status, 416)
})
