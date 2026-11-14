// EAPI adapter. Credentials stay in the main process and are encrypted at rest.
const fs = require('fs')
const path = require('path')
const { similar } = require('./covers.cjs')

const FORMATS = ['epub', 'pdf']
const MAX_BYTES = 150 * 1024 * 1024

function origin(value) {
  let u
  try { u = new URL(String(value).trim()) } catch { throw new Error('请输入完整的 HTTPS 书源地址') }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.pathname !== '/' || u.search || u.hash) {
    throw new Error('书源地址必须是 HTTPS 域名，不能包含路径、端口或账号信息')
  }
  return u.origin
}

function session(value) {
  const baseUrl = origin(value.baseUrl)
  const userId = String(value.userId || '').trim()
  const userKey = String(value.userKey || '').trim()
  if (!/^\d+$/.test(userId) || !/^[a-zA-Z0-9_-]{8,512}$/.test(userKey)) throw new Error('请填写有效的 remix_userid 和 remix_userkey')
  return { baseUrl, userId, userKey }
}

function sourceError(data, status) {
  const raw = String(data?.error?.message || data?.error || data?.message || '')
  if (/credential|login|authoriz|session/i.test(raw) || status === 401) return new Error('Z-Library 登录已失效，请在设置 → 在线书源更新会话')
  if (/limit|quota/i.test(raw) || status === 429) return new Error('Z-Library 下载额度或请求次数已达上限，请稍后再试')
  return new Error(`Z-Library 请求失败${raw ? `：${raw.slice(0, 180)}` : `（HTTP ${status}）`}`)
}

class ZLibrary {
  constructor(fetch, cfg) { this.fetch = fetch; this.cfg = session(cfg) }

  headers() {
    return { 'User-Agent': 'AI-Reader', 'remix-userid': this.cfg.userId, 'remix-userkey': this.cfg.userKey,
      Cookie: `remix_userid=${this.cfg.userId}; remix_userkey=${this.cfg.userKey}` }
  }

  async request(endpoint, body) {
    let res
    try {
      res = await this.fetch(this.cfg.baseUrl + endpoint, {
        method: body ? 'POST' : 'GET', redirect: 'manual', credentials: 'omit',
        headers: { ...this.headers(), Accept: 'application/json', ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
        body: body?.toString(), signal: AbortSignal.timeout(20000),
      })
    } catch { throw new Error('Z-Library 连接失败或超时，请检查书源地址和网络') }
    if (res.status >= 300 && res.status < 400) throw new Error('书源返回重定向，请在设置中填写可直接访问 EAPI 的地址')
    let data
    try { data = await res.json() } catch { throw new Error('书源未返回 EAPI 数据，可能需要网页验证或更换地址') }
    if (!res.ok || Number(data?.success) !== 1) throw sourceError(data, res.status)
    return data
  }

  async profile() {
    const { user } = await this.request('/eapi/user/profile')
    if (!user?.id || String(user.id) !== this.cfg.userId) throw new Error('书源未确认当前账号，请更新会话')
    return { name: String(user.name || ''), used: user.downloads_today ?? user.dailyDownloadsCount,
      limit: user.downloads_limit ?? user.dailyDownloadLimit }
  }

  async find(item) {
    const tries = [[item.title, item.author], [item.originalTitle, item.originalAuthor]].filter(([t]) => t)
    for (const [title, author] of tries) {
      const body = new URLSearchParams({ message: `${title} ${author || ''}`.trim(), page: '1', limit: '30' })
      FORMATS.forEach(ext => body.append('extensions[]', ext))
      const data = await this.request('/eapi/book/search', body)
      if (!Array.isArray(data.books)) throw new Error('Z-Library 检索数据格式发生变化')
      const norm = s => String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
      const candidates = data.books.filter(b => {
        if (!/^\d+$/.test(String(b.id)) || !/^[a-zA-Z0-9_-]+$/.test(String(b.hash || ''))) return false
        if (!FORMATS.includes(String(b.extension).toLowerCase()) || similar(title, b.title) < 0.8) return false
        const a = norm(author), actual = norm(b.author)
        return !a || (actual && (a.includes(actual) || actual.includes(a) || similar(a, actual) >= 0.6))
      })
      candidates.sort((a, b) => {
        const score = b => similar(title, b.title) * 10 + (/chinese|中文|汉语|^zh$/i.test(b.language) ? 2 : 0) + (String(b.extension).toLowerCase() === 'epub' ? 1 : 0)
        return score(b) - score(a)
      })
      if (candidates.length) {
        const b = candidates[0]
        return { source: 'Z-Library', id: String(b.id), hash: b.hash, title: b.title, author: b.author,
          format: String(b.extension).toLowerCase(), lang: String(b.language || ''), size: String(b.filesizeString || '') }
      }
    }
    return null
  }

  async download(book) {
    if (!/^\d+$/.test(book.id) || !/^[a-zA-Z0-9_-]+$/.test(book.hash) || !FORMATS.includes(book.format)) throw new Error('无效的书源版本，请重新查找')
    const data = await this.request(`/eapi/book/${book.id}/${book.hash}/file`)
    const link = data.file?.downloadLink || data.downloadLink || data.url || data.link
    if (!link) throw new Error('Z-Library 没有返回下载链接，可能已无下载额度或文件已下架')
    let url = new URL(link, this.cfg.baseUrl)
    const signal = AbortSignal.timeout(120000)
    // Do not forward account headers to a download CDN or a redirected host.
    for (let redirects = 0; redirects < 6; redirects++) {
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('书源返回了不安全的下载地址')
      const res = await this.fetch(url.href, { redirect: 'manual', credentials: 'omit', signal,
        headers: url.origin === this.cfg.baseUrl ? this.headers() : { 'User-Agent': 'AI-Reader' } })
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location')
        if (!location) throw new Error('下载重定向缺少地址')
        url = new URL(location, url); continue
      }
      if (!res.ok) throw sourceError(null, res.status)
      if (Number(res.headers.get('content-length')) > MAX_BYTES) throw new Error('文件超过 150 MB，请到书源网站下载后手动导入')
      const chunks = []; let size = 0
      const reader = res.body.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.length
          if (size > MAX_BYTES) throw new Error('文件超过 150 MB，请手动下载导入')
          chunks.push(Buffer.from(value))
        }
      } finally { await reader.cancel().catch(() => {}) }
      const buf = Buffer.concat(chunks)
      const valid = book.format === 'pdf' ? buf.subarray(0, 5).toString() === '%PDF-'
        : buf.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4])) && buf.includes(Buffer.from('application/epub+zip'))
      if (buf.length < 100 || !valid) throw new Error('下载内容不是有效的 EPUB / PDF，可能返回了登录或验证页面')
      return buf
    }
    throw new Error('下载重定向次数过多，请检查书源地址')
  }
}

class SessionStore {
  constructor(dir, safeStorage) { this.file = path.join(dir, 'zlibrary-session.json'); this.safe = safeStorage }
  read() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      return session({ baseUrl: raw.baseUrl, ...JSON.parse(this.safe.decryptString(Buffer.from(raw.secret, 'base64'))) })
    } catch { return null }
  }
  state() { const cfg = this.read(); return { configured: !!cfg, baseUrl: cfg?.baseUrl || '', userId: cfg?.userId || '' } }
  save(value) {
    const cfg = session(value)
    if (!this.safe.isEncryptionAvailable()) throw new Error('系统加密服务不可用，无法保存书源会话')
    const secret = this.safe.encryptString(JSON.stringify({ userId: cfg.userId, userKey: cfg.userKey })).toString('base64')
    fs.writeFileSync(this.file + '.tmp', JSON.stringify({ baseUrl: cfg.baseUrl, secret }))
    fs.renameSync(this.file + '.tmp', this.file)
    return this.state()
  }
  clear() { fs.rmSync(this.file, { force: true }); return this.state() }
}

module.exports = { ZLibrary, SessionStore, origin }
