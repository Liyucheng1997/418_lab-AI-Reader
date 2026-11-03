// TXT → foliate 可用的 book 对象：自动识别编码、按章节标题分章

const CHAPTER_RE = /^\s*(第\s*[0-9０-９零一二三四五六七八九十百千万两〇]+\s*[章节回卷集部篇幕话]|(chapter|part|book)\s+[0-9ivxlc]+\b|卷\s*[0-9一二三四五六七八九十百]+|序章|序言|序|楔子|引子|前言|后记|尾声|终章|番外|附录)[^\n]{0,40}$/i
const PART_SIZE = 30000

export function decodeText(buffer) {
  const bytes = new Uint8Array(buffer)
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes)
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('gb18030').decode(bytes)
  }
}

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function splitChapters(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const chapters = []
  let cur = { title: '', lines: [] }
  for (const line of lines) {
    const t = line.trim()
    if (t && t.length <= 40 && CHAPTER_RE.test(t)) {
      if (cur.lines.some(l => l.trim()) || cur.title) chapters.push(cur)
      cur = { title: t, lines: [] }
    } else cur.lines.push(line)
  }
  chapters.push(cur)
  // 识别到的章节太少：按长度切分
  if (chapters.filter(c => c.title).length < 2) {
    const all = lines
    const parts = []
    let buf = [], size = 0
    for (const l of all) {
      buf.push(l); size += l.length
      if (size >= PART_SIZE && !l.trim()) { parts.push(buf); buf = []; size = 0 }
      else if (size >= PART_SIZE * 1.5) { parts.push(buf); buf = []; size = 0 }
    }
    if (buf.length) parts.push(buf)
    return parts.map((p, i) => ({ title: parts.length > 1 ? `第 ${i + 1} 部分` : '正文', lines: p }))
  }
  // 第一段前言没有标题
  if (!chapters[0].title) chapters[0].title = '开始'
  return chapters
}

function chapterHTML(ch, bookTitle) {
  const paras = ch.lines.map(l => l.trim()).filter(Boolean).map(l => `<p>${esc(l)}</p>`).join('\n')
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>${esc(ch.title || bookTitle)}</title>
<style>p{text-indent:2em;margin:.6em 0}h2{text-align:center;margin:1em 0 1.4em;font-weight:600}</style></head>
<body>${ch.title ? `<h2>${esc(ch.title)}</h2>` : ''}${paras}</body></html>`
}

export function makeTxtBook(buffer, title) {
  const text = decodeText(buffer)
  const chapters = splitChapters(text)
  const urls = new Map()
  const htmls = chapters.map(ch => chapterHTML(ch, title))
  const sections = htmls.map((html, i) => ({
    id: i,
    linear: 'yes',
    size: new Blob([html]).size,
    load: () => {
      if (!urls.has(i)) urls.set(i, URL.createObjectURL(new Blob([html], { type: 'text/html' })))
      return urls.get(i)
    },
    unload: () => { URL.revokeObjectURL(urls.get(i)); urls.delete(i) },
    createDocument: () => new DOMParser().parseFromString(html, 'text/html'),
  }))
  const toc = chapters.map((ch, i) => ({ label: ch.title, href: `#s${i}` }))
  const parseHref = href => Number(/#s(\d+)/.exec(href)?.[1] ?? 0)
  return {
    metadata: { title, language: 'zh' },
    toc,
    sections,
    dir: 'ltr',
    rendition: {},
    resolveHref: href => ({ index: parseHref(href), anchor: doc => doc.body }),
    splitTOCHref: href => [parseHref(href), null],
    getTOCFragment: doc => doc.body,
    isExternal: uri => /^\w+:/i.test(uri),
    getCover: async () => null,
    destroy: () => { for (const u of urls.values()) URL.revokeObjectURL(u) },
  }
}
