// 把整本书交给 AI 整理成思维导图：
// 1. 先让 AI 翻一翻这本书（目录 + 几段样本），提出适合的导图方向，读者勾选侧重点；
// 2. 取全书文字，按章节标记切成若干段，每段只提取所选方向需要的内容（并行，逐段保存，可中断后接着读）；
// 3. 阅读光标按设定速度扫过原文，扫到哪一项第一次出现的地方就画上导图（边读边画）；
// 4. 读完后本地按名字 / 别名合并，再让 AI 按所选方向整合一次，得到最终导图。
// 任务不跟界面绑定：关掉导图窗口也会在后台继续，再打开能看到进度。
import { openBookRecord } from '../lib/foliate.js'
import { ocrPageText } from '../reader/ocrLayer.js'
import { LENSES, DEFAULT_FOCUS, feedLabels } from './focus.js'

export const DETAIL = {
  fast: { label: '快速', chunk: 48000, hint: '分段少、AI 调用少，适合先看个大概' },
  normal: { label: '标准', chunk: 24000, hint: '兼顾速度和细节' },
  fine: { label: '精细', chunk: 12000, hint: '分段多，次要人物和概念也能抓到' },
}
const FIRST_CHUNK = 8000 // 第一段短一些，导图能早点出来
const CONCURRENCY = 3
const LOOKAHEAD = 2 // 边读边画时，AI 最多比阅读位置领先几段
const VERSION = 3

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
    // 有多级目录时记下每一节属于哪一章（“章节框架”按章分组）
    const top = {}
    for (const item of book.toc || []) {
      const label = item.label?.trim()
      if (!label || !item.subitems?.length) continue
      for (const it of [item, ...flatToc(item.subitems)]) {
        try {
          const idx = (await book.resolveHref?.(it.href))?.index
          if (idx != null && top[idx] == null) top[idx] = label
        } catch {}
      }
    }
    const parts = []
    let last = '', lastTop = ''
    for (let i = 0; i < (book.sections?.length || 0); i++) {
      const s = book.sections[i]
      if (!s?.createDocument) continue
      let doc
      try { doc = await s.createDocument() } catch { continue }
      const text = clean(doc?.body?.innerText ?? doc?.body?.textContent)
      if (!text) continue
      last = names[i] || last
      lastTop = top[i] || lastTop
      parts.push({ label: names[i] || last || '', group: lastTop, text })
    }
    return parts
  } finally {
    book.destroy?.()
  }
}

// 按字数切段：段内保留【章节】标记，方便 AI 标注章节
export function makeChunks(parts, size, first = size) {
  const chunks = []
  let cur = null
  const push = () => { if (cur?.text.trim()) chunks.push(cur); cur = null }
  for (const p of parts) {
    let text = p.text
    let marked = false
    while (text) {
      if (!cur) cur = { text: '', from: p.label, to: p.label }
      if (!marked && p.label) { cur.text += `\n【${p.label}】\n`; marked = true }
      const room = (chunks.length ? size : first) - cur.text.length
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
  let start = 0
  return chunks.map(c => {
    const text = c.text.trim()
    const out = { text, start, range: c.from === c.to ? c.from : `${c.from || '开头'} — ${c.to || '结尾'}` }
    start += text.length
    return out
  })
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

const SYSTEM = '你是一位细致的读书笔记整理者，负责从书籍文字中提取结构化信息，用来生成思维导图。只输出一个 JSON 对象，不要输出任何解释、前言或 Markdown 代码块标记。所有文字用简体中文（专有名词可保留原文；要求原样摘录原文的除外）。'

const bookLine = record => `书名：《${record.title}》${record.author ? `　作者：${record.author}` : ''}`

const keyOf = s => String(s || '').toLowerCase().replace(/[\s·・.\-_—'"“”‘’《》()（）,，。:：!！?？]/g, '')
const arr = x => Array.isArray(x) ? x : []
const str = x => typeof x === 'string' ? x.trim() : x == null ? '' : String(x).trim()
const pushUniq = (list, v, max) => { if (v && !list.includes(v) && list.length < max) list.push(v) }
const cut = (s, n) => s.length > n ? s.slice(0, n) + '…' : s

// ---------- 第一步：分析这本书，提出导图方向 ----------
export async function analyzeBook(record, signal) {
  const { parts, total } = await bookText(record)
  if (total < 200) throw new Error('这本书里取不到文字')
  const all = parts.map(p => (p.label ? `【${p.label}】\n` : '') + p.text).join('\n')
  const sample = (at, len) => {
    let s = Math.floor(all.length * at)
    const nl = all.indexOf('\n', s)
    if (nl > 0 && nl - s < 300) s = nl + 1
    return all.slice(s, s + len)
  }
  const labels = [...new Set(parts.map(p => p.label).filter(l => l && !/^第 \d+ 页$/.test(l)))]
  const toc = labels.length > 70 ? [...labels.slice(0, 45), '……', ...labels.slice(-20)] : labels
  const prompt = `${bookLine(record)}
全书约 ${Math.round(total / 1000)} 千字。下面是这本书的目录和几段原文样本。读者想把这本书整理成思维导图，请先判断这是一本什么样的书，再提出 4~7 个适合这本书的思维导图方向，让读者挑选。

可用的方向类型（kind）：
- characters：人物关系（人物多、关系复杂的小说、传记、历史）
- concepts：核心概念（概念、术语多的理论、学术、科普书）
- plot：情节脉络（有故事线的书）
- outline：章节框架（结构清晰的非虚构书，逐章梳理要点和论证）
- themes：主题思想
- methods：方法与行动（实用、自我提升、商业类）
- quotes：金句摘录
- places：地点场景（地点、世界观重要的书）
- custom：以上都不贴切时，针对本书特点自拟方向，必须给出 instruction（告诉 AI 读书时具体提取什么，≤60字）

要求：
- 只提出真正适合这本书的方向，按适合程度排序；把最适合的 2~3 个标为 recommended: true；
- title 要结合本书内容写（≤14字，例如“贾府人物关系网”“五行生克体系”“逐章论证脉络”“修心的方法”）；
- desc 说明这个方向能帮读者得到什么（≤45字）；
- custom 最多 2 个；除 custom 外同一 kind 只出现一次；
- summary 用一句话介绍这本书（≤60字）；genre 是书的类型（如 长篇小说、历史、哲学、心理学、人生随笔、命理……）。

只输出：
{"genre":"","summary":"","directions":[{"kind":"","title":"","desc":"","recommended":true,"instruction":""}]}

目录：
${toc.length ? toc.join('\n') : '（没有目录）'}

原文样本（开头）：
${sample(0.02, 3200)}

原文样本（中段）：
${sample(0.4, 1800)}

原文样本（后段）：
${sample(0.75, 1800)}`
  const res = parseJSON(await callAI(SYSTEM, prompt, signal))
  const seen = new Set()
  let n = 0
  const directions = arr(res.directions).map(d => {
    const kind = str(d.kind)
    if (kind !== 'custom' && (!LENSES[kind] || seen.has(kind))) return null
    if (kind === 'custom' && (n >= 2 || !str(d.instruction || d.desc))) return null
    seen.add(kind)
    const id = kind === 'custom' ? 'c' + ++n : kind
    return {
      id, kind, title: cut(str(d.title) || LENSES[kind]?.label || '自定义', 16), desc: str(d.desc) || LENSES[kind]?.hint || '',
      recommended: !!d.recommended, ...(kind === 'custom' ? { instruction: str(d.instruction) || str(d.desc) } : {}),
    }
  }).filter(Boolean).slice(0, 7)
  if (directions.length < 2) throw new Error('AI 没有给出可用的方向')
  if (!directions.some(d => d.recommended)) directions.slice(0, 2).forEach(d => { d.recommended = true })
  return { genre: str(res.genre), summary: str(res.summary), directions, at: Date.now() }
}

// ---------- 第二步：逐段提取（只提取所选方向需要的） ----------
const SECTION = {
  characters: [
    ['characters', '人物（小说里的角色；非虚构书中被讨论或引用的人物）。name 用最常用的称呼；aliases 列出原文中的其他称呼（字、号、昵称、头衔、外号）；importance 1~5 表示在这段中的重要程度；desc 一句话说明这个人是谁、在这段里做了什么（≤50字）；traits 性格或特点关键词（≤3个）。如果原文不是中文，name 用中文通行译名，aliases 里必须包含原文写法。最多 25 个，只出现一次、没有作用的路人不要。'],
    ['relations', '人物之间的关系。from、to 用 characters 里的 name；type 为简短的关系词（如 父子、夫妻、师徒、主仆、恋人、对手、盟友、上下级、思想继承）；desc ≤25字。最多 30 条。'],
  ],
  concepts: [['concepts', '重要的概念、术语、思想、理论、组织/势力、门派、器物或制度。name；category 从 [核心思想, 术语, 组织势力, 器物, 制度规则, 其他] 中选；desc ≤50字；related 相关的人物或概念名（≤4个）；original 原文写法（原文不是中文时填写，否则留空）。最多 20 个。']],
  places: [['places', '重要地点。name；desc ≤30字；original 原文写法（原文不是中文时填写）。最多 10 个。']],
  plot: [['events', '这段的关键情节（非虚构书则是关键论点或论证步骤），按出现顺序。title ≤12字；chapter 填所在的章节名；desc ≤50字；people 参与人物。最多 8 个。']],
  outline: [['outline', '这段涉及的每一章的要点。chapter 填章节名（原文用【】标出，没有就概括一个小标题）；points 这一章在本段中的核心要点（2~5 条，每条 ≤40字）。']],
  themes: [['themes', '这段体现出的主题、观点或作者立场（≤3个）。name ≤10字；desc ≤40字。']],
  methods: [['methods', '书中给出的可以照着做的方法、建议或步骤（≤6个）。name ≤12字；desc ≤50字；steps 具体步骤（≤4条，每条 ≤30字，没有就给空数组）。']],
  quotes: [['quotes', '值得摘抄的原文句子（≤4条）。text 原样抄录原文（不要改写、不要翻译，≤90字）；note 为什么值得记（≤30字，用中文）。']],
}

function sectionsFor(focus) {
  const out = []
  for (const f of focus) {
    if (f.kind === 'custom') out.push(['x_' + f.id, `读者关注「${f.title}」：${f.instruction || f.desc}。提取这段里相关的内容（≤8项），每项 name ≤14字、desc ≤50字。`])
    else for (const s of SECTION[f.kind] || []) out.push(s)
  }
  // 情节需要人物名，没选人物时也没关系；去重
  return out.filter((s, i) => out.findIndex(x => x[0] === s[0]) === i)
}

function chunkPrompt(record, chunk, i, n, focus) {
  const secs = sectionsFor(focus)
  return `${bookLine(record)}
这是全书第 ${i + 1}/${n} 段${chunk.range ? `（${chunk.range}）` : ''}。原文里用【】标出了章节名。读者想按下面这些方面整理这本书，请从这段原文中提取：

${secs.map(([k, d], j) => `${j + 1}. ${k}：${d}`).join('\n')}

没有的类别给空数组。只输出：
{${secs.map(([k]) => `"${k}":[]`).join(',')}}

<book_excerpt>
${chunk.text}
</book_excerpt>`
}

// ---------- 本地合并 ----------
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
  const people = new Index(), concepts = new Index(), places = new Index(), themes = new Index(), methods = new Index()
  const custom = {}
  const outline = new Map()
  const quotes = [], quoteKeys = new Set()
  const rels = new Map()
  const events = []
  const simple = (index, x, ci, extra) => {
    const e = index.add([x.name], name => ({ name, descs: [], chunks: [], score: 0, ...extra }))
    if (!e) return null
    pushUniq(e.descs, str(x.desc), 5)
    if (!e.chunks.includes(ci)) { e.chunks.push(ci); e.score++ }
    return e
  }
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
      const e = simple(concepts, c, ci, { category: str(c.category) || '其他', related: [] })
      if (!e) continue
      e.original ||= str(c.original)
      for (const x of arr(c.related)) pushUniq(e.related, str(x), 8)
    }
    for (const p of arr(r.places)) { const e = simple(places, p, ci); if (e) e.original ||= str(p.original) }
    for (const t of arr(r.themes)) simple(themes, t, ci)
    for (const m of arr(r.methods)) {
      const e = simple(methods, m, ci, { steps: [] })
      if (e) for (const s of arr(m.steps)) pushUniq(e.steps, str(s), 6)
    }
    for (const [k, list] of Object.entries(r)) {
      if (!k.startsWith('x_')) continue
      custom[k] ||= new Index()
      for (const x of arr(list)) simple(custom[k], x, ci)
    }
    for (const o of arr(r.outline)) {
      const ch = str(o.chapter) || `第 ${ci + 1} 段`
      const k = keyOf(ch)
      if (!outline.has(k)) outline.set(k, { chapter: ch, points: [], chunk: ci })
      const e = outline.get(k)
      for (const p of arr(o.points)) pushUniq(e.points, str(p), 8)
    }
    for (const q of arr(r.quotes)) {
      const text = str(q.text)
      const k = keyOf(text).slice(0, 24)
      if (!text || quoteKeys.has(k)) continue
      quoteKeys.add(k)
      quotes.push({ text, note: str(q.note), chunk: ci })
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
    themes: themes.items.sort(byScore),
    methods: methods.items.sort(byScore),
    custom: Object.fromEntries(Object.entries(custom).map(([k, ix]) => [k, ix.items.sort(byScore)])),
    outline: [...outline.values()],
    quotes,
    relations,
    events,
  }
}

// 情节太多时均匀抽取
function thinEvents(events, max) {
  if (events.length <= max) return events
  const out = []
  for (let i = 0; i < max; i++) out.push(events[Math.floor(i * events.length / max)])
  return out
}

// 不经 AI 整合，直接用合并结果做导图（边读边画时的预览，或整合失败时兜底）
export function localMap(merged, chunkRanges = [], focus = DEFAULT_FOCUS) {
  const chars = merged.characters.slice(0, 50)
  const top = chars[0]?.score || 1
  const role = c => c.score >= top * 0.6 ? '主角' : c.score >= top * 0.25 ? '主要' : '次要'
  const cats = {}
  for (const c of merged.concepts.slice(0, 60)) (cats[c.category] ||= []).push({ name: c.name, original: c.original || '', desc: c.descs[0] || '', related: c.related.slice(0, 4) })
  const names = new Set(chars.map(c => c.name))
  return {
    focus,
    summary: '', genre: '', groups: [],
    themes: merged.themes.slice(0, 6).map(t => ({ name: t.name, desc: t.descs[0] || '' })),
    characters: chars.map(c => ({
      name: c.name, aliases: c.aliases, group: '', role: role(c), desc: c.descs[0] || '', traits: c.traits.slice(0, 4),
      arc: c.descs.slice(1, 3).join('；'), chunks: c.chunks,
    })),
    relations: merged.relations.filter(r => names.has(r.from) && names.has(r.to)).slice(0, 80).map(({ from, to, type, desc }) => ({ from, to, type, desc })),
    conceptCategories: Object.entries(cats).map(([name, items]) => ({ name, items })),
    places: merged.places.slice(0, 12).map(p => ({ name: p.name, original: p.original || '', desc: p.descs[0] || '' })),
    timeline: thinEvents(merged.events, 30).map(e => ({ ...e, range: chunkRanges[e.chunk] || '' })),
    outline: merged.outline.map(o => ({ chapter: o.chapter, points: o.points.slice(0, 6), range: chunkRanges[o.chunk] || '' })),
    methods: merged.methods.slice(0, 15).map(m => ({ name: m.name, desc: m.descs[0] || '', steps: m.steps.slice(0, 5) })),
    quotes: thinEvents(merged.quotes, 30).map(q => ({ text: q.text, note: q.note, range: chunkRanges[q.chunk] || '' })),
    custom: Object.fromEntries(focus.filter(f => f.kind === 'custom').map(f => [f.id, [{ name: '', items: (merged.custom['x_' + f.id] || []).slice(0, 20).map(x => ({ name: x.name, desc: x.descs[0] || '' })) }]])),
  }
}

// ---------- 第三步：读完后让 AI 整合 ----------
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

// 主题、概念、地点、情节：总是顺带要一个全书概述
function themesPrompt(record, merged, focus) {
  const has = k => focus.some(f => f.kind === k)
  const asks = ['- summary：全书概述（≤200字）；genre：书的类型（如 长篇小说、历史、哲学、心理学、科普……）；']
  const shape = ['"summary":""', '"genre":""']
  const inputs = []
  const who = merged.characters.slice(0, 30).map(c => c.name).join('、')
  if (has('themes')) {
    asks.push('- themes：全书主题 3~6 个（name ≤10字，desc ≤60字）；')
    shape.push('"themes":[{"name":"","desc":""}]')
    inputs.push(`主题初稿：\n${merged.themes.slice(0, 40).map(t => `- ${t.name}：${cut(t.descs.join('；'), 100)}`).join('\n') || '（无，请根据其他内容归纳）'}`)
  }
  if (has('concepts')) {
    asks.push('- conceptCategories：把概念归成 3~7 类（类名自拟，贴合本书，例如“核心思想”“武功门派”“经济学术语”），每类不超过 12 项，合并重复概念；每项 name、desc（≤60字）、related（相关人物或概念，≤4个）；')
    shape.push('"conceptCategories":[{"name":"","items":[{"name":"","desc":"","related":[]}]}]')
    inputs.push(`概念初稿：\n${merged.concepts.slice(0, 120).map(c => `- ${c.name}［${c.category}］${cut(c.descs.join('；'), 150)}${c.related.length ? `｜相关：${c.related.slice(0, 4).join('、')}` : ''}`).join('\n') || '（无）'}`)
  }
  if (has('places')) {
    asks.push('- places：最重要的地点，不超过 12 个，name、desc（≤30字）；')
    shape.push('"places":[{"name":"","desc":""}]')
    inputs.push(`地点初稿：\n${merged.places.slice(0, 30).map(p => `- ${p.name}：${cut(p.descs.join('；'), 60)}`).join('\n') || '（无）'}`)
  }
  if (has('plot')) {
    asks.push('- timeline：全书的情节脉络（非虚构书为论证结构），按先后顺序 8~25 个关键节点，每个 title（≤12字）、chapter、desc（≤60字）、people；')
    shape.push('"timeline":[{"title":"","chapter":"","desc":"","people":[]}]')
    inputs.push(`情节初稿：\n${thinEvents(merged.events, 160).map(e => `- [${e.chapter || '?'}] ${e.title}：${cut(e.desc, 60)}${e.people.length ? `（${e.people.slice(0, 4).join('、')}）` : ''}`).join('\n') || '（无）'}`)
  }
  if (!inputs.length) {
    // 只选了别的方向：给一点材料写概述
    const bits = [...merged.outline.slice(0, 40).map(o => `- ${o.chapter}：${cut(o.points.join('；'), 80)}`), ...merged.methods.slice(0, 20).map(m => `- ${m.name}：${cut(m.descs[0] || '', 50)}`)]
    inputs.push(`阅读笔记：\n${bits.join('\n') || '（无）'}`)
  }
  return `${bookLine(record)}
下面是 AI 分段阅读这本书后汇总的初稿${who ? `，主要人物有：${who}` : ''}。请整合：
${asks.join('\n')}

只输出：
{${shape.join(',')}}

${inputs.join('\n\n')}`
}

// 方法、金句、读者自定义的方向
function extrasPrompt(record, merged, focus) {
  const has = k => focus.some(f => f.kind === k)
  const asks = [], shape = [], inputs = []
  if (has('methods')) {
    asks.push('- methods：书里可以照着做的方法，合并重复的，按重要性保留不超过 12 个；每个 name（≤12字）、desc（≤60字）、steps（具体步骤，≤5条，每条 ≤30字）；')
    shape.push('"methods":[{"name":"","desc":"","steps":[]}]')
    inputs.push(`方法初稿：\n${merged.methods.slice(0, 60).map(m => `- ${m.name}：${cut(m.descs.join('；'), 100)}${m.steps.length ? `｜步骤：${m.steps.join(' / ')}` : ''}`).join('\n') || '（无）'}`)
  }
  if (has('quotes')) {
    asks.push('- quotes：从候选里挑出最值得摘抄的不超过 15 句，text 必须原样保留候选里的原文（不改写、不翻译），note ≤30字；')
    shape.push('"quotes":[{"text":"","note":""}]')
    inputs.push(`金句候选：\n${thinEvents(merged.quotes, 70).map(q => `- ${q.text}${q.note ? `（${q.note}）` : ''}`).join('\n') || '（无）'}`)
  }
  const customs = focus.filter(f => f.kind === 'custom')
  if (customs.length) {
    asks.push(`- custom：读者自己关心的方向，按 id 分别整理：把内容合并去重，再归成 2~6 个小类，每类不超过 8 项，每项 name（≤14字）、desc（≤60字）；`)
    shape.push(`"custom":{${customs.map(f => `"${f.id}":[{"name":"","items":[{"name":"","desc":""}]}]`).join(',')}}`)
    for (const f of customs) inputs.push(`读者关注「${f.title}」（id: ${f.id}，${f.instruction || f.desc}）初稿：\n${(merged.custom['x_' + f.id] || []).slice(0, 80).map(x => `- ${x.name}：${cut(x.descs.join('；'), 90)}`).join('\n') || '（无）'}`)
  }
  return `${bookLine(record)}
下面是 AI 分段阅读这本书后汇总的初稿。请整合：
${asks.join('\n')}

只输出：
{${shape.join(',')}}

${inputs.join('\n\n')}`
}

// 把 AI 整合结果规整一下，补上每个人物出现在哪几段
function finalize({ people, themes, extras }, merged, fallback) {
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
    const th = arr(themes.themes).map(t => ({ name: str(t.name), desc: str(t.desc) })).filter(t => t.name)
    if (th.length) map.themes = th
    const cats = arr(themes.conceptCategories).map(c => ({
      name: str(c.name), items: arr(c.items).map(i => withOrig({ name: str(i.name), desc: str(i.desc), related: arr(i.related).map(str).filter(Boolean) })).filter(i => i.name),
    })).filter(c => c.name && c.items.length)
    if (cats.length) map.conceptCategories = cats
    const places = arr(themes.places).map(p => withOrig({ name: str(p.name), desc: str(p.desc) })).filter(p => p.name)
    if (places.length) map.places = places
    const tl = arr(themes.timeline).map(e => ({ title: str(e.title), chapter: str(e.chapter), desc: str(e.desc), people: arr(e.people).map(str).filter(Boolean) })).filter(e => e.title)
    if (tl.length) map.timeline = tl
  }
  if (extras) {
    const ms = arr(extras.methods).map(m => ({ name: str(m.name), desc: str(m.desc), steps: arr(m.steps).map(str).filter(Boolean) })).filter(m => m.name)
    if (ms.length) map.methods = ms
    const qs = arr(extras.quotes).map(q => ({ text: str(q.text), note: str(q.note) })).filter(q => q.text)
    if (qs.length) {
      // 补上出处
      const src = new Map(map.quotes.map(q => [keyOf(q.text).slice(0, 16), q.range]))
      map.quotes = qs.map(q => ({ ...q, range: src.get(keyOf(q.text).slice(0, 16)) || '' }))
    }
    const cu = extras.custom && typeof extras.custom === 'object' ? extras.custom : {}
    for (const id of Object.keys(map.custom || {})) {
      const groups = arr(cu[id]).map(g => ({ name: str(g.name), items: arr(g.items).map(i => ({ name: str(i.name), desc: str(i.desc) })).filter(i => i.name) })).filter(g => g.items.length)
      if (groups.length) map.custom = { ...map.custom, [id]: groups }
    }
  }
  return map
}

// ---------- 边读边画：每一项在原文里第一次出现的位置 ----------
// AI 一次读完一段；界面上的“阅读光标”按设定的速度扫过原文，扫到哪一项第一次出现的地方，就把它画上导图
function markPositions(res, text) {
  const low = text.toLowerCase()
  const find = names => {
    let best = -1
    for (const n of names) {
      const t = str(n).toLowerCase()
      if (!t) continue
      const i = low.indexOf(t)
      if (i >= 0 && (best < 0 || i < best)) best = i
    }
    return best
  }
  const spread = (k, n) => Math.round(text.length * (k + 1) / (n + 1))
  const place = (list, names) => {
    list = arr(list)
    list.forEach((x, k) => {
      if (!x || typeof x !== 'object') return
      const at = names ? find(names(x)) : -1
      x._at = at >= 0 ? at : spread(k, list.length)
    })
  }
  place(res.characters, c => [c.name, ...arr(c.aliases)])
  place(res.concepts, c => [c.name, c.original])
  place(res.places, p => [p.name, p.original])
  place(res.events)
  place(res.outline, o => [o.chapter])
  place(res.themes, t => [t.name])
  place(res.methods, m => [m.name])
  place(res.quotes, q => [str(q.text).slice(0, 14)])
  for (const k of Object.keys(res)) if (k.startsWith('x_')) place(res[k], x => [x.name])
  // 关系：两个人都出场之后
  const at = new Map()
  for (const c of arr(res.characters)) for (const n of [c?.name, ...arr(c?.aliases)]) if (c && !at.has(keyOf(n))) at.set(keyOf(n), c._at)
  arr(res.relations).forEach((r, k, list) => {
    if (!r || typeof r !== 'object') return
    const a = at.get(keyOf(r.from)), b = at.get(keyOf(r.to))
    r._at = a != null && b != null ? Math.max(a, b) + 1 : spread(k, list.length)
  })
  return res
}

const listKeys = r => Object.keys(r).filter(k => Array.isArray(r[k]))
function visibleResults(chunks, results, cursor) {
  return results.map((r, i) => {
    if (!r) return null
    const c = chunks[i]
    if (cursor >= c.start + c.text.length) return r
    if (cursor <= c.start) return null
    const at = cursor - c.start
    const out = {}
    for (const k of listKeys(r)) out[k] = r[k].filter(x => (x?._at ?? 0) <= at)
    return out
  })
}
// 光标从 a 移到 b 之间新“读到”的条目，给“刚刚记下”列表用
function newlyRead(chunks, results, a, b, labels) {
  const out = []
  results.forEach((r, i) => {
    if (!r) return
    const c = chunks[i]
    if (c.start > b || c.start + c.text.length < a) return
    for (const k of listKeys(r)) {
      const kind = labels[k]
      if (!kind) continue
      for (const x of r[k]) {
        const p = c.start + (x?._at ?? 0)
        if (p <= a || p > b) continue
        const name = k === 'relations' ? `${str(x.from)} — ${str(x.to)}` : k === 'outline' ? str(x.chapter) : k === 'quotes' ? `“${cut(str(x.text), 24)}”` : str(x.name || x.title)
        const desc = k === 'relations' ? str(x.type) : k === 'outline' ? str(arr(x.points)[0]) : k === 'quotes' ? str(x.note) : str(x.desc)
        out.push({ p, kind, k, name, desc })
      }
    }
  })
  return out.sort((x, y) => x.p - y.p)
}

// ---------- 阅读速度（字 / 分钟），全局记住 ----------
export const SPEEDS = [
  { v: 2000, label: '2千' }, { v: 5000, label: '5千' }, { v: 10000, label: '1万' }, { v: 30000, label: '3万' }, { v: Infinity, label: '不限' },
]
let speedPref = 10000
try { const v = localStorage.getItem('mm-speed'); if (v) speedPref = v === 'max' ? Infinity : +v || speedPref } catch {}
export const getSpeed = () => speedPref

// ---------- 任务管理 ----------
const jobs = new Map() // bookId -> { state, listeners:Set, ctrl, paused, skip }

const emit = job => { for (const fn of job.listeners) fn(job.state) }
const getOrMake = bookId => {
  if (!jobs.has(bookId)) jobs.set(bookId, { state: null, listeners: new Set(), ctrl: null, paused: false, skip: false })
  return jobs.get(bookId)
}

export function setSpeed(v) {
  speedPref = v
  try { localStorage.setItem('mm-speed', v === Infinity ? 'max' : String(v)) } catch {}
  for (const job of jobs.values()) if (job.state) { job.state = { ...job.state, speed: v }; emit(job) }
}

export function subscribe(bookId, fn) {
  const job = getOrMake(bookId)
  job.listeners.add(fn)
  if (job.state) fn(job.state)
  return () => job.listeners.delete(fn)
}
export const jobState = bookId => jobs.get(bookId)?.state || null
export const isActive = st => !!st && ['reading', 'extracting', 'merging', 'playing'].includes(st.phase)

export function cancel(bookId) { jobs.get(bookId)?.ctrl?.abort() }
export function setPaused(bookId, paused) {
  const job = jobs.get(bookId)
  if (!job?.state) return
  job.paused = paused
  job.state = { ...job.state, paused }
  emit(job)
}
// 不看过程了：光标直接跳到 AI 已读到的位置，之后也不再等
export function skipAhead(bookId) {
  const job = jobs.get(bookId)
  if (!job?.state) return
  job.skip = true
  job.paused = false
  job.state = { ...job.state, skip: true, paused: false }
  emit(job)
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
const emptyMap = focus => ({ focus, summary: '', genre: '', themes: [], groups: [], characters: [], relations: [], conceptCategories: [], places: [], timeline: [], outline: [], methods: [], quotes: [], custom: {} })
const focusSig = focus => JSON.stringify(focus.map(f => [f.id, f.kind, f.instruction || '']))

// opts: { detail, fresh: 丢弃已有的分段结果, model: 显示用, focus: 读者选的侧重点（不给就沿用上次的） }
export async function generate(record, { detail = 'normal', fresh = false, model = '', focus = null } = {}) {
  const job = getOrMake(record.id)
  if (job.ctrl) return
  const ctrl = new AbortController()
  job.ctrl = ctrl
  job.paused = false
  job.skip = false
  const set = patch => { job.state = { ...job.state, ...patch }; emit(job) }
  set({
    phase: 'reading', done: 0, total: 0, error: null, message: '正在读取全书文字…', liveMap: null, feed: [], cursor: 0, frontier: 0,
    totalLen: 0, chunks: null, paused: false, skip: false, waiting: false, speed: speedPref, bookId: record.id,
  })

  const old = await window.api.getMindMap(record.id)
  let doc = fresh ? null : old
  focus = focus?.length ? focus : doc?.focus?.length ? doc.focus : DEFAULT_FOCUS
  let timer = null
  let cursor = 0
  try {
    const { parts, total } = await bookText(record)
    if (total < 200) throw new Error(record.format === 'pdf' ? '这本 PDF 取不到文字。扫描版请先打开阅读，等文字识别完成后再生成。' : '这本书里取不到文字。')
    const size = DETAIL[detail]?.chunk || DETAIL.normal.chunk
    const chunks = makeChunks(parts, size, Math.min(size, FIRST_CHUNK))
    const totalLen = chunks.reduce((n, c) => n + c.text.length, 0)
    if (!doc || doc.version !== VERSION || doc.detail !== detail || doc.chunkCount !== chunks.length || doc.focusSig !== focusSig(focus)) {
      doc = {
        version: VERSION, bookId: record.id, title: record.title, detail, chunkCount: chunks.length, chars: total, chunks: {}, map: null,
        status: 'partial', cursor: 0, createdAt: Date.now(), analysis: old?.analysis, focus, focusSig: focusSig(focus),
      }
    }
    doc.ranges = chunks.map(c => c.range)
    doc.model = model
    const labels = feedLabels(focus)
    // “章节框架”里每一节属于哪一章
    const groupOf = new Map(parts.filter(p => p.group).map(p => [keyOf(p.label), p.group]))
    for (const p of parts) if (p.group) groupOf.set(keyOf(p.group), p.group) // 章本身的标题页
    const withGroups = map => {
      if (!groupOf.size || !map.outline?.length) return map
      let prev = ''
      map.outline = map.outline.map(o => {
        const g = groupOf.get(keyOf(o.chapter)) || prev // 名字和目录对不上：跟着上一节
        if (g) prev = g
        return { ...o, group: g }
      })
      return map
    }
    const results = () => chunks.map((_, i) => doc.chunks[i] || null)
    const save = () => { doc.updatedAt = Date.now(); return window.api.setMindMap(record.id, { ...doc }) }
    const doneCount = () => Object.keys(doc.chunks).length
    for (const [i, r] of Object.entries(doc.chunks)) if (chunks[i]) markPositions(r, chunks[i].text)

    // AI 已经连续读完的位置：光标不能超过它
    const frontier = () => {
      for (let i = 0; i < chunks.length; i++) if (!doc.chunks[i]) return chunks[i].start
      return totalLen
    }
    const chunkAt = p => { let i = 0; while (i < chunks.length - 1 && chunks[i + 1].start <= p) i++; return i }
    // 上次读到哪里就接着往下读（已经读过的部分直接画出来）
    cursor = Math.min(doc.status === 'done' ? 0 : doc.cursor || 0, frontier())
    let revealed = -1
    let feed = []
    const reveal = (from, to) => {
      const vis = visibleResults(chunks, results(), to)
      const count = vis.reduce((n, r) => n + (r ? listKeys(r).reduce((m, k) => m + r[k].length, 0) : 0), 0)
      if (to > from) feed = [...feed, ...newlyRead(chunks, results(), from, to, labels)].slice(-40)
      if (count === revealed) return null
      revealed = count
      return withGroups(localMap(mergeChunks(vis), doc.ranges, focus))
    }
    const watching = () => job.listeners.size > 0
    const unlimited = () => !watching() || job.skip || speedPref === Infinity

    set({ phase: 'extracting', done: doneCount(), total: chunks.length, message: '', chunks, totalLen, cursor, frontier: frontier(), liveMap: reveal(0, cursor) || emptyMap(focus), feed, focus })

    // 阅读光标：每 100ms 按设定速度前进，不超过 AI 已读完的位置
    let last = performance.now()
    let lastSave = 0
    timer = setInterval(() => {
      const now = performance.now()
      const dt = Math.min(1, (now - last) / 1000)
      last = now
      const fr = frontier()
      const prev = cursor
      if (unlimited()) cursor = fr
      else if (!job.paused) cursor = Math.min(fr, cursor + speedPref / 60 * dt)
      const patch = {}
      if (cursor !== prev) {
        const map = reveal(prev, cursor)
        if (map) patch.liveMap = map
        patch.feed = feed
        patch.cursor = cursor
        if (now - lastSave > 5000) { lastSave = now; doc.cursor = cursor; save() }
      }
      const waiting = cursor >= fr && fr < totalLen
      if (fr !== job.state.frontier) patch.frontier = fr
      if (waiting !== job.state.waiting) patch.waiting = waiting
      if (Object.keys(patch).length) set(patch)
    }, 100)

    // 逐段抽取（并行）；边看边读时 AI 不超前太多，免得白读
    const todo = chunks.map((_, i) => i).filter(i => !doc.chunks[i])
    let failures = 0, lastErr = null
    let firstAlone = !doc.chunks[0] // 第一段单独先读（不和后面的大段抢），导图尽快出来
    const worker = async () => {
      while (todo.length) {
        if (ctrl.signal.aborted) throw new Cancelled()
        if (firstAlone && todo[0] !== 0) { await sleep(300); continue }
        if (!unlimited() && todo[0] > chunkAt(cursor) + LOOKAHEAD) { await sleep(300); continue }
        const i = todo.shift()
        let res = null
        for (let attempt = 0; attempt < 2 && !res; attempt++) {
          try { res = parseJSON(await callAI(SYSTEM, chunkPrompt(record, chunks[i], i, chunks.length, focus), ctrl.signal)) }
          catch (e) { if (e instanceof Cancelled) throw e; lastErr = e }
        }
        if (i === 0) firstAlone = false
        if (!res) {
          failures++
          if (!doneCount() && failures >= 2) throw lastErr // 一开始就连续失败：多半是 AI 没配好或额度用完
          // 读不出来的段先当作空段，光标可以继续往后走；下次“继续生成”时重读
          res = { failed: true }
        }
        doc.chunks[i] = markPositions(res, chunks[i].text)
        doc.map = withGroups(localMap(mergeChunks(results()), doc.ranges, focus))
        doc.cursor = cursor
        await save()
        set({ done: doneCount() })
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker))

    // 整合（光标继续往后读）
    set({ phase: 'merging', message: 'AI 正在整合…' })
    if (!results().some(r => r && !r.failed)) throw lastErr || new Error('AI 没有返回结果')
    const merged = mergeChunks(results())
    const fallback = localMap(merged, doc.ranges, focus)
    const has = k => focus.some(f => f.kind === k)
    const soft = p => p.then(parseJSON).catch(e => { if (e instanceof Cancelled) throw e; console.warn('整合失败', e); return null })
    const [people, themes, extras] = await Promise.all([
      has('characters') ? soft(callAI(SYSTEM, peoplePrompt(record, merged), ctrl.signal)) : null,
      soft(callAI(SYSTEM, themesPrompt(record, merged, focus), ctrl.signal)),
      has('methods') || has('quotes') || has('custom') ? soft(callAI(SYSTEM, extrasPrompt(record, merged, focus), ctrl.signal)) : null,
    ])
    doc.map = withGroups(finalize({ people, themes, extras }, merged, fallback))
    const failed = results().map((r, i) => r?.failed ? i : -1).filter(i => i >= 0)
    for (const i of failed) delete doc.chunks[i]
    doc.status = failed.length ? 'partial' : 'done'
    doc.integrated = !!(people || themes || extras)
    doc.cursor = totalLen
    await save()
    const missed = (has('characters') && !people) || !themes || ((has('methods') || has('quotes') || has('custom')) && !extras)
    const message = failed.length ? `有 ${failed.length} 段没能读取成功，可以点“接着读”补上。` : missed ? 'AI 整合时出了点问题，部分内容为未整合的初稿。' : ''

    // AI 读完了、光标还没读完：读完再换成整合后的导图
    set({ phase: 'playing', message: '' })
    while (cursor < totalLen && !ctrl.signal.aborted) await sleep(200)
    clearInterval(timer)
    set({ phase: 'done', doc: { ...doc }, liveMap: null, message, cursor: totalLen })
  } catch (e) {
    clearInterval(timer)
    if (doc?.chunkCount) {
      if (doc.status !== 'done') doc.cursor = cursor
      window.api.setMindMap(record.id, { ...doc, updatedAt: Date.now() })
    }
    if (e instanceof Cancelled || ctrl.signal.aborted) set({ phase: doc?.status === 'done' ? 'done' : 'cancelled', message: doc?.status === 'done' ? '' : '已停止，已读的部分会保留，可以接着读。', doc: doc && { ...doc }, liveMap: null })
    else set({ phase: 'error', error: e?.message || String(e), doc: doc && { ...doc }, liveMap: null })
  } finally {
    clearInterval(timer)
    job.ctrl = null
    emit(job)
  }
}
