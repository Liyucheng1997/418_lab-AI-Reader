import { useLayoutEffect, useRef, useState } from 'react'
import { Underline, NotebookPen, Copy, Sparkles, Languages, Search, Trash2, Check } from 'lucide-react'
import { HIGHLIGHT_COLORS } from './theme.js'

// 选中文字 / 点击高亮后弹出的浮动工具条
export default function SelectionPopup({ popup, onClose, addHighlight, updateAnn, removeAnn, askAI, onSearch, onCopied }) {
  const ref = useRef()
  const [pos, setPos] = useState(null)
  const [editing, setEditing] = useState(false)
  const [note, setNote] = useState(popup.ann?.note || '')
  const ann = popup.ann

  useLayoutEffect(() => {
    const el = ref.current
    const w = el.offsetWidth, h = el.offsetHeight
    const r = popup.rect || { left: innerWidth / 2, right: innerWidth / 2, top: innerHeight / 2, bottom: innerHeight / 2 }
    let left = (r.left + r.right) / 2 - w / 2
    left = Math.max(10, Math.min(innerWidth - w - 10, left))
    let top = r.top - h - 12
    let below = false
    if (top < 60) { top = r.bottom + 12; below = true }
    if (top + h > innerHeight - 10) top = Math.max(60, innerHeight - h - 10)
    setPos({ left, top, below })
  }, [popup, editing])

  const copy = async () => { await navigator.clipboard.writeText(popup.text || ''); onCopied() }
  const saveNote = () => {
    if (ann) updateAnn(ann.id, { note })
    else addHighlight('yellow', 'highlight', note)
    onClose()
  }

  return (
    <div ref={ref} className="sel-pop" style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' }}
      onMouseDown={e => e.stopPropagation()}>
      {editing ? (
        <div className="note-editor">
          {popup.text && <div className="quote">{popup.text.slice(0, 140)}{popup.text.length > 140 ? '…' : ''}</div>}
          <textarea autoFocus className="input" rows={4} value={note} placeholder="写下你的想法…" onChange={e => setNote(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveNote(); if (e.key === 'Escape') onClose() }} />
          <div className="row">
            <span className="muted" style={{ fontSize: 12 }}>Ctrl + Enter 保存</span>
            <span style={{ flex: 1 }} />
            <button className="btn btn-sm" onClick={onClose}>取消</button>
            <button className="btn btn-sm btn-primary" onClick={saveNote}>保存</button>
          </div>
        </div>
      ) : (
        <>
          <div className="colors">
            {HIGHLIGHT_COLORS.map(([name, hex]) => (
              <button key={name} className="dot" style={{ background: hex }} title="高亮"
                onClick={() => { ann ? updateAnn(ann.id, { color: name, style: 'highlight' }) : addHighlight(name); onClose() }}>
                {ann?.color === name && ann.style !== 'underline' && <Check size={12} strokeWidth={3} color="#fff" />}
              </button>
            ))}
            <button className={`pop-btn icon ${ann?.style === 'underline' ? 'on' : ''}`} title="下划线"
              onClick={() => { ann ? updateAnn(ann.id, { style: 'underline' }) : addHighlight(ann?.color || 'blue', 'underline'); onClose() }}>
              <Underline size={16} />
            </button>
          </div>
          <div className="pop-sep" />
          <div className="actions">
            <button className="pop-btn" onClick={() => setEditing(true)}><NotebookPen size={15} />{ann?.note ? '编辑笔记' : '笔记'}</button>
            <button className="pop-btn" onClick={copy}><Copy size={15} />复制</button>
            <button className="pop-btn accent" onClick={() => askAI('explain', popup.text, popup.cfi, popup.index)}><Sparkles size={15} />AI 解释</button>
            <button className="pop-btn accent" onClick={() => askAI('translate', popup.text, popup.cfi, popup.index)}><Languages size={15} />翻译</button>
            {!ann && <button className="pop-btn" onClick={() => onSearch(popup.text)}><Search size={15} />搜索</button>}
            {ann && <button className="pop-btn danger" onClick={() => { removeAnn(ann.id); onClose() }}><Trash2 size={15} />删除</button>}
          </div>
          {ann?.note && <div className="pop-note">{ann.note}</div>}
        </>
      )}
    </div>
  )
}
