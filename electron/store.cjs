// 书库数据：library.json（图书、文件夹、标注、设置），对话记录按书单独存放
const fs = require('fs')
const path = require('path')

const DEFAULT_SETTINGS = {
  theme: 'light', // light | dark | system
  view: 'grid', // grid | list
  sort: 'lastRead', // lastRead | added | title | author | progress
  showSubfolderItems: true,
  bossKey: 'Alt+Q',
  autoUpdate: true, // 启动时自动检查 GitHub 上的新版本
  reader: {
    fontSize: 18,
    lineHeight: 1.8,
    fontFamily: 'original',
    paraSpacing: 0.6,
    margin: 48,
    maxWidth: 760,
    flow: 'paginated', // paginated | scrolled
    columns: 1, // 1 | 2
    bg: 'auto', // auto（跟随外观）| white | sepia | green | gray | dark
    justify: true,
    pdfZoom: 'fit-page',
  },
  ai: {
    provider: 'anthropic',
    baseUrl: '',
    apiKey: '',
    model: 'claude-opus-5-5',
    targetLang: '中文',
    contextChars: 12000,
  },
}

class Store {
  constructor(dir) {
    this.dir = dir
    this.file = path.join(dir, 'library.json')
    this.chatDir = path.join(dir, 'chats')
    fs.mkdirSync(this.chatDir, { recursive: true })
    this.data = { books: [], folders: [], annotations: {}, settings: DEFAULT_SETTINGS }
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      this.data = { ...this.data, ...raw }
    } catch {}
    this.data.settings = mergeDeep(DEFAULT_SETTINGS, this.data.settings || {})
    this.timer = null
  }
  save() {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), 300)
  }
  flush() {
    clearTimeout(this.timer)
    const tmp = this.file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(this.data))
    fs.renameSync(tmp, this.file)
  }
  getChat(bookId) {
    try { return JSON.parse(fs.readFileSync(path.join(this.chatDir, bookId + '.json'), 'utf8')) } catch { return [] }
  }
  setChat(bookId, messages) {
    fs.writeFileSync(path.join(this.chatDir, bookId + '.json'), JSON.stringify(messages))
  }
  deleteChat(bookId) {
    fs.rmSync(path.join(this.chatDir, bookId + '.json'), { force: true })
  }
}

function mergeDeep(base, over) {
  const out = { ...base }
  for (const k of Object.keys(over)) {
    const v = over[k]
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object'
      ? mergeDeep(base[k], v) : v
  }
  return out
}

module.exports = { Store, mergeDeep }
