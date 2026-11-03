// 联网补封面：书里没有封面（或书只在云端、读不到）时，按书名去 Google Books / Open Library 找一张
// 只发书名和作者；找不到或不像同一本书就不要，宁缺毋滥

// 文件名式的书名去掉编号、出版信息、网站水印等，只留书名本身
function cleanTitle(title) {
  let t = String(title || '')
    .replace(/\.(pdf|epub|mobi|azw3?|txt|fb2|cbz)$/i, '')
    .replace(/(sobooks(\.cc)?|z-?library|1lib|zlib|www\.[\w.]+|epub\s*掌上书苑|精排|高清|扫描版|文字版|彩色|完整版|中文版|副本|copy)/gi, ' ')
    .replace(/\d{10,13}/g, ' ') // ISBN
    .replace(/^\s*([【[（(][^】\]）)]{0,10}[】\]）)][\s\-_]*)+/, '') // 开头的【精排】[美]（日）
    .replace(/^[^\p{L}\p{N}]+/u, '') // 开头的符号
    .replace(/^[\d._\-、\s]+(?=\D)/, '') // 前面的编号：0470 、01_、1、
  t = t.split(/[(（【[《》]/)[0] || t // 括号后面多是作者、出版社、版本
  t = t.split(/\s*[._]\s*(?=[^\s]*(出版社|书局|大学|著|编|译|\d{4}))/)[0]
  t = t.split(/\s+-\s+/)[0] // “书名 - 作者”
  // “作者-书名-出版社”这类连字符拼起来的中文文件名：取最长的一段
  if (/[一-龥]/.test(t) && /-/.test(t)) t = t.split('-').map(s => s.trim()).sort((a, b) => b.length - a.length)[0]
  return t.replace(/[_+]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
}

const norm = s => String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
// 字符二元组的相似度（Dice 系数），中文英文都适用
function similar(a, b) {
  a = norm(a); b = norm(b)
  if (!a || !b) return 0
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) / Math.max(a.length, b.length) >= 0.4 ? 1 : 0.5
  const grams = s => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1) } return m }
  const A = grams(a), B = grams(b)
  let hit = 0
  for (const [g, n] of A) hit += Math.min(n, B.get(g) || 0)
  return (2 * hit) / (Math.max(1, a.length - 1) + Math.max(1, b.length - 1))
}

class RateLimited extends Error {}

async function getJSON(fetch, url) {
  let res
  // 没网时别把书标成“查过了”：当作限流，整轮暂停
  try { res = await fetch(url, { headers: { 'User-Agent': 'AI-Reader (ebook cover lookup)' } }) } catch (e) { throw new RateLimited('网络不可用：' + e.message) }
  if (res.status === 429 || res.status === 403) throw new RateLimited(`请求过于频繁（${res.status}）`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

async function getImage(fetch, url) {
  const res = await fetch(url)
  if (!res.ok || !/^image\//.test(res.headers.get('content-type') || '')) return null
  const buf = Buffer.from(await res.arrayBuffer())
  return buf.length > 2500 ? buf : null // 太小的多半是“暂无封面”占位图
}

async function fromGoogle(fetch, title, author, state) {
  if (state.googleOff) return null
  const q = `intitle:${title}` + (author ? `+inauthor:${author}` : '')
  const key = state.googleKey ? `&key=${encodeURIComponent(state.googleKey)}` : ''
  let data
  try {
    data = await getJSON(fetch, `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=8&printType=books${key}`)
  } catch (e) {
    // 不带 Key 时用的是所有人共享的每日额度，常常用完；这次运行就不再找 Google 了
    if (e instanceof RateLimited) { state.googleOff = true; return null }
    throw e
  }
  for (const it of data.items || []) {
    const v = it.volumeInfo || {}
    const img = v.imageLinks?.thumbnail || v.imageLinks?.smallThumbnail
    if (!img || similar(title, v.title + (v.subtitle ? ' ' + v.subtitle : '')) < 0.6) continue
    const buf = await getImage(fetch, img.replace(/^http:/, 'https:').replace('&edge=curl', ''))
    if (buf) return buf
  }
  return null
}

async function fromOpenLibrary(fetch, title, author, _state) {
  const url = `https://openlibrary.org/search.json?title=${encodeURIComponent(title)}` + (author ? `&author=${encodeURIComponent(author)}` : '') + '&limit=8&fields=title,cover_i'
  const data = await getJSON(fetch, url)
  for (const d of data.docs || []) {
    if (!d.cover_i || similar(title, d.title) < 0.6) continue
    const buf = await getImage(fetch, `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg?default=false`)
    if (buf) return buf
  }
  return null
}

// 返回封面图片 Buffer，找不到返回 null；Open Library 也限流时抛 RateLimited（调用方暂停，下次启动再继续）
// state：{ googleKey, googleOff }，在一轮查找里共用
async function findCover(fetch, book, state = {}) {
  const title = cleanTitle(book.title) || cleanTitle(book.fileName)
  if (norm(title).length < 2) return null
  const author = /^(佚名|unknown)$/i.test(book.author || '') ? '' : (book.author || '').split(/[,，、;&]/)[0].trim()
  for (const source of [fromGoogle, fromOpenLibrary]) {
    try {
      const buf = await source(fetch, title, author, state) || (author ? await source(fetch, title, '', state) : null)
      if (buf) return buf
    } catch (e) {
      if (e instanceof RateLimited) throw e
      console.warn('封面查找失败', title, e.message)
    }
  }
  return null
}

module.exports = { findCover, cleanTitle, similar, RateLimited }
