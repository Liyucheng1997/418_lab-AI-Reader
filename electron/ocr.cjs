// PDF 文字识别（OCR）：在隐藏窗口里跑 PaddleOCR，不占阅读界面；按书排队，当前页优先
// 结果按书存在 library/ocr/<书 id>.json：{ total, pages: { 页序号: { paras: [[{ t: 文字, b: [左,上,右,下] }]] } } }
const { BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')

class OcrManager {
  // dir：结果目录；pageUrl：OCR 页面地址；notify(event)：把进度发给阅读器
  constructor({ dir, pageUrl, notify }) {
    Object.assign(this, { dir, pageUrl, notify })
    fs.mkdirSync(dir, { recursive: true })
    this.data = new Map()   // bookId → { total, pages }
    this.queues = new Map() // bookId → [{ index, url }]
    this.running = null     // { bookId, index }
    this.win = null
    this.seq = 0
    this.waiting = new Map()
    ipcMain.on('ocr:done', (_e, id, result) => { const r = this.waiting.get(id); this.waiting.delete(id); r?.(result) })
  }

  file(bookId) { return path.join(this.dir, bookId + '.json') }
  get(bookId) {
    if (!this.data.has(bookId)) {
      let d = { total: 0, pages: {} }
      try { d = JSON.parse(fs.readFileSync(this.file(bookId), 'utf8')) } catch {}
      this.data.set(bookId, d)
    }
    return this.data.get(bookId)
  }
  save(bookId) {
    const tmp = this.file(bookId) + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(this.get(bookId)))
    fs.renameSync(tmp, this.file(bookId))
  }
  remove(bookId) {
    this.stop(bookId)
    this.data.delete(bookId)
    fs.rmSync(this.file(bookId), { force: true })
  }

  // 进度（不含文字）；full 时带上所有已识别页的文字（打开书时取一次）
  status(bookId, full = false) {
    const d = this.get(bookId)
    return {
      total: d.total, done: Object.keys(d.pages).length,
      queued: this.queues.get(bookId)?.length || 0, running: this.running?.bookId === bookId ? this.running.index : null,
      ...(full ? { pages: d.pages } : {}),
    }
  }

  // indices：要识别的页（0 起）；front：插到最前面（当前正在看的页）
  request(bookId, url, indices, total, front = false) {
    const d = this.get(bookId)
    if (total) d.total = total
    const q = this.queues.get(bookId) || []
    const todo = indices.filter(i => !d.pages[i] && !q.some(t => t.index === i) && this.running?.index !== i)
    const tasks = todo.map(index => ({ index, url }))
    this.queues.set(bookId, front ? [...tasks, ...q] : [...q, ...tasks])
    if (front) this.focus = bookId
    this.loop()
    return this.status(bookId)
  }
  stop(bookId) {
    this.queues.delete(bookId)
    this.notify({ bookId, stopped: true, ...this.status(bookId) })
  }

  ensureWindow() {
    if (this.disposed) return Promise.reject(new Error('程序正在退出'))
    if (this.win && !this.win.isDestroyed()) return this.ready
    this.win = new BrowserWindow({
      show: false,
      webPreferences: { preload: path.join(__dirname, 'ocr-preload.cjs'), contextIsolation: true, backgroundThrottling: false },
    })
    this.ready = new Promise(resolve => ipcMain.once('ocr:ready', (_e, info) => resolve(info)))
    this.win.on('closed', () => {
      this.win = null
      for (const r of this.waiting.values()) r({ error: 'OCR 窗口已关闭' })
      this.waiting.clear()
    })
    this.win.loadURL(this.pageUrl)
    return this.ready
  }
  async run(task) {
    try { await this.ensureWindow() } catch (e) { return { error: e.message } }
    const id = ++this.seq
    return new Promise(resolve => {
      this.waiting.set(id, resolve)
      this.win.webContents.send('ocr:task', { id, url: task.url, page: task.index + 1 })
    })
  }

  async loop() {
    if (this.looping) return
    this.looping = true
    try {
      for (;;) {
        // 先做正在看的这本书，再做其他排队的书
        const bookId = this.queues.get(this.focus)?.length ? this.focus : [...this.queues.keys()].find(k => this.queues.get(k).length)
        if (!bookId) break
        const task = this.queues.get(bookId).shift()
        if (!this.queues.get(bookId).length) this.queues.delete(bookId)
        const d = this.get(bookId)
        if (d.pages[task.index]) continue
        this.running = { bookId, index: task.index }
        this.notify({ bookId, ...this.status(bookId) })
        const res = await this.run(task)
        this.running = null
        if (res.error) { this.notify({ bookId, index: task.index, error: res.error, ...this.status(bookId) }); continue }
        d.total = res.total || d.total
        d.pages[task.index] = { paras: res.paras }
        this.save(bookId)
        this.notify({ bookId, index: task.index, page: d.pages[task.index], ...this.status(bookId) })
      }
    } finally {
      this.looping = false
      this.running = null
      // 全部做完后关掉窗口，释放模型占用的内存
      if (!this.queues.size && this.win && !this.win.isDestroyed()) this.win.close()
    }
  }

  // 退出时：清空队列、不再开新窗口，关掉隐藏窗口（否则它会让程序在后台一直挂着）
  dispose() {
    this.disposed = true
    this.queues.clear()
    for (const r of this.waiting.values()) r({ error: '程序正在退出' })
    this.waiting.clear()
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
  }
}

module.exports = { OcrManager }
