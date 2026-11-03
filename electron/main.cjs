const { app, BrowserWindow, ipcMain, dialog, protocol, net, shell, globalShortcut, nativeTheme } = require('electron')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { pathToFileURL } = require('url')
const { Store, mergeDeep } = require('./store.cjs')
const { streamChat, listModels } = require('./ai.cjs')
const updater = require('./updater.cjs')

const SUPPORTED = ['epub', 'pdf', 'txt', 'mobi', 'azw3', 'azw', 'fb2', 'fbz', 'cbz']
const DEV_URL = process.env.VITE_DEV_URL
const DIST = path.join(__dirname, '..', 'dist')

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
  { scheme: 'book', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
])

if (process.env.AIR_USER_DATA) app.setPath('userData', process.env.AIR_USER_DATA) // 测试用独立数据目录
if (!app.requestSingleInstanceLock()) app.quit()

let win = null
let store = null
let LIB_DIR, BOOK_DIR, COVER_DIR
let pendingFiles = filesFromArgv(process.argv)
const aiJobs = new Map()

function filesFromArgv(argv) {
  return argv.slice(1).filter(a => SUPPORTED.includes(extOf(a)) && fs.existsSync(a))
}
function extOf(p) {
  const lower = p.toLowerCase()
  if (lower.endsWith('.fb2.zip')) return 'fbz'
  return path.extname(lower).slice(1)
}
const now = () => Date.now()
const findBook = id => store.data.books.find(b => b.id === id)

// 从文件名推断书名、作者：“书名 (作者) (Z-Library).pdf” → 书名 / 作者
function parseFileName(name) {
  let base = name.replace(/\.(fb2\.zip|[^.]+)$/i, '').trim()
  let tagged = false
  const tag = /\s*[(（]\s*(z-?library|z-lib|1lib|zlib)[^)）]*[)）]\s*$/i
  while (tag.test(base)) { base = base.replace(tag, ''); tagged = true }
  let author = ''
  const m = tagged && base.match(/^(.+?)\s*[(（]([^()（）]{1,60})[)）]$/)
  if (m) { base = m[1].trim(); author = m[2].trim() }
  return { title: base || name, author }
}

// ---------- 图书导入 ----------
function importFile(file, folderId) {
  const ext = extOf(file)
  if (!SUPPORTED.includes(ext)) return null
  const stat = fs.statSync(file)
  const name = path.basename(file)
  const dup = store.data.books.find(b => b.fileName === name && b.size === stat.size)
  if (dup) {
    if (folderId && !dup.folders.includes(folderId)) dup.folders.push(folderId)
    return { book: dup, duplicate: true }
  }
  const id = crypto.randomUUID()
  fs.copyFileSync(file, path.join(BOOK_DIR, id + '.' + ext))
  const { title, author } = parseFileName(name)
  const book = {
    id, format: ext, fileName: name, size: stat.size,
    title, author,
    addedAt: now(), lastReadAt: 0, progress: 0, location: null,
    cover: 0, favorite: false, status: 'unread', folders: folderId ? [folderId] : [],
    metaParsed: false,
  }
  store.data.books.push(book)
  return { book, duplicate: false }
}

function importDirectory(dir, parentId) {
  const folder = createFolder(path.basename(dir), parentId)
  const results = []
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) results.push(...importDirectory(full, folder.id))
    else {
      const r = importFile(full, folder.id)
      if (r) results.push(r)
    }
  }
  // 空文件夹（没有任何书）不保留
  const hasBooks = store.data.books.some(b => b.folders.includes(folder.id))
  const hasChildren = store.data.folders.some(f => f.parentId === folder.id)
  if (!hasBooks && !hasChildren) store.data.folders = store.data.folders.filter(f => f.id !== folder.id)
  return results
}

function summarize(results) {
  store.save()
  return {
    added: results.filter(r => !r.duplicate).map(r => r.book),
    duplicates: results.filter(r => r.duplicate).length,
    books: store.data.books,
    folders: store.data.folders,
  }
}

// ---------- 文件夹（多级，类似 Zotero 分类） ----------
function createFolder(name, parentId = null) {
  const siblings = store.data.folders.filter(f => f.parentId === parentId)
  const folder = { id: crypto.randomUUID(), name, parentId, order: siblings.length, expanded: true, createdAt: now() }
  store.data.folders.push(folder)
  return folder
}
function descendantIds(id) {
  const out = [id]
  for (const f of store.data.folders) if (f.parentId === id) out.push(...descendantIds(f.id))
  return out
}

// ---------- 窗口 ----------
const overlayColors = dark => dark
  ? { color: '#000000', symbolColor: '#f5f5f7', height: 52 }
  : { color: '#f5f5f7', symbolColor: '#1d1d1f', height: 52 }

function isDark() {
  const t = store.data.settings.theme
  return t === 'dark' || (t === 'system' && nativeTheme.shouldUseDarkColors)
}

function createWindow() {
  const dark = isDark()
  win = new BrowserWindow({
    width: 1320, height: 860, minWidth: 960, minHeight: 620,
    title: 'AI Reader',
    backgroundColor: dark ? '#000000' : '#f5f5f7',
    titleBarStyle: 'hidden',
    titleBarOverlay: overlayColors(dark),
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: false },
  })
  win.once('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(DEV_URL || 'app://')) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url) }
  })
  if (DEV_URL) win.loadURL(DEV_URL)
  else win.loadURL('app://bundle/index.html')
}

function registerBossKey() {
  globalShortcut.unregisterAll()
  const key = store.data.settings.bossKey
  if (!key) return true
  try {
    return globalShortcut.register(key, () => {
      if (!win) return
      if (win.isVisible() && !win.isMinimized()) win.hide()
      else { win.show(); win.focus() }
    })
  } catch { return false }
}

// ---------- IPC ----------
function setupIpc() {
  const h = (ch, fn) => ipcMain.handle(ch, (e, ...args) => fn(...args, e))

  h('lib:get', () => store.data)
  h('app:pending-files', () => { const f = pendingFiles; pendingFiles = []; return f })

  h('books:import-dialog', async (folderId, kind) => {
    const isDir = kind === 'directory'
    const res = await dialog.showOpenDialog(win, isDir
      ? { title: '导入文件夹（保留子文件夹结构）', properties: ['openDirectory'] }
      : { title: '导入图书', properties: ['openFile', 'multiSelections'],
          filters: [{ name: '电子书', extensions: SUPPORTED.filter(e => e !== 'fbz') }] })
    if (res.canceled) return null
    if (isDir) return summarize(importDirectory(res.filePaths[0], folderId || null))
    return summarize(res.filePaths.map(f => importFile(f, folderId)).filter(Boolean))
  })
  h('books:import-paths', (paths, folderId) => {
    const results = []
    for (const p of paths) {
      if (!fs.existsSync(p)) continue
      if (fs.statSync(p).isDirectory()) results.push(...importDirectory(p, folderId || null))
      else { const r = importFile(p, folderId); if (r) results.push(r) }
    }
    return summarize(results)
  })
  h('books:update', (ids, patch) => {
    for (const id of [].concat(ids)) { const b = findBook(id); if (b) Object.assign(b, patch) }
    store.save()
    return store.data.books
  })
  h('books:add-to-folder', (ids, folderId) => {
    for (const id of ids) { const b = findBook(id); if (b && !b.folders.includes(folderId)) b.folders.push(folderId) }
    store.save()
    return store.data.books
  })
  h('books:remove-from-folder', (ids, folderId) => {
    for (const id of ids) { const b = findBook(id); if (b) b.folders = b.folders.filter(f => f !== folderId) }
    store.save()
    return store.data.books
  })
  h('books:delete', ids => {
    for (const id of ids) {
      const b = findBook(id)
      if (!b) continue
      fs.rmSync(path.join(BOOK_DIR, id + '.' + b.format), { force: true })
      fs.rmSync(path.join(COVER_DIR, id + '.png'), { force: true })
      delete store.data.annotations[id]
      store.deleteChat(id)
    }
    store.data.books = store.data.books.filter(b => !ids.includes(b.id))
    store.save()
    return store.data.books
  })
  h('books:save-cover', (id, bytes) => {
    const b = findBook(id)
    if (!b) return null
    fs.writeFileSync(path.join(COVER_DIR, id + '.png'), Buffer.from(bytes))
    b.cover = now()
    store.save()
    return b
  })
  h('books:reveal', id => {
    const b = findBook(id)
    if (b) shell.showItemInFolder(path.join(BOOK_DIR, id + '.' + b.format))
  })

  h('folders:create', (name, parentId) => { const f = createFolder(name, parentId || null); store.save(); return { folder: f, folders: store.data.folders } })
  h('folders:update', (id, patch) => {
    const f = store.data.folders.find(x => x.id === id)
    if (f) Object.assign(f, patch)
    store.save()
    return store.data.folders
  })
  h('folders:move', (id, newParentId, beforeId) => {
    if (newParentId && descendantIds(id).includes(newParentId)) return store.data.folders // 不能移进自己的子孙
    const f = store.data.folders.find(x => x.id === id)
    if (!f) return store.data.folders
    f.parentId = newParentId || null
    const siblings = store.data.folders.filter(x => x.parentId === f.parentId && x.id !== id).sort((a, b) => a.order - b.order)
    const idx = beforeId ? siblings.findIndex(x => x.id === beforeId) : -1
    siblings.splice(idx < 0 ? siblings.length : idx, 0, f)
    siblings.forEach((x, i) => { x.order = i })
    store.save()
    return store.data.folders
  })
  h('folders:delete', id => {
    const ids = descendantIds(id)
    store.data.folders = store.data.folders.filter(f => !ids.includes(f.id))
    for (const b of store.data.books) b.folders = b.folders.filter(f => !ids.includes(f))
    store.save()
    return { folders: store.data.folders, books: store.data.books }
  })

  h('ann:get', bookId => store.data.annotations[bookId] || [])
  h('ann:set', (bookId, list) => { store.data.annotations[bookId] = list; store.save(); return true })
  h('ann:all', () => store.data.annotations)

  h('chat:get', bookId => store.getChat(bookId))
  h('chat:set', (bookId, messages) => { store.setChat(bookId, messages); return true })

  h('settings:set', patch => {
    store.data.settings = mergeDeep(store.data.settings, patch)
    store.save()
    if ('bossKey' in patch) registerBossKey()
    if ('theme' in patch && win) {
      const dark = isDark()
      win.setTitleBarOverlay(overlayColors(dark))
      win.setBackgroundColor(dark ? '#000000' : '#f5f5f7')
    }
    return store.data.settings
  })
  h('win:overlay', dark => win?.setTitleBarOverlay(overlayColors(dark)))
  h('win:fullscreen', () => { win.setFullScreen(!win.isFullScreen()); return win.isFullScreen() })

  h('file:save-text', async (defaultName, content) => {
    const res = await dialog.showSaveDialog(win, { defaultPath: defaultName, filters: [{ name: 'Markdown', extensions: ['md'] }, { name: '文本', extensions: ['txt'] }] })
    if (res.canceled) return null
    fs.writeFileSync(res.filePath, content, 'utf8')
    return res.filePath
  })
  h('shell:open', url => { if (/^https?:/.test(url)) shell.openExternal(url) })

  h('app:version', () => app.getVersion())
  h('update:state', () => updater.getState())
  h('update:check', () => updater.checkForUpdates(true))
  h('update:install', () => updater.installNow())

  h('ai:models', cfg => listModels(cfg))
  ipcMain.handle('ai:chat', async (e, reqId, payload) => {
    const ctrl = new AbortController()
    aiJobs.set(reqId, ctrl)
    try {
      await streamChat(store.data.settings.ai, payload, text => {
        if (!e.sender.isDestroyed()) e.sender.send('ai:delta', reqId, text)
      }, ctrl.signal)
      return { ok: true }
    } catch (err) {
      if (ctrl.signal.aborted) return { ok: true, aborted: true }
      return { ok: false, error: err?.message || String(err) }
    } finally {
      aiJobs.delete(reqId)
    }
  })
  h('ai:abort', reqId => aiJobs.get(reqId)?.abort())
}

function setupProtocols() {
  protocol.handle('app', req => {
    const { pathname } = new URL(req.url)
    const file = path.normalize(path.join(DIST, decodeURIComponent(pathname)))
    if (!file.startsWith(DIST)) return new Response('forbidden', { status: 403 })
    return net.fetch(pathToFileURL(file).toString())
  })
  protocol.handle('book', async req => {
    const { host, pathname } = new URL(req.url)
    const id = decodeURIComponent(pathname.slice(1))
    let file
    if (host === 'file') { const b = findBook(id); if (b) file = path.join(BOOK_DIR, id + '.' + b.format) }
    else if (host === 'cover') file = path.join(COVER_DIR, id + '.png')
    if (!file || !fs.existsSync(file)) return new Response('not found', { status: 404 })
    const res = await net.fetch(pathToFileURL(file).toString())
    const headers = new Headers(res.headers)
    headers.set('Access-Control-Allow-Origin', '*')
    return new Response(res.body, { status: res.status, headers })
  })
}

app.on('second-instance', (_e, argv) => {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show(); win.focus()
  const files = filesFromArgv(argv)
  if (files.length) win.webContents.send('app:open-files', files)
})

app.whenReady().then(() => {
  LIB_DIR = path.join(app.getPath('userData'), 'library')
  BOOK_DIR = path.join(LIB_DIR, 'books')
  COVER_DIR = path.join(LIB_DIR, 'covers')
  for (const d of [BOOK_DIR, COVER_DIR]) fs.mkdirSync(d, { recursive: true })
  store = new Store(LIB_DIR)
  setupProtocols()
  setupIpc()
  createWindow()
  registerBossKey()
  updater.setupUpdater(state => { if (win && !win.isDestroyed()) win.webContents.send('update:state', state) })
  if (store.data.settings.autoUpdate) setTimeout(() => updater.checkForUpdates(), 5000)
  nativeTheme.on('updated', () => {
    if (store.data.settings.theme === 'system' && win) win.setTitleBarOverlay(overlayColors(isDark()))
  })
})

app.on('will-quit', () => { globalShortcut.unregisterAll(); store?.flush() })
app.on('window-all-closed', () => app.quit())
