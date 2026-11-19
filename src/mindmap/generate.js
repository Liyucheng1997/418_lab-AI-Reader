// 把整本书交给 AI 整理成思维导图：
// 1. 取全书文字，按章节标记切成若干段；
// 2. 每段让 AI 抽取人物、人物关系、概念、地点、情节（并行，结果逐段保存，可中断后继续）；
// 3. 本地按名字 / 别名合并；
// 4. 再让 AI 各整合一次“人物与关系”和“概念、主题、情节脉络”，得到最终导图数据。
// 任务不跟界面绑定：关掉导图窗口也会在后台继续，再打开能看到进度。
import { openBookRecord } from '../lib/foliate.js'
import { ocrPageText } from '../reader/ocrLayer.js'

export const DETAIL = {
  fast: { label: '快速', chunk: 80000, hint: '分段少、速度快，适合先看个大概' },
  normal: { label: '标准', chunk: 40000, hint: '兼顾速度和细节' },
  fine: { label: '精细', chunk: 20000, hint: '分段多，次要人物和概念也能抓到' },
}
const CONCURRENCY = 3
const VERSION = 1

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36)

// ---------- 取全书文字 ----------
const flatToc = (items, out = []) => {
  for (const it of items || []) { out.push(it); flatToc(it.subitems, out) }
  return out
}
const clean = t => (t || '').replace(/[ \t 　]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim()

// 返回 [{ label, text }]，label 是章节名（PDF 为页码）
async function bookParts(record) {
  const book = await openBookRecord(record)
  try {
    if (book.pdf) {
      let ocr = {}
      try { ocr = (await window.api.ocrGet(record.id))?.pages || {} } catch {}
      const parts = []
      for (let i = 0; i < book.pdf.numPages; i++) {
        let t = ''
        try {
          const tc = await (await book.pdf.getPage(i + 1)).getTextContent()
          t = tc.items.map(x => x.str + (x.hasEOL ? '\n' : '')).join('')
        } catch {}
        if (!/[\p{L}\p{N}]{20}/u.test(t.replace(/\s/g, ''))) t = ocrPageText(ocr[i]) || t // 扫描页用 OCR 结果
        t = clean(t)
        if (t) parts.push({ label: `第 ${i + 1} 页`, text: t })
      }
      return parts
    }
    // 章节名：目录项指向的 section
    const names = {}
    for (const item of flatToc(book.toc)) {
      try {
        const idx = (await book.resolveHref?.(item.href))?.index
        if (idx != null && !names[idx] && item.label?.trim()) names[idx] = item.label.trim()
      } catch {}
    }
    const parts = []
    let last = ''
    for (let i = 0; i < (book.sections?.length || 0); i++) {
      const s = book.sections[i]
      if (!s?.createDocument) continue
      let doc
      try { doc = await s.createDocument() } catch { continue }
      const text = clean(doc?.body?.innerText ?? doc?.body?.textContent)
      if (!text) continue
      last = names[i] || last
      parts.push({ label: names[i] || last || '', text })
    }
    return parts
  } finally {
    book.destroy?.()
  }
}

// 按字数切段：段内保留【章节】标记，方便 AI 标注章节
export function makeChunks(parts, size) {
  const chunks = []
  let cur = null
  const push = () => { if (cur?.text.trim()) chunks.push(cur); cur = null }
  for (const p of parts) {
    let text = p.text
    let marked = false
    while (text) {
      if (!cur) cur = { text: '', from: p.label, to: p.label }
      if (!marked && p.label) { cur.text += `\n【${p.label}】\n`; marked = true }
      const room = size - cur.text.length
      if (text.length <= room) {
        cur.text += text + '\n'
        cur.to = p.label || cur.to
        text = ''
      } else {
        // 在段落或句子处断开
        let cut = text.lastIndexOf('\n', room)
        if (cut < room * 0.6) cut = Math.max(text.lastIndexOf('。', room), text.lastIndexOf('. ', room)) + 1
        if (cut < room * 0.6) cut = room
        cur.text += text.slice(0, cut)
        cur.to = p.label || cur.to
        text = text.slice(cut).trim()
        push()
        marked = false
      }
    }
  }
  push()
  return chunks.map(c => ({ text: c.text.trim(), range: c.from === c.to ? c.from : `${c.from || '开头'} — ${c.to || '结尾'}` }))
}

// 同一本书的文字只取一次
const textCache = new Map()
export async function bookText(record) {
  if (!textCache.has(record.id)) {
    const p = bookParts(record).then(parts => ({ parts, total: parts.reduce((n, p) => n + p.text.length, 0) }))
    textCache.set(record.id, p)
    p.catch(() => textCache.delete(record.id))
  }
  return textCache.get(record.id)
}

// ---------- 调用 AI ----------
class Cancelled extends Error {}

async function callAI(system, user, signal) {
  if (signal?.aborted) throw new Cancelled()
  const reqId = uid()
  let out = ''
  const off = window.api.onAiDelta((id, t) => { if (id === reqId) out += t })
  const onAbort = () => window.api.aiAbort(reqId)
  signal?.addEventListener('abort', onAbort)
  try {
    const res = await window.api.aiChat(reqId, { system, messages: [{ role: 'user', content: user }] })
    if (signal?.aborted) throw new Cancelled()
    if (!res.ok) throw new Error(res.error || 'AI 请求失败')
    return out
  } finally {
    off()
    signal?.removeEventListener('abort', onAbort)
  }
}

// 模型输出被截断时也尽量救回已完整的部分
export function parseJSON(raw) {
  let s = String(raw || '').replace(/```(?:json)?/gi, '')
  const start = s.indexOf('{')
  if (start < 0) throw new Error('AI 没有返回 JSON')
  s = s.slice(start)
  const end = s.lastIndexOf('}')
  try { return JSON.parse(s.slice(0, end + 1)) } catch {}
  const stack = []
  let inStr = false, esc = false, safe = -1, safeStack = []
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']')
    else if (c === '}' || c === ']') {
      stack.pop()
      if (!stack.length) return JSON.parse(s.slice(0, i + 1))
      safe = i
      safeStack = [...stack]
    }
  }
  if (safe < 0) throw new Error('AI 返回的 JSON 不完整')
  return JSON.parse(s.slice(0, safe + 1) + safeStack.reverse().join(''))
}

const SYSTEM = '你是一位细致的读书笔记整理者，负责从书籍文字中提取结构化信息，用来生成思维导图。只输出一个 JSON 对象，不要输出任何解释、前言或 Markdown 代码块标记。所有文字用简体中文（专有名词可保留原文）。'

const bookLine = record => `书名：《${record.title}》${record.author ? `　作者：${record.author}` : ''}`

function chunkPrompt(record, chunk, i, n) {
  return `${bookLine(record)}
这是全书第 ${i + 1}/${n} 段${chunk.range ? `（${chunk.range}）` : ''}。原文里用【】标出了章节名。请从这段原文中提取：

1. characters：人物（小说里的角色；非虚构书中被讨论或引用的人物）。name 用最常用的称呼；aliases 列出原文中的其他称呼（字、号、昵称、头衔、外号）；importance 1~5 表示在这段中的重要程度；desc 一句话说明这个人是谁、在这段里做了什么（≤50字）；traits 性格或特点关键词（≤3个）。如果原文不是中文，name 用中文通行译名，aliases 里必须包含原文写法。最多 25 个，只出现一次、没有作用的路人不要。
2. relations：人物之间的关系。from、to 用 characters 里的 name；type 为简短的关系词（如 父子、夫妻、师徒、主仆、恋人、对手、盟友、上下级、思想继承）；desc ≤25字。最多 30 条。
3. concepts：重要的概念、术语、思想、理论、组织/势力、门派、器物或制度。name；category 从 [核心思想, 术语, 组织势力, 器物, 制度规则, 其他] 中选；desc ≤50字；related 相关的人物或概念名（≤4个）；original 原文写法（原文不是中文时填写，否则留空）。最多 20 个。
4. places：重要地点。name；desc ≤30字；original 原文写法（原文不是中文时填写）。最多 10 个。
5. events：这段的关键情节（非虚构书则是关键论点或论证步骤），按出现顺序。title ≤12字；chapter 填所在的章节名；desc ≤50字；people 参与人物的 name。最多 8 个。

没有的类别给空数组。只输出：
{"characters":[],"relations":[],"concepts":[],"places":[],"events":[]}

<book_excerpt>
${chunk.text}
</book_excerpt>`
}

// ---------- 本地合并 ----------
const keyOf = s => String(s || '').toLowerCase().replace(/[\s·・.\-_—'"“”‘’《》()（）]/g, '')
const arr = x => Array.isArray(x) ? x : []
const str = x => typeof x === 'string' ? x.trim() : x == null ? '' : String(x).trim()
const pushUniq = (list, v, max) => { if (v && !list.includes(v) && list.length < max) list.push(v) }

class Index {
  constructor() { this.items = []; this.map = new Map() }
  find(names) {
    for (const n of names) { const e = this.map.get(keyOf(n)); if (e) return e }
    return null
  }
  add(names, make) {
    names = names.map(str).filter(Boolean)
    if (!names.length) return null
    let e = this.find(names)
    if (!e) { e = make(names[0]); this.items.push(e) }
    for (const n of names) if (keyOf(n) && !this.map.has(keyOf(n))) this.map.set(keyOf(n), e)
    return e
  }
}

export function mergeChunks(results) {
  const people = new Index(), concepts = new Index(), places = new Index()
  const rels = new Map()
  const events = []
  results.forEach((r, ci) => {
    if (!r) return
    for (const c of arr(r.characters)) {
      const e = people.add([c.name, ...arr(c.aliases)], name => ({ name, aliases: [], descs: [], traits: [], chunks: [], score: 0 }))
      if (!e) continue
      for (const a of [c.name, ...arr(c.aliases)].map(str)) if (a && a !== e.name) pushUniq(e.aliases, a, 8)
      pushUniq(e.descs, str(c.desc), 8)
      for (const t of arr(c.traits)) pushUniq(e.traits, str(t), 8)
      if (!e.chunks.includes(ci)) { e.chunks.push(ci); e.score += 1 + (Number(c.importance) || 2) }
    }
    for (const c of arr(r.concepts)) {
      const e = concepts.add([c.name], name => ({ name, category: str(c.category) || '其他', descs: [], related: [], chunks: [], score: 0 }))
      if (!e) continue
      e.original ||= str(c.original)
      pushUniq(e.descs, str(c.desc), 5)
      for (const x of arr(c.related)) pushUniq(e.related, str(x), 8)
      if (!e.chunks.includes(ci)) { e.chunks.push(ci); e.score++ }
    }
    for (const p of arr(r.places)) {
      const e = places.add([p.name], name => ({ name, descs: [], chunks: [], score: 0 }))
      if (!e) continue
      e.original ||= str(p.original)
      pushUniq(e.descs, str(p.desc), 3)
      if (!e.chunks.includes(ci)) { e.chunks.push(ci); e.score++ }
    }
    for (const x of arr(r.relations)) {
      const a = str(x.from), b = str(x.to), type = str(x.type)
      if (!a || !b || keyOf(a) === keyOf(b)) continue
      const k = [keyOf(a), keyOf(b)].sort().join('|') + '|' + keyOf(type)
      const old = rels.get(k)
      if (old) { old.count++; if (!old.desc) old.desc = str(x.desc) } else rels.set(k, { from: a, to: b, type, desc: str(x.desc), count: 1 })
    }
    for (const ev of arr(r.events)) {
      if (str(ev.title)) events.push({ title: str(ev.title), chapter: str(ev.chapter), desc: str(ev.desc), people: arr(ev.people).map(str).filter(Boolean), chunk: ci })
    }
  })
  // 关系两端换成合并后的人物名
  const relations = []
  const seen = new Set()
  for (const r of [...rels.values()].sort((a, b) => b.count - a.count)) {
    const a = people.find([r.from]), b = people.find([r.to])
    if (!a || !b || a === b) continue
    const k = [a.name, b.name].sort().join('|') + '|' + keyOf(r.type)
    if (seen.has(k)) continue
    seen.add(k)
    relations.push({ ...r, from: a.name, to: b.name })
  }
  const byScore = (a, b) => b.score - a.score
  return {
    characters: people.items.sort(byScore),
    concepts: concepts.items.sort(byScore),
    places: places.items.sort(byScore),
    relations,
    events,
  }
}

// 不经 AI 整合，直接用合并结果做导图（生成中的预览，或整合失败时兜底）
export function localMap(merged, chunkRanges = []) {
  const chars = merged.characters.slice(0, 50)
  const top = chars[0]?.score || 1
  const role = c => c.score >= top * 0.6 ? '主角' : c.score >= top * 0.25 ? '主要' : '次要'
  const cats = {}
  for (const c of merged.concepts.slice(0, 60)) (cats[c.category] ||= []).push({ name: c.name, original: c.original || '', desc: c.descs[0] || '', related: c.related.slice(0, 4) })
  const names = new Set(chars.map(c => c.name))
  return {
    summary: '', genre: '', themes: [], groups: [],
    characters: chars.map(c => ({
      name: c.name, aliases: c.aliases, group: '', role: role(c), desc: c.descs[0] || '', traits: c.traits.slice(0, 4),
      arc: c.descs.slice(1, 3).join('；'), chunks: c.chunks,
    })),
    relations: merged.relations.filter(r => names.has(r.from) && names.has(r.to)).slice(0, 80).map(({ from, to, type, desc }) => ({ from, to, type, desc })),
    conceptCategories: Object.entries(cats).map(([name, items]) => ({ name, items })),
    places: merged.places.slice(0, 12).map(p => ({ name: p.name, original: p.original || '', desc: p.descs[0] || '' })),
    timeline: thinEvents(merged.events, 30).map(e => ({ ...e, range: chunkRanges[e.chunk] || '' })),
  }
}

// 情节太多时均匀抽取
function thinEvents(events, max) {
  if (events.length <= max) return events
  const out = []
  for (let i = 0; i < max; i++) out.push(events[Math.floor(i * events.length / max)])
  return out
}

const cut = (s, n) => s.length > n ? s.slice(0, n) + '…' : s

function peoplePrompt(record, merged) {
  const chars = merged.characters.slice(0, 90).map(c =>
    `- ${c.name}${c.aliases.length ? `（又称：${c.aliases.join('、')}）` : ''}｜出现 ${c.chunks.length} 段｜${cut(c.descs.join('；'), 220)}${c.traits.length ? `｜特点：${c.traits.join('、')}` : ''}`).join('\n')
  const rels = merged.relations.slice(0, 160).map(r => `- ${r.from} — ${r.to}：${r.type}${r.desc ? `（${r.desc}）` : ''}`).join('\n')
  return `${bookLine(record)}
下面是 AI 分段阅读这本书后汇总的人物和人物关系初稿。同一个人物可能因为称呼不同被当成了几个人，描述也比较零散。请整合成最终版本：
- 合并同一人物（不同称呼、字号、昵称），name 用最通行的称呼，其他称呼放 aliases；
- 按阵营、家族、机构、流派或身份把人物分组（group），3~8 组，组名贴合本书（例如“贾府”“梁山好汉”“古希腊哲学家”），实在不好归类的放“其他”；
- role 只能是：主角 / 主要 / 次要；
- desc：综合全书写人物简介（≤80字）；traits：性格或特点（≤4个）；arc：这个人物在全书中的经历与结局，非虚构书则写其核心观点或贡献（≤80字）；
- 最多保留 50 个人物（按重要性）；relations 保留最重要的不超过 80 条，去掉重复和意思相同的，from、to 必须是保留下来的人物 name。

只输出：
{"groups":[{"name":"","desc":""}],"characters":[{"name":"","aliases":[],"group":"","role":"","desc":"","traits":[],"arc":""}],"relations":[{"from":"","to":"","type":"","desc":""}]}

人物初稿：
${chars || '（无）'}

关系初稿：
${rels || '（无）'}`
}

function themesPrompt(record, merged) {
  const concepts = merged.concepts.slice(0, 120).map(c => `- ${c.name}［${c.category}］${cut(c.descs.join('；'), 150)}${c.related.length ? `｜相关：${c.related.slice(0, 4).join('、')}` : ''}`).join('\n')
  const places = merged.places.slice(0, 30).map(p => `- ${p.name}：${cut(p.descs.join('；'), 60)}`).join('\n')
  const events = thinEvents(merged.events, 160).map(e => `- [${e.chapter || '?'}] ${e.title}：${cut(e.desc, 60)}${e.people.length ? `（${e.people.slice(0, 4).join('、')}）` : ''}`).join('\n')
  const who = merged.characters.slice(0, 30).map(c => c.name).join('、')
  return `${bookLine(record)}
下面是 AI 分段阅读这本书后汇总的概念、地点和按顺序排列的情节（论点）初稿。主要人物有：${who || '（无）'}。请整合：
- summary：全书概述（≤200字）；genre：书的类型（如 长篇小说、历史、哲学、心理学、科普……）；
- themes：全书主题 3~6 个（name ≤10字，desc ≤60字）；
- conceptCategories：把概念归成 3~7 类（类名自拟，贴合本书，例如“核心思想”“武功门派”“经济学术语”），每类不超过 12 项，合并重复概念；每项 name、desc（≤60字）、related（相关人物或概念，≤4个）；
- places：最重要的地点，不超过 12 个，name、desc（≤30字）；
- timeline：全书的情节脉络（非虚构书为论证结构），按先后顺序 8~25 个关键节点，每个 title（≤12字）、chapter、desc（≤60字）、people。

只输出：
{"summary":"","genre":"","themes":[{"name":"","desc":""}],"conceptCategories":[{"name":"","items":[{"name":"","desc":"","related":[]}]}],"places":[{"name":"","desc":""}],"timeline":[{"title":"","chapter":"","desc":"","people":[]}]}

概念初稿：
${concepts || '（无）'}

地点初稿：
${places || '（无）'}

情节初稿：
${events || '（无）'}`
}

// 把 AI 整合结果规整一下，补上每个人物出现在哪几段
function finalize(people, themes, merged, fallback) {
  const map = { ...fallback }
  if (people) {
    const chars = arr(people.characters).filter(c => str(c.name)).map(c => {
      const names = [c.name, ...arr(c.aliases)].map(str).filter(Boolean)
      const chunks = new Set()
      for (const m of merged.characters) if ([m.name, ...m.aliases].some(n => names.some(x => keyOf(x) === keyOf(n)))) m.chunks.forEach(i => chunks.add(i))
      return {
        name: str(c.name), aliases: arr(c.aliases).map(str).filter(a => a && a !== str(c.name)), group: str(c.group),
        role: ['主角', '主要', '次要'].includes(str(c.role)) ? str(c.role) : '次要',
        desc: str(c.desc), traits: arr(c.traits).map(str).filter(Boolean), arc: str(c.arc), chunks: [...chunks].sort((a, b) => a - b),
      }
    })
    if (chars.length) {
      const lookup = new Map()
      for (const c of chars) for (const n of [c.name, ...c.aliases]) if (!lookup.has(keyOf(n))) lookup.set(keyOf(n), c.name)
      map.characters = chars
      map.groups = arr(people.groups).map(g => ({ name: str(g.name), desc: str(g.desc) })).filter(g => g.name)
      const seen = new Set()
      map.relations = arr(people.relations).map(r => ({ from: lookup.get(keyOf(r.from)), to: lookup.get(keyOf(r.to)), type: str(r.type), desc: str(r.desc) }))
        .filter(r => {
          if (!r.from || !r.to || r.from === r.to) return false
          const k = [r.from, r.to].sort().join('|') + r.type
          if (seen.has(k)) return false
          seen.add(k)
          return true
        })
    }
  }
  // 概念、地点的原文写法（外文书在书中查找时要用）
  const orig = new Map()
  for (const x of [...merged.concepts, ...merged.places]) if (x.original) orig.set(keyOf(x.name), x.original)
  const withOrig = x => ({ ...x, original: str(x.original) || orig.get(keyOf(x.name)) || '' })
  if (themes) {
    map.summary = str(themes.summary)
    map.genre = str(themes.genre)
    map.themes = arr(themes.themes).map(t => ({ name: str(t.name), desc: str(t.desc) })).filter(t => t.name)
    const cats = arr(themes.conceptCategories).map(c => ({
      name: str(c.name), items: arr(c.items).map(i => withOrig({ name: str(i.name), desc: str(i.desc), related: arr(i.related).map(str).filter(Boolean) })).filter(i => i.name),
    })).filter(c => c.name && c.items.length)
    if (cats.length) map.conceptCategories = cats
    const places = arr(themes.places).map(p => withOrig({ name: str(p.name), desc: str(p.desc) })).filter(p => p.name)
    if (places.length) map.places = places
    const tl = arr(themes.timeline).map(e => ({ title: str(e.title), chapter: str(e.chapter), desc: str(e.desc), people: arr(e.people).map(str).filter(Boolean) })).filter(e => e.title)
    if (tl.length) map.timeline = tl
  }
  return map
}

// ---------- 任务管理 ----------
const jobs = new Map() // bookId -> { state, listeners:Set, ctrl }

const emit = job => { for (const fn of job.listeners) fn(job.state) }
const getOrMake = bookId => {
  if (!jobs.has(bookId)) jobs.set(bookId, { state: null, listeners: new Set(), ctrl: null })
  return jobs.get(bookId)
}

export function subscribe(bookId, fn) {
  const job = getOrMake(bookId)
  job.listeners.add(fn)
  if (job.state) fn(job.state)
  return () => job.listeners.delete(fn)
}
export const jobState = bookId => jobs.get(bookId)?.state || null
export const isRunning = bookId => !!jobs.get(bookId)?.ctrl

export function cancel(bookId) { jobs.get(bookId)?.ctrl?.abort() }

// opts: { detail: 'fast'|'normal'|'fine', fresh: 是否丢弃已有的分段结果, model: 显示用 }
export async function generate(record, { detail = 'normal', fresh = false, model = '' } = {}) {
  const job = getOrMake(record.id)
  if (job.ctrl) return
  const ctrl = new AbortController()
  job.ctrl = ctrl
  const set = patch => { job.state = { ...job.state, ...patch }; emit(job) }
  set({ phase: 'reading', done: 0, total: 0, error: null, message: '正在读取全书文字…' })

  let doc = fresh ? null : await window.api.getMindMap(record.id)
  try {
    const { parts, total } = await bookText(record)
    if (total < 200) throw new Error(record.format === 'pdf' ? '这本 PDF 取不到文字。扫描版请先打开阅读，等文字识别完成后再生成。' : '这本书里取不到文字。')
    const size = DETAIL[detail]?.chunk || DETAIL.normal.chunk
    const chunks = makeChunks(parts, size)
    if (!doc || doc.version !== VERSION || doc.detail !== detail || doc.chunkCount !== chunks.length) {
      doc = { version: VERSION, bookId: record.id, title: record.title, detail, chunkCount: chunks.length, chars: total, chunks: {}, map: null, status: 'partial', createdAt: Date.now() }
    }
    doc.ranges = chunks.map(c => c.range)
    doc.model = model
    const results = () => chunks.map((_, i) => doc.chunks[i] || null)
    const save = () => { doc.updatedAt = Date.now(); return window.api.setMindMap(record.id, doc) }
    const doneCount = () => Object.keys(doc.chunks).length
    set({ phase: 'extracting', done: doneCount(), total: chunks.length, message: '', doc })

    // 逐段抽取（并行），每完成一段就更新预览并保存
    const todo = chunks.map((_, i) => i).filter(i => !doc.chunks[i])
    let failures = 0, lastErr = null
    const worker = async () => {
      while (todo.length) {
        const i = todo.shift()
        let res = null
        for (let attempt = 0; attempt < 2 && !res; attempt++) {
          try { res = parseJSON(await callAI(SYSTEM, chunkPrompt(record, chunks[i], i, chunks.length), ctrl.signal)) }
          catch (e) { if (e instanceof Cancelled) throw e; lastErr = e }
        }
        if (!res) {
          failures++
          // 一开始就连续失败（多半是 AI 没配好或额度用完）：不再继续浪费时间
          if (!doneCount() && failures >= 2) throw lastErr
          continue
        }
        doc.chunks[i] = res
        doc.map = localMap(mergeChunks(results()), doc.ranges)
        await save()
        set({ done: doneCount(), doc: { ...doc } })
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker))
    if (!doneCount()) throw lastErr || new Error('AI 没有返回结果')

    // 整合
    set({ phase: 'merging', message: 'AI 正在整合人物关系、概念和情节脉络…' })
    const merged = mergeChunks(results())
    const fallback = localMap(merged, doc.ranges)
    const [people, themes] = await Promise.all([
      callAI(SYSTEM, peoplePrompt(record, merged), ctrl.signal).then(parseJSON).catch(e => { if (e instanceof Cancelled) throw e; console.warn('整合人物失败', e); return null }),
      callAI(SYSTEM, themesPrompt(record, merged), ctrl.signal).then(parseJSON).catch(e => { if (e instanceof Cancelled) throw e; console.warn('整合主题失败', e); return null }),
    ])
    doc.map = finalize(people, themes, merged, fallback)
    const missing = chunks.length - doneCount()
    doc.status = missing ? 'partial' : 'done'
    doc.integrated = !!(people || themes)
    await save()
    set({
      phase: 'done', doc: { ...doc },
      message: missing ? `有 ${missing} 段没能读取成功，可以点“继续生成”补上。` : !people || !themes ? 'AI 整合时出了点问题，部分内容为未整合的初稿。' : '',
    })
  } catch (e) {
    if (e instanceof Cancelled || ctrl.signal.aborted) set({ phase: 'cancelled', message: '已停止，已读的部分会保留，可以继续生成。', doc: doc && { ...doc } })
    else set({ phase: 'error', error: e?.message || String(e), doc: doc && { ...doc } })
  } finally {
    job.ctrl = null
    emit(job)
  }
}
