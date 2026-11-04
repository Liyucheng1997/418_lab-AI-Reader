const { app, BrowserWindow, ipcMain, dialog, protocol, net, shell, globalShortcut, nativeTheme } = require('electron')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { pathToFileURL } = require('url')
const { Store, mergeDeep } = require('./store.cjs')
const { streamChat, listModels } = require('./ai.cjs')
const updater = require('./updater.cjs')
const f5 = require('./tts.cjs')
const { OcrManager } = require('./ocr.cjs')
const linked = require('./linked.cjs')
const covers = require('./covers.cjs')

const SUPPORTED = ['epub', 'pdf', 'txt', 'mobi', 'azw3', 'azw', 'fb2', 'fbz', 'cbz']
const DEV_URL = process.env.VITE_DEV_URL
const DIST = path.join(__dirname, '..', 'dist')

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
  { scheme: 'book', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
])

if (process.env.AIR_USER_DATA) app.setPath('userData', process.env.AIR_USER_DATA) // 测试用独立数据目录
// 数据位置：书库索引、封面、语音缓存默认在 %APPDATA%（C 盘），可以在设置里换到别的盘；新位置记在默认目录的 location.json
const DEFAULT_DATA = app.getPath('userData')
const LOCATION_FILE = path.join(DEFAULT_DATA, 'location.json')
let missingDataDir = null // 记录的数据位置找不到了（磁盘没接上，或被删了），启动时要问用户
try {
  const { dataDir } = JSON.parse(fs.readFileSync(LOCATION_FILE, 'utf8'))
  if (dataDir && fs.existsSync(dataDir)) {
    app.setPath('userData', dataDir)
    // 搬家时浏览器缓存还被占用删不掉，换到新位置后再清理旧位置的缓存（书库数据搬家时已处理，这里绝不碰）
    for (const e of fs.readdirSync(DEFAULT_DATA)) {
      if (!['location.json', 'library', 'tts-cache'].includes(e)) fs.rmSync(path.join(DEFAULT_DATA, e), { recursive: true, force: true, maxRetries: 2 })
    }
  } else if (dataDir) missingDataDir = dataDir
} catch {}

// 安装目录在更新、卸载时会被整个删掉，数据绝不能放在里面
const INSTALL_DIR = path.dirname(app.getPath('exe'))
const isInside = (p, dir) => {
  const r = path.relative(path.resolve(dir).toLowerCase(), path.resolve(p).toLowerCase())
  return !r || (!r.startsWith('..') && !path.isAbsolute(r))
}
function dataTarget(picked) {
  if (app.isPackaged && isInside(picked, INSTALL_DIR)) {
    throw new Error(`不能放在程序的安装目录（${INSTALL_DIR}）里：更新或卸载时整个安装目录会被删除。请另选一个文件夹，比如 D:\\AI Reader 数据`)
  }
  // 选的是非空文件夹时，在里面建一个“AI Reader 数据”
  if (fs.existsSync(picked) && fs.readdirSync(picked).length && !fs.existsSync(path.join(picked, 'library', 'library.json'))) return path.join(picked, 'AI Reader 数据')
  return picked
}
if (!app.requestSingleInstanceLock()) app.quit()

let win = null
let ocr = null
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
// 图书文件位置：导入的在书库目录里，关联文件夹里的直接用原文件
function bookPath(b) {
  if (!b.linked) return path.join(BOOK_DIR, b.id + '.' + b.format)
  const root = store.data.linkedRoots.find(r => r.id === b.linked.root)
  return root ? path.join(root.path, b.linked.rel) : null
}

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
  win.on('closed', () => { ocr?.dispose(); app.quit() }) // 后台 OCR 的隐藏窗口不该让程序一直挂着
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
    const folder = store.data.folders.find(f => f.id === folderId)
    // 拖到关联文件夹：真的把文件移过去（导入的书则放进 OneDrive 目录）；普通文件夹只是归类
    if (folder?.linked) linked.moveBooks(store.data, ids, folder, bookPath)
    else for (const id of ids) { const b = findBook(id); if (b && !b.folders.includes(folderId)) b.folders.push(folderId) }
    store.save()
    return store.data.books
  })
  h('books:remove-from-folder', (ids, folderId) => {
    for (const id of ids) { const b = findBook(id); if (b) b.folders = b.folders.filter(f => f !== folderId) }
    store.save()
    return store.data.books
  })
  h('books:delete', async ids => {
    // 关联文件夹（OneDrive）里的书：只删本地副本，书留在云端、也留在书库里
    const linkedBooks = ids.map(findBook).filter(b => b?.linked)
    if (linkedBooks.length) await keepLocal(linkedBooks, false)
    const removed = ids.map(findBook).filter(b => b && !b.linked)
    for (const b of removed) {
      fs.rmSync(path.join(BOOK_DIR, b.id + '.' + b.format), { force: true })
      fs.rmSync(path.join(COVER_DIR, b.id + '.png'), { force: true })
      ocr.remove(b.id)
      delete store.data.annotations[b.id]
      store.deleteChat(b.id)
    }
    store.data.books = store.data.books.filter(b => !removed.includes(b))
    store.save()
    return store.data.books
  })
  h('books:keep-local', async (ids, keep) => { await keepLocal(ids.map(findBook).filter(b => b?.linked), keep); store.save(); return store.data.books })
  h('books:find-cover', async id => {
    const b = findBook(id)
    if (!b) return null
    try {
      const buf = await covers.findCover(webFetch, b, coverState())
      b.coverSearched = now()
      if (buf) { fs.writeFileSync(path.join(COVER_DIR, id + '.png'), buf); b.cover = now() }
    } catch (e) { throw new Error('暂时查不到：' + e.message) }
    store.save()
    return b
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
    const file = b && bookPath(b)
    if (file) shell.showItemInFolder(file)
  })
  h('books:get', id => findBook(id))
  h('books:patch', (id, patch) => {
    const b = findBook(id)
    if (b) Object.assign(b, patch)
    store.save()
    if (patch.metaParsed && b && !b.cover) setTimeout(runCoverQueue, 1000) // 书里没有封面，去网上找
    return b
  })

  h('linked:list', () => store.data.linkedRoots)
  h('linked:add', async () => {
    const res = await dialog.showOpenDialog(win, { title: '选择要关联的文件夹（如 OneDrive 里的电子书目录）', properties: ['openDirectory'] })
    if (res.canceled) return null
    const dir = res.filePaths[0]
    let root = store.data.linkedRoots.find(r => r.path.toLowerCase() === dir.toLowerCase())
    if (!root) { root = linked.newRoot(dir); store.data.linkedRoots.push(root) }
    const result = await scanRoot(root)
    setTimeout(runCoverQueue, 2000) // 云端的书没法读内置封面，直接联网找
    return { result, ...libSnapshot() }
  })
  h('linked:rescan', async rootId => {
    const results = []
    for (const root of store.data.linkedRoots) if (!rootId || root.id === rootId) results.push(await scanRoot(root))
    setTimeout(runCoverQueue, 2000)
    return { results, ...libSnapshot() }
  })
  h('linked:remove', rootId => { linked.removeRoot(store.data, rootId); store.save(); return libSnapshot() })

  h('data:info', () => ({
    dir: app.getPath('userData'), isDefault: path.resolve(app.getPath('userData')) === path.resolve(DEFAULT_DATA),
    library: dirSize(LIB_DIR) - dirSize(COVER_DIR), covers: dirSize(COVER_DIR), tts: dirSize(path.join(app.getPath('userData'), 'tts-cache')),
  }))
  h('data:open', () => shell.openPath(app.getPath('userData')))
  h('data:move', async picked => {
    if (!picked) {
      const res = await dialog.showOpenDialog(win, { title: '选择新的数据位置（C 盘以外，且不要放在程序安装目录里）', properties: ['openDirectory', 'createDirectory'] })
      if (res.canceled) return null
      picked = res.filePaths[0]
    }
    const target = dataTarget(picked)
    if (path.resolve(target) === path.resolve(app.getPath('userData'))) return null
    await moveDataTo(target)
  })

  const folderOf = id => store.data.folders.find(x => x.id === id)
  h('folders:create', (name, parentId) => {
    const parent = folderOf(parentId)
    // 在关联文件夹里新建 = 在 OneDrive 里建目录
    const f = parent?.linked ? linked.createFolder(store.data, parent, name) : createFolder(name, parentId || null)
    store.save()
    return { folder: f, folders: store.data.folders }
  })
  h('folders:update', (id, patch) => {
    const f = folderOf(id)
    if (f?.linked && patch.name != null && patch.name !== f.name) {
      linked.relocateFolder(store.data, f, folderOf(f.parentId), patch.name) // 改名 = 目录改名
      const { name, ...rest } = patch
      patch = rest
    }
    if (f) Object.assign(f, patch)
    store.save()
    return store.data.folders
  })
  h('folders:local', async (id, keep) => {
    const f = folderOf(id)
    if (!f?.linked) return store.data.books
    const ids = new Set(descendantIds(id))
    await linked.setPinned([{ dir: linked.dirOf(store.data, f) }], keep)
    for (const b of store.data.books) if (b.linked && b.folders.some(x => ids.has(x))) b.cloud = !keep
    store.save()
    return store.data.books
  })
  h('folders:move', (id, newParentId, beforeId) => {
    if (newParentId && descendantIds(id).includes(newParentId)) return store.data.folders // 不能移进自己的子孙
    const f = store.data.folders.find(x => x.id === id)
    if (!f) return store.data.folders
    if (f.linked || folderOf(newParentId)?.linked) {
      // 关联文件夹按名称排序；换了父文件夹就是在 OneDrive 里移动目录
      if ((f.parentId || null) !== (newParentId || null)) linked.relocateFolder(store.data, f, folderOf(newParentId))
      store.save()
      return store.data.folders
    }
    f.parentId = newParentId || null
    const siblings = store.data.folders.filter(x => x.parentId === f.parentId && x.id !== id).sort((a, b) => a.order - b.order)
    const idx = beforeId ? siblings.findIndex(x => x.id === beforeId) : -1
    siblings.splice(idx < 0 ? siblings.length : idx, 0, f)
    siblings.forEach((x, i) => { x.order = i })
    store.save()
    return store.data.folders
  })
  h('folders:delete', id => {
    if (folderOf(id)?.linked) throw new Error('关联的文件夹请在 OneDrive 里删除，或在根文件夹上“取消关联”')
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
    if (patch.tts && 'f5Python' in patch.tts) f5.stop()
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

  // PDF 文字识别：indices 为要识别的页（0 起），front 表示当前页、插队优先
  h('ocr:get', bookId => ocr.status(bookId, true))
  h('ocr:start', (bookId, indices, total, front) => ocr.request(bookId, `book://file/${encodeURIComponent(bookId)}`, indices, total, front))
  h('ocr:stop', bookId => ocr.stop(bookId))

  h('tts:synth', text => f5.synth(store.data.settings.tts, text))
  h('tts:cancel', () => f5.cancel())
  h('tts:voices', cfg => f5.voices(cfg || store.data.settings.tts))
  h('tts:status', cfg => f5.status(cfg || store.data.settings.tts))
  h('tts:pick-file', async kind => {
    const res = await dialog.showOpenDialog(win, kind === 'python'
      ? { title: '选择装有 F5-TTS 的 python.exe', properties: ['openFile'], filters: [{ name: 'Python', extensions: ['exe'] }] }
      : { title: '选择一段 5–15 秒的清晰人声作为参考音色', properties: ['openFile'], filters: [{ name: '音频', extensions: ['wav', 'mp3', 'flac', 'ogg', 'm4a'] }] })
    return res.canceled ? null : res.filePaths[0]
  })
}

const libSnapshot = () => ({ books: store.data.books, folders: store.data.folders, roots: store.data.linkedRoots })

// OneDrive“释放空间 / 始终保留在此设备”
async function keepLocal(books, keep) {
  const targets = books.map(b => ({ file: bookPath(b) })).filter(t => t.file && fs.existsSync(t.file))
  await linked.setPinned(targets, keep)
  for (const b of books) b.cloud = !keep
}

// ---------- 联网补封面：书里没封面、或只在云端读不到的，按书名去网上找 ----------
const webFetch = (url, opts) => net.fetch(url, opts) // 走系统代理
let coverSession = null
const coverState = () => {
  coverSession ||= {}
  coverSession.googleKey = store.data.settings.googleBooksKey || ''
  return coverSession
}
let coverRunning = false
async function runCoverQueue() {
  if (coverRunning || !store.data.settings.onlineCovers) return
  coverRunning = true
  try {
    const pending = () => store.data.books.find(b => !b.cover && !b.coverSearched && (b.cloud || b.metaParsed))
    let b
    while (store.data.settings.onlineCovers && (b = pending())) {
      try {
        const buf = await covers.findCover(webFetch, b, coverState())
        b.coverSearched = now()
        if (buf) { fs.writeFileSync(path.join(COVER_DIR, b.id + '.png'), buf); b.cover = now() }
        store.save()
        if (buf && win && !win.isDestroyed()) win.webContents.send('book:updated', b)
      } catch (e) {
        console.warn('联网找封面暂停：', e.message) // 被限流或没网，下次启动再继续
        break
      }
      await new Promise(r => setTimeout(r, 1200))
    }
  } finally { coverRunning = false }
}

// ---------- 数据位置 ----------
function dirSize(dir) {
  let n = 0
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      n += e.isDirectory() ? dirSize(p) : fs.statSync(p).size
    }
  } catch {}
  return n
}
// 换位置：把书库（索引、封面、导入的书、笔记）和语音缓存复制过去，确认后删掉旧的，再重启
async function moveDataTo(target) {
  const from = app.getPath('userData')
  const parts = ['library', 'tts-cache']
  store.flush()
  store.save = () => {} // 搬家期间不再写旧位置
  f5.stop()
  fs.mkdirSync(target, { recursive: true })
  for (const p of parts) if (fs.existsSync(path.join(from, p))) fs.cpSync(path.join(from, p), path.join(target, p), { recursive: true })
  if (!fs.existsSync(path.join(target, 'library', 'library.json'))) throw new Error('复制失败，数据仍在原位置')
  if (path.resolve(target) === path.resolve(DEFAULT_DATA)) fs.rmSync(LOCATION_FILE, { force: true })
  else fs.writeFileSync(LOCATION_FILE, JSON.stringify({ dataDir: target }))
  for (const p of parts) fs.rmSync(path.join(from, p), { recursive: true, force: true })
  app.relaunch()
  app.exit(0)
}

async function scanRoot(root) {
  if (!fs.existsSync(root.path)) throw new Error('找不到文件夹：' + root.path)
  const files = await linked.listBooks(root.path, SUPPORTED.filter(e => e !== 'fbz'))
  const result = linked.applyScan(store.data, root, files, { extOf, parseFileName, now })
  store.save()
  return result
}

// 启动后在后台重新扫描关联文件夹，书库随 OneDrive 的变化自动更新
async function rescanLinked() {
  if (!store.data.linkedRoots.length) return
  for (const root of store.data.linkedRoots) {
    try { await scanRoot(root) } catch (e) { console.warn('关联文件夹扫描失败', root.path, e.message) }
  }
  if (win && !win.isDestroyed()) win.webContents.send('lib:changed', libSnapshot())
  runCoverQueue()
}

function setupProtocols() {
  protocol.handle('app', async req => {
    const { pathname } = new URL(req.url)
    const file = path.normalize(path.join(DIST, decodeURIComponent(pathname)))
    if (!file.startsWith(DIST)) return new Response('forbidden', { status: 403 })
    const res = await net.fetch(pathToFileURL(file).toString())
    if (pathname === '/index.html') return res // 主窗口不做跨源隔离
    // OCR 窗口要 crossOriginIsolated 才能多线程跑识别模型；它加载的脚本（含 Worker）也都要带 COEP
    const headers = new Headers(res.headers)
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp')
    headers.set('Cross-Origin-Resource-Policy', 'same-origin')
    if (pathname === '/ocr.html') headers.set('Cross-Origin-Opener-Policy', 'same-origin')
    return new Response(res.body, { status: res.status, headers })
  })
  protocol.handle('book', async req => {
    const { host, pathname } = new URL(req.url)
    const id = decodeURIComponent(pathname.slice(1))
    let file
    if (host === 'file') { const b = findBook(id); if (b) file = bookPath(b) }
    else if (host === 'cover') file = path.join(COVER_DIR, id + '.png')
    if (!file || !fs.existsSync(file)) return new Response('not found', { status: 404 })
    const res = await net.fetch(pathToFileURL(file).toString())
    const headers = new Headers(res.headers)
    headers.set('Access-Control-Allow-Origin', '*')
    headers.set('Cross-Origin-Resource-Policy', 'cross-origin') // OCR 窗口（跨源隔离）也要能读
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

// 记录的数据位置不见了：别悄悄换成一个空书库，告诉用户并让他选
function resolveMissingDataDir() {
  const choice = dialog.showMessageBoxSync({
    type: 'warning', title: 'AI Reader', noLink: true, defaultId: 0, cancelId: 2,
    message: '找不到数据文件夹',
    detail: `之前设置的数据位置不存在了：\n${missingDataDir}\n\n可能是那块磁盘没有接上，或者文件夹被删除了（放在程序安装目录里时，更新或卸载会把它一起删掉）。\n\n如果只是磁盘没接上，请先退出，接上后再打开。`,
    buttons: ['选择数据位置…', '使用默认位置（C 盘）', '退出'],
  })
  if (choice === 2) { app.quit(); return false }
  if (choice === 1) { fs.rmSync(LOCATION_FILE, { force: true }); return true }
  const res = dialog.showOpenDialogSync({ title: '选择数据位置（C 盘以外，且不要放在程序安装目录里）', properties: ['openDirectory', 'createDirectory'] })
  if (res) {
    try {
      const target = dataTarget(res[0])
      fs.mkdirSync(target, { recursive: true })
      fs.writeFileSync(LOCATION_FILE, JSON.stringify({ dataDir: target }))
    } catch (e) { dialog.showErrorBox('不能用这个位置', e.message) }
  }
  app.relaunch() // 用新位置重新启动；没选或选错了就再问一次
  app.exit(0)
  return false
}

app.whenReady().then(() => {
  if (missingDataDir && !resolveMissingDataDir()) return
  LIB_DIR = path.join(app.getPath('userData'), 'library')
  BOOK_DIR = path.join(LIB_DIR, 'books')
  COVER_DIR = path.join(LIB_DIR, 'covers')
  for (const d of [BOOK_DIR, COVER_DIR]) fs.mkdirSync(d, { recursive: true })
  store = new Store(LIB_DIR)
  ocr = new OcrManager({
    dir: path.join(LIB_DIR, 'ocr'),
    pageUrl: DEV_URL ? new URL('ocr.html', DEV_URL).href : 'app://bundle/ocr.html',
    notify: ev => { if (win && !win.isDestroyed()) win.webContents.send('ocr:progress', ev) },
  })
  setupProtocols()
  setupIpc()
  createWindow()
  registerBossKey()
  setTimeout(rescanLinked, 3000)
  updater.setupUpdater(state => { if (win && !win.isDestroyed()) win.webContents.send('update:state', state) })
  if (store.data.settings.autoUpdate) setTimeout(() => updater.checkForUpdates(), 5000)
  nativeTheme.on('updated', () => {
    if (store.data.settings.theme === 'system' && win) win.setTitleBarOverlay(overlayColors(isDark()))
  })
})

app.on('will-quit', () => { globalShortcut.unregisterAll(); f5.stop(); ocr?.dispose(); store?.flush() })
app.on('window-all-closed', () => app.quit())
