// 全局弹层：提示、确认框、输入框、右键菜单（可多级）
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight, X, AlertTriangle, FolderPlus } from 'lucide-react'

let host = null
let seq = 0

export function toast(text, type = 'info') {
  host?.addToast({ id: ++seq, text, type })
}
export function confirmDialog(opts) {
  return new Promise(resolve => host?.setDialog({ kind: 'confirm', ...opts, resolve }))
}
export function promptDialog(opts) {
  return new Promise(resolve => host?.setDialog({ kind: 'prompt', ...opts, resolve }))
}
export function openMenu(e, items) {
  e.preventDefault?.()
  e.stopPropagation?.()
  host?.setMenu({ x: e.clientX, y: e.clientY, items })
}
export function closeMenu() { host?.setMenu(null) }

export function UIHost() {
  const [toasts, setToasts] = useState([])
  const [dialog, setDialog] = useState(null)
  const [menu, setMenu] = useState(null)
  host = {
    addToast: t => {
      setToasts(list => [...list, t])
      setTimeout(() => setToasts(list => list.map(x => x.id === t.id ? { ...x, hide: true } : x)), 2400)
      setTimeout(() => setToasts(list => list.filter(x => x.id !== t.id)), 2800)
    },
    setDialog, setMenu,
  }
  return createPortal(
    <>
      <div className="toast-host">
        {toasts.map(t => <Toast key={t.id} t={t} />)}
      </div>
      {dialog && <Dialog d={dialog} close={() => setDialog(null)} />}
      {menu && <Menu menu={menu} close={() => setMenu(null)} />}
    </>,
    document.body,
  )
}

function Toast({ t }) {
  const [show, setShow] = useState(false)
  useEffect(() => { requestAnimationFrame(() => setShow(true)) }, [])
  return <div className={`toast toast-${t.type} ${show && !t.hide ? 'show' : ''}`}>{t.text}</div>
}

export function Modal({ title, onClose, children, footer, width = 420, className = '' }) {
  useEffect(() => {
    const k = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  return createPortal(
    <div className="modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className={`modal ${className}`} style={{ width }}>
        {title != null && (
          <div className="modal-header">
            <span>{title}</span>
            <button className="modal-x" onClick={onClose}><X size={15} /></button>
          </div>
        )}
        {children}
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

function Dialog({ d, close }) {
  const [value, setValue] = useState(d.value ?? '')
  const inputRef = useRef()
  useEffect(() => { inputRef.current?.select() }, [])
  const done = ok => {
    close()
    d.resolve(d.kind === 'prompt' ? (ok ? value.trim() || null : null) : ok)
  }
  const Icon = d.icon || (d.danger ? AlertTriangle : FolderPlus)
  return (
    <Modal onClose={() => done(false)} width={380} className="confirm">
      <div className="confirm-body" onKeyDown={e => { if (e.key === 'Enter') done(true) }}>
        <div className={`confirm-icon ${d.danger ? 'danger' : ''}`}><Icon size={22} strokeWidth={1.8} /></div>
        <div className="confirm-title">{d.title}</div>
        {d.message && <div className="confirm-msg">{d.message}</div>}
        {d.kind === 'prompt' && (
          <input ref={inputRef} autoFocus className="input confirm-input" value={value}
            placeholder={d.placeholder} onChange={e => setValue(e.target.value)} />
        )}
        <div className="confirm-actions">
          <button className="btn" onClick={() => done(false)}>取消</button>
          <button autoFocus={d.kind !== 'prompt'} className={`btn ${d.danger ? 'btn-danger-solid' : 'btn-primary'}`} onClick={() => done(true)}>
            {d.okText || '确定'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

function Menu({ menu, close }) {
  useEffect(() => {
    const off = e => { if (!e.target.closest?.('.popover')) close() }
    const k = e => { if (e.key === 'Escape') close() }
    window.addEventListener('mousedown', off, true)
    window.addEventListener('keydown', k)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('mousedown', off, true)
      window.removeEventListener('keydown', k)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
    }
  }, [close])
  return <MenuList items={menu.items} x={menu.x} y={menu.y} close={close} />
}

function MenuList({ items, x, y, close, sub }) {
  const ref = useRef()
  const [pos, setPos] = useState({ left: x, top: y, ready: false })
  const [open, setOpen] = useState(-1)
  const [subPos, setSubPos] = useState(null)
  useLayoutEffect(() => {
    const r = ref.current.getBoundingClientRect()
    let left = x, top = y
    if (left + r.width > innerWidth - 6) left = sub ? sub.left - r.width + 4 : innerWidth - r.width - 6
    if (top + r.height > innerHeight - 6) top = Math.max(6, innerHeight - r.height - 6)
    setPos({ left, top, ready: true })
  }, [x, y])
  return (
    <div ref={ref} className="popover menu" style={{ left: pos.left, top: pos.top, visibility: pos.ready ? 'visible' : 'hidden' }}
      onContextMenu={e => e.preventDefault()}>
      {items.filter(Boolean).map((it, i) => {
        if (it.sep) return <div key={i} className="menu-sep" />
        if (it.header) return <div key={i} className="menu-header">{it.header}</div>
        const Icon = it.icon
        const hasSub = it.children?.length > 0
        return (
          <div key={i}
            className={`menu-item ${it.disabled ? 'disabled' : ''} ${it.danger ? 'danger' : ''} ${open === i ? 'open' : ''}`}
            style={it.indent ? { paddingLeft: 6 + it.indent * 14 } : null}
            onMouseEnter={e => {
              if (hasSub) {
                const r = e.currentTarget.getBoundingClientRect()
                setSubPos({ x: r.right - 4, y: r.top - 5, left: r.left })
                setOpen(i)
              } else setOpen(-1)
            }}
            onClick={() => {
              if (it.disabled || hasSub) return
              close()
              it.onClick?.()
            }}>
            <span className="menu-icon">{Icon ? <Icon size={15} strokeWidth={1.75} /> : it.check ? '✓' : null}</span>
            <span className="menu-label">{it.label}</span>
            {it.shortcut && <span className="menu-shortcut">{it.shortcut}</span>}
            {hasSub && <ChevronRight size={14} className="menu-shortcut" />}
            {hasSub && open === i && subPos && (
              <MenuList items={it.children} x={subPos.x} y={subPos.y} close={close} sub={subPos} />
            )}
          </div>
        )
      })}
      {!items.filter(Boolean).length && <div className="menu-header">（空）</div>}
    </div>
  )
}
