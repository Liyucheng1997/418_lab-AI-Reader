import { useEffect, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'

export default function SearchPanel({ view, book, goTo, onClose, ocrText }) {
  const [query, setQuery] = useState('')
  const [groups, setGroups] = useState([])
  const [progress, setProgress] = useState(null)
  const [done, setDone] = useState(false)
  const token = useRef(0)
  const inputRef = useRef()

  const run = async q => {
    const my = ++token.current
    setGroups([]); setDone(false); setProgress(0)
    view?.clearSearch?.()
    if (!q.trim()) { setProgress(null); return }
    if (book?.pdf) {
      const needle = q.toLowerCase()
      for (let i = 0; i < book.pdf.numPages; i++) {
        if (my !== token.current) return
        const tc = await (await book.pdf.getPage(i + 1)).getTextContent()
        const text = tc.items.map(x => x.str).join('').trim() || ocrText?.(i) || '' // 扫描页搜 OCR 识别出的文字
        const lower = text.toLowerCase()
        const items = []
        for (let at = lower.indexOf(needle); at >= 0 && items.length < 20; at = lower.indexOf(needle, at + needle.length)) {
          items.push({ target: i, excerpt: { pre: text.slice(Math.max(0, at - 30), at), match: text.slice(at, at + q.length), post: text.slice(at + q.length, at + q.length + 40) } })
        }
        if (items.length) setGroups(g => [...g, { label: `第 ${i + 1} 页`, items }])
        if (i % 5 === 0) setProgress((i + 1) / book.pdf.numPages)
      }
    } else {
      const drawOptions = { color: '#0a84ff', width: 2, radius: 3 }
      for await (const r of view.search({ query: q, drawOptions })) {
        if (my !== token.current) return
        if (r === 'done') break
        if (r.progress != null) setProgress(r.progress)
        if (r.subitems) setGroups(g => [...g, { label: r.label, items: r.subitems.map(s => ({ target: s.cfi, excerpt: s.excerpt })) }])
      }
    }
    if (my === token.current) { setDone(true); setProgress(null) }
  }

  useEffect(() => {
    inputRef.current?.focus()
    const onExt = e => { setQuery(e.detail); run(e.detail) }
    window.addEventListener('air-search', onExt)
    return () => { window.removeEventListener('air-search', onExt); token.current++; view?.clearSearch?.() }
  }, [view])

  const total = groups.reduce((n, g) => n + g.items.length, 0)
  return (
    <aside className="r-panel right search">
      <div className="r-panel-head">
        <span className="panel-title">搜索</span>
        <span style={{ flex: 1 }} />
        <button className="icon-btn" onClick={onClose}><X size={16} /></button>
      </div>
      <div className="search-box">
        <label className="search-pill wide">
          <Search size={15} />
          <input ref={inputRef} value={query} placeholder="在书中搜索，回车开始" onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') run(query) }} />
          {query && <X size={14} style={{ cursor: 'pointer' }} onClick={() => { setQuery(''); run('') }} />}
        </label>
        <div className="search-stat">
          {progress != null ? <>正在搜索… {Math.round(progress * 100)}%</> : done ? (total ? `找到 ${total} 处` : '没有找到') : ' '}
        </div>
        {progress != null && <div className="mini-bar"><i style={{ width: `${progress * 100}%` }} /></div>}
      </div>
      <div className="r-panel-body">
        {groups.map((g, gi) => (
          <div key={gi} className="search-group">
            <div className="search-label">{g.label || '正文'}</div>
            {g.items.map((it, i) => (
              <div key={i} className="search-item" onClick={() => goTo(it.target)}>
                {it.excerpt.pre}<mark>{it.excerpt.match}</mark>{it.excerpt.post}
              </div>
            ))}
          </div>
        ))}
      </div>
    </aside>
  )
}
