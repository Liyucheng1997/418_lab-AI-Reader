import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, X, Bookmark, Trash2, Download, NotebookPen, Pencil } from 'lucide-react'
import { colorOf } from './theme.js'
import { formatDate } from '../library/model.js'
import { toast } from '../lib/ui.jsx'

export default function SidePanel({ tab, setTab, toc, loc, anns, book, goTo, removeAnn, updateAnn, onClose }) {
  return (
    <aside className="r-panel left">
      <div className="r-panel-head">
        <div className="seg">
          <button className={tab === 'toc' ? 'active' : ''} onClick={() => setTab('toc')}>目录</button>
          <button className={tab === 'bookmarks' ? 'active' : ''} onClick={() => setTab('bookmarks')}>书签</button>
          <button className={tab === 'notes' ? 'active' : ''} onClick={() => setTab('notes')}>笔记</button>
        </div>
        <span style={{ flex: 1 }} />
        <button className="icon-btn" onClick={onClose}><X size={16} /></button>
      </div>
      <div className="r-panel-body">
        {tab === 'toc' && <Toc toc={toc} current={loc?.tocItem?.href} goTo={goTo} />}
        {tab === 'bookmarks' && <Bookmarks anns={anns} goTo={goTo} removeAnn={removeAnn} />}
        {tab === 'notes' && <Notes anns={anns} book={book} goTo={goTo} removeAnn={removeAnn} updateAnn={updateAnn} />}
      </div>
    </aside>
  )
}

function containsHref(item, href) {
  return item.href === href || item.subitems?.some(s => containsHref(s, href))
}

function Toc({ toc, current, goTo }) {
  const ref = useRef()
  useEffect(() => {
    ref.current?.querySelector('.toc-item.current')?.scrollIntoView({ block: 'center' })
  }, [])
  if (!toc.length) return <div className="panel-empty">这本书没有目录</div>
  return <div ref={ref} className="toc">{toc.map((t, i) => <TocItem key={i} item={t} depth={0} current={current} goTo={goTo} />)}</div>
}

function TocItem({ item, depth, current, goTo }) {
  const hasKids = item.subitems?.length > 0
  const [open, setOpen] = useState(() => hasKids && containsHref(item, current) && item.href !== current)
  return (
    <>
      <div className={`toc-item ${item.href === current ? 'current' : ''}`} style={{ paddingLeft: 8 + depth * 16 }}
        onClick={() => item.href && goTo(item.href)}>
        <span className={`twisty ${open ? 'open' : ''}`} style={{ visibility: hasKids ? 'visible' : 'hidden' }}
          onClick={e => { e.stopPropagation(); setOpen(o => !o) }}>
          <ChevronRight size={13} strokeWidth={2.2} />
        </span>
        <span className="label">{item.label?.trim() || '（无标题）'}</span>
      </div>
      {open && item.subitems.map((s, i) => <TocItem key={i} item={s} depth={depth + 1} current={current} goTo={goTo} />)}
    </>
  )
}

function Bookmarks({ anns, goTo, removeAnn }) {
  const list = anns.filter(a => a.type === 'bookmark').sort((a, b) => (a.fraction ?? 0) - (b.fraction ?? 0))
  if (!list.length) return <div className="panel-empty"><Bookmark size={28} strokeWidth={1.4} />还没有书签<br />按 Ctrl + B 给当前页加书签</div>
  return (
    <div className="ann-list">
      {list.map(b => (
        <div key={b.id} className="ann-item" onClick={() => goTo(b.cfi)}>
          <div className="ann-meta">
            <span className="chap">{b.chapter || '书签'}</span>
            <span className="tabular">{Math.round((b.fraction || 0) * 100)}%</span>
            <button className="icon-btn mini" title="删除" onClick={e => { e.stopPropagation(); removeAnn(b.id) }}><Trash2 size={13} /></button>
          </div>
          {b.text && <div className="ann-text">{b.text}…</div>}
        </div>
      ))}
    </div>
  )
}

export function notesMarkdown(book, anns) {
  const lines = [`# ${book.title}`, '']
  if (book.author) lines.push(`作者：${book.author}`, '')
  let chap = null
  for (const a of anns.filter(a => a.type !== 'bookmark')) {
    if (a.chapter && a.chapter !== chap) { chap = a.chapter; lines.push(`## ${chap}`, '') }
    if (a.text) lines.push(...a.text.split('\n').map(l => `> ${l}`), '')
    if (a.note) lines.push(a.note, '')
    lines.push(`<sub>${new Date(a.createdAt).toLocaleString()}</sub>`, '', '---', '')
  }
  return lines.join('\n')
}

function Notes({ anns, book, goTo, removeAnn, updateAnn }) {
  const [filter, setFilter] = useState('all')
  const [editId, setEditId] = useState(null)
  const [draft, setDraft] = useState('')
  const list = useMemo(() => anns.filter(a => a.type !== 'bookmark')
    .filter(a => filter === 'all' || (filter === 'noted' ? a.note : a.color === filter)), [anns, filter])
  const colors = [...new Set(anns.filter(a => a.type === 'highlight').map(a => a.color))]
  const exportMd = async () => {
    const p = await window.api.saveText(`${book.title} - 笔记.md`, notesMarkdown(book, anns))
    if (p) toast('笔记已导出', 'success')
  }
  return (
    <>
      <div className="notes-tools">
        <button className={`chip ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>全部 {anns.filter(a => a.type !== 'bookmark').length}</button>
        <button className={`chip ${filter === 'noted' ? 'active' : ''}`} onClick={() => setFilter('noted')}>有笔记</button>
        {colors.map(c => (
          <button key={c} className={`color-chip ${filter === c ? 'active' : ''}`} style={{ background: colorOf(c) }} onClick={() => setFilter(f => f === c ? 'all' : c)} />
        ))}
        <span style={{ flex: 1 }} />
        <button className="icon-btn" title="导出为 Markdown" onClick={exportMd} disabled={!anns.length}><Download size={16} /></button>
      </div>
      {!list.length ? (
        <div className="panel-empty"><NotebookPen size={28} strokeWidth={1.4} />还没有笔记<br />选中文字即可高亮、写笔记</div>
      ) : (
        <div className="ann-list">
          {list.map(a => (
            <div key={a.id} className="ann-item" onClick={() => editId !== a.id && a.cfi && goTo(a.cfi)}>
              <div className="ann-meta">
                <span className="chap">{a.chapter || (a.type === 'note' ? '笔记' : '高亮')}</span>
                <span>{formatDate(a.createdAt)}</span>
                <button className="icon-btn mini" title="编辑笔记" onClick={e => { e.stopPropagation(); setEditId(a.id); setDraft(a.note || '') }}><Pencil size={13} /></button>
                <button className="icon-btn mini" title="删除" onClick={e => { e.stopPropagation(); removeAnn(a.id) }}><Trash2 size={13} /></button>
              </div>
              {a.text && (
                <div className="ann-quote" style={{ '--c': a.type === 'highlight' ? colorOf(a.color) : 'var(--line-strong)' }}>{a.text}</div>
              )}
              {editId === a.id ? (
                <div className="ann-edit" onClick={e => e.stopPropagation()}>
                  <textarea className="input" autoFocus rows={4} value={draft} onChange={e => setDraft(e.target.value)} />
                  <div className="row">
                    <button className="btn btn-sm" onClick={() => setEditId(null)}>取消</button>
                    <button className="btn btn-sm btn-primary" onClick={() => { updateAnn(a.id, { note: draft }); setEditId(null) }}>保存</button>
                  </div>
                </div>
              ) : a.note && <div className="ann-note">{a.note}</div>}
            </div>
          ))}
        </div>
      )}
    </>
  )
}
