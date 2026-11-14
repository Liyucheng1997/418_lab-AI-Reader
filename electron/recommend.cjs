// 为你推荐：阅读画像 → AI 书单 → 补封面、匹配已配置的在线书源
const { cleanTitle, similar } = require('./covers.cjs')

const DAY = 864e5

// ---------- 阅读画像 ----------
// 读完、读得多、收藏、做过标注、最近读过的书权重高；翻了开头就放下很久的书单独列出来，当作“不太对胃口”的信号
function buildProfile(books, annotations, now = Date.now()) {
  const rows = []
  for (const b of books) {
    const anns = (annotations[b.id] || []).filter(a => a.type !== 'bookmark')
    const progress = Math.min(1, b.progress || 0)
    const days = b.lastReadAt ? (now - b.lastReadAt) / DAY : Infinity
    let score = 0
    if (b.status === 'finished') score += 3
    score += progress * 2
    if (b.favorite) score += 2
    score += Math.min(anns.length, 20) * 0.15
    if (b.lastReadAt) score += 0.5 + 1.5 * Math.exp(-days / 60)
    if (!score) continue
    const dropped = b.status !== 'finished' && !b.favorite && b.lastReadAt && progress < 0.08 && days > 30 && !anns.length
    const title = cleanTitle(b.title) || cleanTitle(b.fileName) || b.title
    rows.push({
      id: b.id, title, author: (b.author || '').trim(), score, dropped,
      state: b.status === 'finished' ? '读完' : progress >= 0.05 ? `读到 ${Math.round(progress * 100)}%` : '翻过开头',
      favorite: !!b.favorite,
      notes: anns.length,
      quotes: anns.map(a => String(a.text || '').replace(/\s+/g, ' ').trim()).filter(t => t.length >= 6).slice(-2).map(t => t.slice(0, 50)),
    })
  }
  rows.sort((a, b) => b.score - a.score)
  const liked = rows.filter(r => !r.dropped).slice(0, 40)
  const dropped = rows.filter(r => r.dropped).slice(0, 12)
  // 一本都没读过时，就看书库里有什么（随机抽一些，书库可能有几千本）
  let shelf = []
  if (!liked.length) {
    const pool = books.slice()
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]] }
    shelf = pool.slice(0, 40).map(b => ({ title: cleanTitle(b.title) || b.title, author: (b.author || '').trim() }))
  }
  return { liked, dropped, shelf, total: books.length }
}

function profileText(p) {
  const line = r => `《${r.title}》${r.author ? ' ' + r.author : ''}（${[r.state, r.favorite && '收藏', r.notes && `${r.notes} 条标注`].filter(Boolean).join('，')}）`
    + (r.quotes?.length ? ` 划线：${r.quotes.map(q => `“${q}”`).join(' ')}` : '')
  const parts = []
  if (p.liked.length) parts.push('按兴趣从高到低，我读过/在读/收藏的书：\n' + p.liked.map((r, i) => `${i + 1}. ${line(r)}`).join('\n'))
  if (p.dropped.length) parts.push('翻了开头就放下很久的书（可能不太对胃口）：\n' + p.dropped.map(r => `- 《${r.title}》${r.author ? ' ' + r.author : ''}`).join('\n'))
  if (p.shelf.length) parts.push('我还没开始读，但书库里有这些书（能看出大致兴趣）：\n' + p.shelf.map(r => `- 《${r.title}》${r.author ? ' ' + r.author : ''}`).join('\n'))
  return parts.join('\n\n')
}

// ---------- 让 AI 出书单 ----------
const SYSTEM = `你是一位博览群书、眼光很好的图书编辑，根据读者的阅读记录推荐他接下来值得读的书。
要求：
- 只推荐真实存在、能买到或借到的书，书名和作者必须准确，宁可少推也不要编造。
- 推荐理由要具体：说清楚和他读过的哪本书、哪种兴趣相关，或者能补上什么视角；不要空泛的夸奖。
- 大约七成贴近他的口味（kind = "similar"），三成帮他拓展视野、但仍有内在联系（kind = "explore"）。
- 不要推荐他已经读过或书库里已有的书，也不要推荐“不要推荐”列表里的书。
- 中文书用中文书名；外国作品用通行的中文译名，并在 originalTitle / originalAuthor 里给出原文书名和作者原名。
只输出一个 JSON 数组，不要任何其他文字。每一项：
{"title":"","author":"","originalTitle":"","originalAuthor":"","year":"","tags":["",""],"reason":"不超过 70 字","kind":"similar"}`

function extractJSON(text) {
  const start = text.indexOf('['), end = text.lastIndexOf(']')
  if (start < 0 || end < start) throw new Error('AI 没有按格式返回书单，请再试一次。')
  try { return JSON.parse(text.slice(start, end + 1)) } catch { throw new Error('AI 返回的书单格式不对，请再试一次。') }
}

async function askAI(streamChat, cfg, profile, { wish, avoid, count }) {
  const msg = [
    profileText(profile) || '我的书库还是空的。',
    wish ? `我现在想读的方向：${wish}` : '',
    avoid.length ? `不要推荐（已推荐过或我不感兴趣）：${avoid.map(t => `《${t}》`).join('、')}` : '',
    `请推荐 ${count} 本书。`,
  ].filter(Boolean).join('\n\n')
  let text = ''
  await streamChat(cfg, { system: SYSTEM, messages: [{ role: 'user', content: msg }] }, t => { text += t })
  const list = extractJSON(text)
  if (!Array.isArray(list)) throw new Error('AI 返回的书单格式不对，请再试一次。')
  return list
    .filter(x => x && typeof x.title === 'string' && x.title.trim())
    .map(x => ({
      title: x.title.trim().replace(/^《|》$/g, ''),
      author: String(x.author || '').trim(),
      originalTitle: String(x.originalTitle || '').trim(),
      originalAuthor: String(x.originalAuthor || '').trim(),
      year: String(x.year || '').trim(),
      tags: Array.isArray(x.tags) ? x.tags.map(String).slice(0, 3) : [],
      reason: String(x.reason || '').trim(),
      kind: x.kind === 'explore' ? 'explore' : 'similar',
    }))
}

// ---------- 联网补充：封面、在线书源 ----------
async function getJSON(fetch, url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'AI-Reader (book recommendations)' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

async function findCoverURL(fetch, item, googleKey) {
  const tries = [[item.title, item.author], [item.originalTitle, item.originalAuthor]].filter(([t]) => t)
  for (const [title, author] of tries) {
    try {
      const q = `intitle:${title}` + (author ? `+inauthor:${author.split(/[,，、]/)[0]}` : '')
      const key = googleKey ? `&key=${encodeURIComponent(googleKey)}` : ''
      const data = await getJSON(fetch, `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=6&printType=books${key}`)
      for (const it of data.items || []) {
        const v = it.volumeInfo || {}
        const img = v.imageLinks?.thumbnail || v.imageLinks?.smallThumbnail
        if (img && similar(title, v.title) >= 0.6) return img.replace(/^http:/, 'https:').replace('&edge=curl', '')
      }
    } catch {}
    try {
      const data = await getJSON(fetch, `https://openlibrary.org/search.json?title=${encodeURIComponent(title)}${author ? `&author=${encodeURIComponent(author)}` : ''}&limit=6&fields=title,cover_i`)
      const d = (data.docs || []).find(d => d.cover_i && similar(title, d.title) >= 0.6)
      if (d) return `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg`
    } catch {}
  }
  return ''
}

async function enrich(fetch, items, googleKey, findSource = null) {
  let i = 0
  const worker = async () => {
    while (i < items.length) {
      const it = items[i++]
      const [cover, free] = await Promise.all([
        findCoverURL(fetch, it, googleKey).catch(() => ''),
        findSource ? findSource(it).catch(err => { it.sourceError = err.message; return null }) : null,
      ])
      it.cover = cover
      it.free = free
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()])
  return items
}

// 推荐的书若已在书库里，就不要
function inLibrary(item, books) {
  const names = [item.title, item.originalTitle].filter(Boolean)
  return books.some(b => {
    const t = cleanTitle(b.title) || b.title
    return names.some(n => similar(n, t) >= 0.85)
  })
}

// ---------- 从书库里挑：本地算法，不联网 ----------
// 以读过/收藏的书为种子，给书库里还没读的书打分：
//   同一作者 > 书名相近（同系列、续作）> 所在文件夹的兴趣浓度（按文件夹层级向上传递、按文件夹大小归一）
// 再加一点“最近加入书库”的分；每个文件夹、每位作者限量，避免一整屏都是同一类
function authorKeys(a) {
  return String(a || '')
    .replace(/[[【(（〔][^\]】)）〕]{1,8}[\]】)）〕]/g, ' ') // [美]（清）
    .split(/[,，、;；&/|]|\s+and\s+|\s{2,}/i)
    .map(s => s.replace(/(编著|主编|编绘|编译|译注|著|编|译|绘|撰|等)$/, '').replace(/[\s·.•]/g, '').toLowerCase())
    // PDF 元数据里常混着 author、editor 这类角色词，不能当作者名
    .filter(s => s.length >= 2 && !/^(佚名|unknown|anonymous|作者|未知|author|editor|translator|illustrator|contributor|compiler|eds?|trans|etc)$/.test(s))
}

const normRaw = s => String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')

function libraryPicks(books, folders, annotations, { dismissed = [], limit = 12, poolSize = 0, now = Date.now() } = {}) {
  const profile = buildProfile(books, annotations, now)
  const seeds = profile.liked
  const byId = new Map(books.map(b => [b.id, b]))
  const parent = new Map(folders.map(f => [f.id, f.parentId || null]))
  const fname = new Map(folders.map(f => [f.id, f.name]))
  const label = f => String(fname.get(f) || '').replace(/^[\d.]+[_、.\s]+/, '').replace(/\s*\d+\s*本$/, '') || fname.get(f)
  const chain = f => { const out = []; while (f && !out.includes(f)) { out.push(f); f = parent.get(f) } return out }

  // 每个文件夹（含子文件夹）里有多少本书
  const size = new Map()
  for (const b of books) {
    const hit = new Set(b.folders.flatMap(chain))
    for (const f of hit) size.set(f, (size.get(f) || 0) + 1)
  }
  // 文件夹兴趣：种子书所在的文件夹得分最多，往上每层减半
  const interest = new Map()
  for (const s of seeds) {
    const seen = new Set()
    for (const f0 of byId.get(s.id)?.folders || []) {
      chain(f0).forEach((f, depth) => {
        if (seen.has(f)) return
        seen.add(f)
        const add = s.score * 0.5 ** depth
        const cur = interest.get(f) || { w: 0, seeds: [] }
        cur.w += add
        cur.seeds.push(s)
        interest.set(f, cur)
      })
    }
  }
  const seedAuthors = seeds.map(s => ({ s, keys: authorKeys(s.author) })).filter(x => x.keys.length)
  const seedIds = new Set(seeds.map(s => s.id))
  const droppedIds = new Set(profile.dropped.map(r => r.id))
  const skip = new Set(dismissed)

  const scored = []
  for (const b of books) {
    if (seedIds.has(b.id) || droppedIds.has(b.id) || skip.has(b.id)) continue
    if (b.status === 'finished' || (b.progress || 0) >= 0.05) continue
    const title = cleanTitle(b.title) || cleanTitle(b.fileName) || b.title
    // 同一本书的另一份文件（书名完全一样）不算推荐
    if (seeds.some(s => normRaw(byId.get(s.id)?.title) === normRaw(b.title))) continue
    const parts = []
    // 同一作者
    const keys = authorKeys(b.author)
    if (keys.length) {
      const m = seedAuthors.filter(x => x.keys.some(k => keys.includes(k))).sort((x, y) => y.s.score - x.s.score)[0]
      if (m) parts.push({ kind: 'author', score: m.s.score * 0.8, seed: m.s })
    }
    // 书名相近：同系列、上下册、续作
    let bestT = null
    for (const s of seeds) {
      if (normRaw(title).length < 4 || normRaw(s.title).length < 4) continue // 太短的书名（如“老子”）匹配不可靠
      const sim = similar(title, s.title)
      if (sim >= 0.6 && (!bestT || sim * s.score > bestT.score)) bestT = { kind: 'title', score: s.score * 0.6 * sim, seed: s }
    }
    if (bestT) parts.push(bestT)
    // 文件夹兴趣
    let bestF = null
    for (const f0 of b.folders) {
      chain(f0).forEach((f, depth) => {
        const it = interest.get(f)
        if (!it) return
        const sc = (it.w * 0.5 ** depth) / Math.sqrt(size.get(f) || 1)
        if (!bestF || sc > bestF.score) bestF = { kind: 'folder', score: sc, folder: f, seed: it.seeds.sort((x, y) => y.score - x.score)[0] }
      })
    }
    if (bestF) parts.push(bestF)
    const fresh = b.addedAt ? 0.4 * Math.exp(-(now - b.addedAt) / DAY / 30) : 0
    const score = parts.reduce((n, p) => n + p.score, 0) + fresh
    if (!score) continue
    parts.sort((x, y) => y.score - x.score)
    scored.push({ b, title, score, parts, fresh })
  }
  scored.sort((x, y) => y.score - x.score)

  const reasonOf = x => {
    const p = x.parts[0]
    if (!p) return '最近加入书库，还没开始读'
    const seed = `《${p.seed.title}》`
    if (p.kind === 'author') return `和你${p.seed.state === '读完' ? '读完' : p.seed.favorite ? '收藏' : '读过'}的${seed}是同一位作者`
    if (p.kind === 'title') return `书名和${seed}相近，可能是同一系列或续作`
    const sameDir = byId.get(p.seed.id)?.folders.some(f => chain(f).includes(p.folder))
    return `在「${label(p.folder)}」里${sameDir ? `，你读过这里的${seed}` : ''}`
  }
  // 去重：每个文件夹最多 3 本，每位作者最多 2 本
  const perFolder = new Map(), perAuthor = new Map()
  const items = []
  for (const x of scored) {
    if (items.length >= limit) break
    const f = x.parts[0]?.kind === 'folder' ? x.parts[0].folder : x.b.folders[0] || '-'
    const a = authorKeys(x.b.author)[0] || x.b.id
    if ((perFolder.get(f) || 0) >= 3 || (perAuthor.get(a) || 0) >= 2) continue
    perFolder.set(f, (perFolder.get(f) || 0) + 1)
    perAuthor.set(a, (perAuthor.get(a) || 0) + 1)
    items.push({ bookId: x.b.id, reason: reasonOf(x), kind: x.parts[0]?.kind || 'new', score: Math.round(x.score * 100) / 100 })
  }

  // 交给 AI 精选的候选：本地分数高的 + 随机一些（让“想读的方向”也能挑到别的书）
  let pool = []
  if (poolSize) {
    const top = scored.slice(0, Math.round(poolSize * 0.7))
    const topIds = new Set(top.map(x => x.b.id))
    const rest = books.filter(b => !topIds.has(b.id) && !seedIds.has(b.id) && !droppedIds.has(b.id) && !skip.has(b.id)
      && b.status !== 'finished' && (b.progress || 0) < 0.05)
    for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]] }
    pool = [...top.map(x => x.b), ...rest.slice(0, poolSize - top.length)].map(b => ({
      id: b.id, title: cleanTitle(b.title) || b.title, author: (b.author || '').trim(),
      folder: (b.folders[0] ? chain(b.folders[0]).reverse().slice(1).map(label) : []).slice(-3).join(' / '),
    }))
  }
  const unread = books.filter(b => b.status !== 'finished' && (b.progress || 0) < 0.05).length
  return { items, pool, profile, unread, seeds: seeds.length }
}

const LIB_SYSTEM = `你是读者的私人图书顾问。读者的书库里有很多还没读的书，请根据他的阅读记录和当前想读的方向，从给出的候选书里挑出最值得先读的几本。
要求：
- 只能从候选列表里挑，用候选前面的编号指代。
- 理由要具体：联系他读过的书或他想读的方向，说明为什么现在读这本；不要空泛夸奖，不超过 50 字。
- 兼顾口味和多样性，不要都挑同一类。
只输出 JSON 数组，不要任何其他文字，每一项：{"i": 编号, "reason": "理由"}`

async function askLibraryAI(streamChat, cfg, profile, pool, { wish, count }) {
  const list = pool.map((c, i) => `${i + 1}. 《${c.title}》${c.author ? ' ' + c.author : ''}${c.folder ? ` ｜ ${c.folder}` : ''}`).join('\n')
  const msg = [
    profileText({ ...profile, shelf: [] }) || '我还没读过什么书。',
    wish ? `我现在想读的方向：${wish}` : '',
    `书库里还没读的候选书：\n${list}`,
    `请挑 ${count} 本。`,
  ].filter(Boolean).join('\n\n')
  let text = ''
  await streamChat(cfg, { system: LIB_SYSTEM, messages: [{ role: 'user', content: msg }] }, t => { text += t })
  const seen = new Set()
  return extractJSON(text)
    .map(x => ({ c: pool[Number(x?.i) - 1], reason: String(x?.reason || '').trim() }))
    .filter(x => x.c && !seen.has(x.c.id) && seen.add(x.c.id))
    .map(x => ({ bookId: x.c.id, reason: x.reason, kind: 'ai' }))
}

module.exports = { buildProfile, askAI, enrich, inLibrary, libraryPicks, askLibraryAI }
