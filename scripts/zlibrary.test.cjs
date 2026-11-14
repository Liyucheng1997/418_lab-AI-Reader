const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { ZLibrary, SessionStore, origin } = require('../electron/zlibrary.cjs')
const { enrich } = require('../electron/recommend.cjs')

const cfg = { baseUrl: 'https://books.example', userId: '1234', userKey: 'test-session-key' }
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const book = (over = {}) => ({ id: 10, hash: 'abc123', title: '测试书籍', author: '测试作者', extension: 'epub', language: 'Chinese', ...over })
const pdf = Buffer.from('%PDF-1.7\n' + 'test content '.repeat(30))

test('requires an HTTPS origin and rejects header injection', () => {
  for (const value of ['http://books.example', 'https://a:b@books.example', 'https://books.example/path', 'https://books.example:8443', 'https://books.example?q=a']) assert.throws(() => origin(value))
  assert.equal(origin(' https://books.example/ '), cfg.baseUrl)
  assert.throws(() => new ZLibrary(() => {}, { ...cfg, userKey: 'bad\r\nCookie: x' }))
})

test('search sends form arrays and authenticates; rejects wrong author/format, prefers Chinese EPUB', async () => {
  const client = new ZLibrary(async (url, opts) => {
    assert.equal(url, cfg.baseUrl + '/eapi/book/search')
    assert.equal(opts.redirect, 'manual')
    assert.equal(opts.headers['remix-userkey'], cfg.userKey)
    const body = new URLSearchParams(opts.body)
    assert.deepEqual(body.getAll('extensions[]'), ['epub', 'pdf'])
    assert.equal(body.get('message'), '测试书籍 测试作者')
    return json({ success: 1, books: [book({ id: 1, author: '无关人员' }), book({ id: 2, extension: 'exe' }),
      book({ id: 3, language: 'English' }), book({ id: 4, extension: 'pdf' }), book({ id: 5 })] })
  }, cfg)
  assert.equal((await client.find({ title: '测试书籍', author: '测试作者' })).id, '5')
})

test('falls back to original title and author; no match stays empty', async () => {
  let calls = 0
  const client = new ZLibrary(async (_url, opts) => {
    calls++
    const q = new URLSearchParams(opts.body).get('message')
    return json({ success: 1, books: q.startsWith('Original') ? [book({ title: 'Original Book', author: 'John Smith' })] : [] })
  }, cfg)
  assert.ok(await client.find({ title: '中文译名', author: '史密斯', originalTitle: 'Original Book', originalAuthor: 'John Smith' }))
  assert.equal(calls, 2)
  assert.equal(await client.find({ title: '不存在的书', author: '不存在的作者' }), null)
})

test('surfaces expired sessions, quota, challenge, redirect, network and malformed responses', async () => {
  for (const [response, pattern] of [
    [json({ success: 0, error: 'Invalid credentials' }, 400), /登录已失效/],
    [json({ success: 0, error: 'Daily limit reached' }, 400), /额度/],
    [new Response('<html>verify</html>'), /网页验证/],
    [new Response('', { status: 307, headers: { location: 'https://other.example' } }), /重定向/],
    [json({ success: 1 }), /检索数据格式/],
  ]) {
    const client = new ZLibrary(async () => response, cfg)
    await assert.rejects(client.find({ title: '测试书籍' }), pattern)
  }
  await assert.rejects(new ZLibrary(async () => { throw new Error('timeout') }, cfg).profile(), /超时/)
})

test('profile confirms identity and exposes only display name and quota', async () => {
  const client = new ZLibrary(async () => json({ success: 1, user: { id: 1234, name: 'reader', remix_userkey: 'secret', dailyDownloadLimit: 10, dailyDownloadsCount: 3 } }), cfg)
  assert.deepEqual(await client.profile(), { name: 'reader', limit: 10, used: 3 })
  await assert.rejects(new ZLibrary(async () => json({ success: 1, user: { id: 0 } }), cfg).profile(), /未确认/)
})

test('fresh link resolution and CDN redirects do not leak session headers', async () => {
  let calls = 0
  const client = new ZLibrary(async (url, opts) => {
    calls++
    if (calls === 1) {
      assert.match(url, /\/10\/abc123\/file$/)
      return json({ success: 1, file: { downloadLink: '/download/signed' } })
    }
    if (calls === 2) {
      assert.equal(opts.headers['remix-userkey'], cfg.userKey)
      return new Response('', { status: 302, headers: { location: 'https://cdn.example/signed' } })
    }
    assert.equal(opts.headers['remix-userkey'], undefined)
    assert.equal(opts.headers.Cookie, undefined)
    return new Response(pdf)
  }, cfg)
  assert.deepEqual(await client.download({ id: '10', hash: 'abc123', format: 'pdf' }), pdf)
  assert.equal(calls, 3)
})

test('rejects missing link, insecure link, HTML, oversized file, redirect loop and invalid version', async () => {
  const version = { id: '10', hash: 'abc123', format: 'epub' }
  for (const [fileData, fileResponse, pattern] of [
    [{ success: 1 }, null, /没有返回下载链接/],
    [{ success: 1, url: 'http://cdn.example/book' }, null, /不安全/],
    [{ success: 1, link: '/file' }, new Response('<html>' + 'x'.repeat(1000)), /不是有效/],
    [{ success: 1, downloadLink: '/file' }, new Response('', { headers: { 'content-length': String(151 * 1024 * 1024) } }), /150 MB/],
  ]) {
    let calls = 0
    const client = new ZLibrary(async () => ++calls === 1 ? json(fileData) : fileResponse, cfg)
    await assert.rejects(client.download(version), pattern)
  }
  let calls = 0
  const client = new ZLibrary(async () => ++calls === 1 ? json({ success: 1, url: '/file' })
    : new Response('', { status: 302, headers: { location: '/file' } }), cfg)
  await assert.rejects(client.download(version), /次数过多/)
  await assert.rejects(client.download({ ...version, format: 'exe' }), /无效/)
})

test('EPUB validates MIME marker; streaming size cap cancels the reader', async () => {
  const valid = Buffer.concat([Buffer.from([80, 75, 3, 4]), Buffer.from('application/epub+zip' + 'x'.repeat(200))])
  let calls = 0
  const client = new ZLibrary(async () => ++calls % 2 ? json({ success: 1, url: '/download' }) : new Response(valid), cfg)
  assert.deepEqual(await client.download({ id: '10', hash: 'abc123', format: 'epub' }), valid)
  let cancelled = false
  let count = 0
  const largeClient = new ZLibrary(async () => ++count === 1 ? json({ success: 1, url: '/large' }) : {
    ok: true, status: 200, headers: new Headers(), body: { getReader: () => ({
      read: async () => ({ done: false, value: { length: 151 * 1024 * 1024 } }),
      cancel: async () => { cancelled = true },
    }) },
  }, cfg)
  await assert.rejects(largeClient.download({ id: '10', hash: 'abc123', format: 'pdf' }), /150 MB/)
  assert.ok(cancelled)
})

test('source failure does not drop AI recommendations or covers', async () => {
  const items = [{ title: '测试书籍', author: '测试作者' }]
  const result = await enrich(async () => json({}), items, '', async () => { throw new Error('登录失效') })
  assert.equal(result[0].title, '测试书籍')
  assert.equal(result[0].free, null)
  assert.equal(result[0].sourceError, '登录失效')
})

test('sessions round trip through encrypted storage, redact key, clear and fail closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aireader-zlib-test-'))
  // Simulate OS encryption with AES; actual safeStorage is checked separately in Electron.
  const key = crypto.randomBytes(32), iv = crypto.randomBytes(16)
  const safe = {
    isEncryptionAvailable: () => true,
    encryptString: value => { const c = crypto.createCipheriv('aes-256-cbc', key, iv); return Buffer.concat([c.update(value), c.final()]) },
    decryptString: value => { const d = crypto.createDecipheriv('aes-256-cbc', key, iv); return Buffer.concat([d.update(value), d.final()]).toString() },
  }
  try {
    const store = new SessionStore(dir, safe)
    assert.equal(store.state().configured, false)
    assert.deepEqual(store.save(cfg), { configured: true, baseUrl: cfg.baseUrl, userId: cfg.userId })
    assert.deepEqual(store.read(), cfg)
    assert.ok(!fs.readFileSync(store.file, 'utf8').includes(cfg.userKey))
    safe.decryptString = () => { throw new Error('another OS account') }
    assert.equal(store.state().configured, false)
    safe.isEncryptionAvailable = () => false
    assert.throws(() => store.save(cfg), /系统加密服务/)
    assert.equal(store.clear().configured, false)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
