// Run with: electron scripts/zlibrary-electron-smoke.cjs
const { app, safeStorage, net } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { SessionStore } = require('../electron/zlibrary.cjs')

app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aireader-zlib-smoke-'))
  let server
  try {
    assert.ok(safeStorage.isEncryptionAvailable())
    const cfg = { baseUrl: 'https://books.example', userId: '1234', userKey: 'local-smoke-session' }
    const store = new SessionStore(dir, safeStorage)
    store.save(cfg)
    assert.deepEqual(store.read(), cfg)
    assert.ok(!fs.readFileSync(store.file, 'utf8').includes(cfg.userKey))
    server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ key: req.headers['remix-userkey'], cookie: req.headers.cookie }))
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const res = await net.fetch(`http://127.0.0.1:${server.address().port}/`, {
      credentials: 'omit', redirect: 'manual',
      headers: { 'remix-userkey': cfg.userKey, Cookie: `remix_userid=${cfg.userId}; remix_userkey=${cfg.userKey}` },
    })
    const received = await res.json()
    assert.equal(received.key, cfg.userKey)
    assert.equal(received.cookie, `remix_userid=${cfg.userId}; remix_userkey=${cfg.userKey}`)
    store.clear()
    assert.ok(!store.state().configured)
    console.log('PASS: Electron safeStorage encryption and net.fetch session headers')
  } finally {
    if (server) await new Promise(resolve => server.close(resolve))
    fs.rmSync(dir, { recursive: true, force: true })
  }
}).then(() => app.exit(0)).catch(err => { console.error(err.message); app.exit(1) })
