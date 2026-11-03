import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Search, LayoutGrid, List, Plus, ChevronDown, FolderInput, Download, Folder, ChevronRight,
  BookOpen, Star, Check, X, FolderPlus, Trash2, Library as LibIcon, Cloud, HardDrive, FolderSync,
} from 'lucide-react'
import { useLib } from '../App.jsx'
import { openMenu, Modal } from '../lib/ui.jsx'
import { coverURL } from '../lib/foliate.js'
import Sidebar from './Sidebar.jsx'
import {
  filterBooks, sortBooks, folderPath, childrenOf, countIn, FORMAT_LABEL, formatDate, pct,
} from './model.js'
import { bookMenu, folderMenu, newFolder, folderTreeItems, addToFolder, deleteBooks, linkFolder } from './actions.js'
import { drag, startBookDrag, endDrag, hasFiles } from './dnd.js'

const VIEW_TITLE = { all: '全部图书', recent: '最近阅读', favorite: '收藏', unfiled: '未分类' }
const STATUS_TITLE = { reading: '在读', finished: '已读完' }
const SORTS = [['lastRead', '最近阅读'], ['added', '添加时间'], ['title', '书名'], ['author', '作者'], ['progress', '阅读进度']]

export default function Library() {
  const lib = useLib()
  const { books, folders, settings } = lib
  const [view, setViewRaw] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem('lib-view')) || { type: 'all' } } catch { return { type: 'all' } }
  })
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState([])
  const [anchor, setAnchor] = useState(null)
  const [fileDrop, setFileDrop] = useState(false)
  const [editing, setEditing] = useState(null)
  const searchRef = useRef()

  const setView = v => { setViewRaw(v); setSel([]); sessionStorage.setItem('lib-view', JSON.stringify(v)) }
  useEffect(() => {
    if (view.type === 'folder' && !folders.some(f => f.id === view.value)) setView({ type: 'all' })
  }, [folders])

  const list = useMemo(
    () => sortBooks(filterBooks(books, folders, view, { query, showSub: settings.showSubfolderItems }), settings.sort, view),
    [books, folders, view, query, settings.sort, settings.showSubfolderItems],
  )
  const selBooks = list.filter(b => sel.includes(b.id))

  useEffect(() => {
    const k = e => {
      if (e.target.closest('input, textarea')) { if (e.key === 'Escape') e.target.blur(); return }
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); searchRef.current?.focus() }
      if ((e.ctrlKey || e.metaKey) && e.key === 'a') { e.preventDefault(); setSel(list.map(b => b.id)) }
      if (e.key === 'Escape') setSel([])
      if (e.key === 'Delete' && sel.length) deleteBooks(lib, sel, () => setSel([]))
      if (e.key === 'Enter' && sel.length === 1) lib.openBook(sel[0])
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [list, sel, lib])

  // 点击 = 打开；Ctrl/⌘ 点击 = 多选；Shift 点击 = 连选
  const onBookClick = (e, book) => {
    if (e.ctrlKey || e.metaKey) {
      setSel(s => s.includes(book.id) ? s.filter(x => x !== book.id) : [...s, book.id])
      setAnchor(book.id)
    } else if (e.shiftKey) {
      const a = list.findIndex(b => b.id === (anchor ?? sel[0] ?? book.id))
      const b = list.findIndex(x => x.id === book.id)
      setSel(list.slice(Math.min(a, b), Math.max(a, b) + 1).map(x => x.id))
    } else if (sel.length) {
      setSel(s => s.includes(book.id) ? s.filter(x => x !== book.id) : [...s, book.id])
    } else lib.openBook(book.id)
  }
  const onBookContext = (e, book) => {
    const targets = sel.includes(book.id) ? selBooks : [book]
    if (!sel.includes(book.id)) setSel([])
    openMenu(e, bookMenu(lib, targets, view, { onEdit: setEditing, clearSel: () => setSel([]) }))
  }
  const onBookDragStart = (e, book) => startBookDrag(e, sel.includes(book.id) ? sel : [book.id])

  // ---------- 标题 ----------
  let title = VIEW_TITLE[view.type], crumbs = []
  if (view.type === 'folder') {
    const path = folderPath(folders, view.value)
    title = path.at(-1)?.name
    crumbs = path.slice(0, -1)
  } else if (view.type === 'format') title = view.value
  else if (view.type === 'status') title = STATUS_TITLE[view.value]
  else if (view.type === 'storage') title = view.value === 'cloud' ? '仅在云端' : '本地'
  const subfolders = view.type === 'folder' ? childrenOf(folders, view.value) : []
  const currentFolder = view.type === 'folder' ? view.value : null

  const importMenu = e => {
    const r = e.currentTarget.getBoundingClientRect()
    openMenu({ clientX: r.right - 200, clientY: r.bottom + 6 }, [
      { label: '导入图书…', icon: Download, shortcut: 'Ctrl+O', onClick: async () => lib.afterImport(await window.api.importDialog(currentFolder, 'files')) },
      { label: '导入文件夹（保留结构）…', icon: FolderInput, onClick: async () => lib.afterImport(await window.api.importDialog(currentFolder, 'directory')) },
      { label: '关联文件夹（OneDrive 等，不复制）…', icon: FolderSync, onClick: () => linkFolder(lib) },
      { sep: true },
      { label: currentFolder ? '新建子文件夹' : '新建文件夹', icon: FolderPlus, onClick: () => newFolder(lib, currentFolder) },
    ])
  }
  useEffect(() => {
    const k = async e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'o') { e.preventDefault(); lib.afterImport(await window.api.importDialog(currentFolder, 'files')) }
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [currentFolder, lib])

  // ---------- 从资源管理器拖入 ----------
  const dropProps = {
    onDragOver: e => { if (hasFiles(e)) { e.preventDefault(); setFileDrop(true) } },
    onDragLeave: e => { if (!e.currentTarget.contains(e.relatedTarget)) setFileDrop(false) },
    onDrop: async e => {
      setFileDrop(false)
      if (!hasFiles(e)) return
      e.preventDefault()
      const paths = [...e.dataTransfer.files].map(f => window.api.pathForFile(f)).filter(Boolean)
      lib.afterImport(await window.api.importPaths(paths, currentFolder))
    },
  }

  return (
    <>
      <Sidebar view={view} setView={setView} />
      <main className="main" {...dropProps}>
        <div className="topbar drag">
          <label className="search-pill">
            <Search size={15} />
            <input ref={searchRef} value={query} placeholder="搜索书名、作者" onChange={e => setQuery(e.target.value)} />
            {query && <X size={14} style={{ cursor: 'pointer' }} onClick={() => setQuery('')} />}
          </label>
          <span className="grow" />
          {lib.parsing > 0 && <span className="parse-tip"><span className="spinner" />正在读取封面…</span>}
        </div>

        <div className="lib-head">
          <div className="titles">
            <div className="crumbs">
              {view.type === 'folder' && (
                <>
                  <span className="link" onClick={() => setView({ type: 'all' })}>全部图书</span>
                  {crumbs.map(c => (
                    <span key={c.id} style={{ display: 'contents' }}>
                      <ChevronRight size={12} />
                      <span className="link" onClick={() => setView({ type: 'folder', value: c.id })}>{c.name}</span>
                    </span>
                  ))}
                </>
              )}
            </div>
            <div className="lib-title">{title}</div>
            <div className="lib-sub">
              {list.length} 本书
              {view.type === 'folder' && subfolders.length > 0 && ` · ${subfolders.length} 个子文件夹`}
              {view.type === 'folder' && settings.showSubfolderItems && subfolders.length > 0 && '（含子文件夹中的书）'}
            </div>
          </div>
          <div className="lib-tools">
            <select className="select-pill" value={settings.sort} onChange={e => lib.updateSettings({ sort: e.target.value })}
              disabled={view.type === 'recent'}>
              {SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <div className="seg icons">
              <button className={settings.view === 'grid' ? 'active' : ''} title="封面视图" onClick={() => lib.updateSettings({ view: 'grid' })}><LayoutGrid size={15} /></button>
              <button className={settings.view === 'list' ? 'active' : ''} title="列表视图" onClick={() => lib.updateSettings({ view: 'list' })}><List size={15} /></button>
            </div>
            <button className="btn btn-primary" onClick={importMenu}><Plus size={16} strokeWidth={2.2} />导入<ChevronDown size={14} /></button>
          </div>
        </div>

        <div className="lib-body" onClick={e => { if (e.target === e.currentTarget) setSel([]) }}>
          {subfolders.length > 0 && (
            <div className="subfolders">
              {subfolders.map(f => <FolderChip key={f.id} folder={f} setView={setView} />)}
            </div>
          )}
          {list.length === 0 ? (
            <Empty view={view} query={query} currentFolder={currentFolder} />
          ) : settings.view === 'grid' ? (
            <div className="grid">
              {list.map((b, i) => (
                <BookCard key={b.id} book={b} index={i} selected={sel.includes(b.id)}
                  onClick={e => onBookClick(e, b)} onContextMenu={e => onBookContext(e, b)}
                  onDragStart={e => onBookDragStart(e, b)} />
              ))}
            </div>
          ) : (
            <BookList list={list} sel={sel} onClick={onBookClick} onContextMenu={onBookContext}
              onDragStart={onBookDragStart} sort={settings.sort} setSort={s => lib.updateSettings({ sort: s })} />
          )}
        </div>

        {sel.length > 0 && (
          <div className="sel-bar">
            <span className="n">已选 {sel.length} 本</span>
            <button className="btn btn-sm" onClick={e => openMenu(e, [
              ...folderTreeItems(folders, f => addToFolder(lib, sel, f)),
              { sep: true },
              { label: '新建文件夹…', icon: FolderPlus, onClick: () => newFolder(lib, null, f => addToFolder(lib, sel, f)) },
            ])}><Folder size={14} />添加到文件夹</button>
            <button className="btn btn-sm" onClick={() => lib.updateBooks(sel, { favorite: !selBooks.every(b => b.favorite) })}><Star size={14} />收藏</button>
            <button className="btn btn-sm btn-danger" onClick={() => deleteBooks(lib, sel, () => setSel([]))}><Trash2 size={14} />删除</button>
            <button className="icon-btn" title="取消选择" onClick={() => setSel([])}><X size={16} /></button>
          </div>
        )}
        {fileDrop && (
          <div className="drop-overlay"><Download size={30} />松开即可导入{title && view.type === 'folder' ? `到“${title}”` : ''}</div>
        )}
      </main>
      {editing && <EditBook book={editing} onClose={() => setEditing(null)} />}
    </>
  )
}

function FolderChip({ folder, setView }) {
  const lib = useLib()
  const [over, setOver] = useState(false)
  return (
    <div className={`folder-chip ${over ? 'drop-into' : ''}`}
      onClick={() => setView({ type: 'folder', value: folder.id })}
      onContextMenu={e => openMenu(e, folderMenu(lib, folder, setView))}
      onDragOver={e => { if (drag.kind === 'books') { e.preventDefault(); setOver(true) } }}
      onDragLeave={() => setOver(false)}
      onDrop={async e => {
        setOver(false)
        if (drag.kind !== 'books') return
        e.preventDefault(); e.stopPropagation()
        await addToFolder(lib, drag.ids, folder)
        endDrag()
      }}>
      <Folder size={17} strokeWidth={1.75} className="ico" />
      {folder.name}
      <span className="count">{countIn(lib.books, lib.folders, folder.id, lib.settings.showSubfolderItems)}</span>
    </div>
  )
}

export function Cover({ book, mini }) {
  const fmt = FORMAT_LABEL[book.format] || book.format.toUpperCase()
  if (book.cover) return <img src={coverURL(book.id, book.cover)} alt="" draggable={false} loading="lazy" />
  if (mini) return <span>{fmt}</span>
  return (
    <div className="cover-ph">
      <div className="ph-title">{book.title}</div>
      {book.author && <div className="ph-author">{book.author}</div>}
      <div className="ph-rule" />
      <div className="ph-fmt">{fmt}</div>
    </div>
  )
}

// 关联文件夹里的书：标出在本地还是只在云端
function Where({ book, inline }) {
  return book.cloud
    ? <span className={inline ? 'where-inline cloud' : 'where cloud'} title="仅在 OneDrive 云端，打开时自动下载"><Cloud size={11} strokeWidth={2.2} />云端</span>
    : <span className={inline ? 'where-inline' : 'where'} title="已在本地，可离线阅读"><HardDrive size={11} strokeWidth={2.2} />本地</span>
}

function BookCard({ book, selected, index, ...handlers }) {
  return (
    <div className={`book-card ${selected ? 'selected' : ''}`} draggable onDragEnd={endDrag}
      style={{ animationDelay: Math.min(index, 24) * 18 + 'ms' }} {...handlers}>
      <div className="cover">
        <Cover book={book} />
        {book.cover > 0 && <span className="badge">{FORMAT_LABEL[book.format]}</span>}
        {book.favorite && <span className="fav"><Star size={12} fill="currentColor" /></span>}
        {book.linked && <Where book={book} />}
        {selected && <span className="check"><Check size={14} strokeWidth={3} /></span>}
        {book.progress > 0 && book.status !== 'finished' && <div className="bar"><i style={{ width: pct(book.progress) }} /></div>}
      </div>
      <div className="book-meta">
        <div className="book-title" title={book.title}>{book.title}</div>
        <div className="book-sub">
          <span className="author">{book.author || '佚名'}</span>
          {book.status === 'finished'
            ? <span className="status-dot done">已读完</span>
            : book.progress > 0 ? <span className="pct">{pct(book.progress)}</span> : null}
        </div>
      </div>
    </div>
  )
}

function BookList({ list, sel, onClick, onContextMenu, onDragStart, sort, setSort }) {
  const H = ({ k, children }) => (
    <span className="sortable" style={sort === k ? { color: 'var(--primary)' } : null} onClick={() => setSort(k)}>{children}</span>
  )
  return (
    <div className="list">
      <div className="list-head">
        <span />
        <H k="title">书名</H>
        <H k="author">作者</H>
        <span>格式</span>
        <H k="progress">进度</H>
        <H k="lastRead">最近阅读</H>
        <H k="added">添加时间</H>
      </div>
      {list.map(b => (
        <div key={b.id} className={`list-row ${sel.includes(b.id) ? 'selected' : ''}`} draggable
          onDragStart={e => onDragStart(e, b)} onDragEnd={endDrag}
          onClick={e => onClick(e, b)} onContextMenu={e => onContextMenu(e, b)}>
          <div className="mini-cover"><Cover book={b} mini /></div>
          <div className="t" title={b.title}>{b.favorite && <Star size={12} fill="#ffd60a" color="#ffd60a" />}{b.title}{b.linked && <Where book={b} inline />}</div>
          <div className="c">{b.author || '—'}</div>
          <div className="c">{FORMAT_LABEL[b.format]}</div>
          <div className="c">
            {b.status === 'finished' ? <span className="status-dot done">已读完</span> : (
              <>
                {pct(b.progress)}
                <div className="mini-bar"><i style={{ width: pct(b.progress) }} /></div>
              </>
            )}
          </div>
          <div className="c">{formatDate(b.lastReadAt)}</div>
          <div className="c">{formatDate(b.addedAt)}</div>
        </div>
      ))}
    </div>
  )
}

function Empty({ view, query, currentFolder }) {
  const lib = useLib()
  if (query) return <div className="empty"><Search size={34} strokeWidth={1.4} className="ico" />没有找到“{query}”相关的书</div>
  if (view.type === 'folder') return (
    <div className="empty">
      <Folder size={34} strokeWidth={1.4} className="ico" />
      <div>这个文件夹还是空的。<br />把左侧或书库里的书拖到这里，或直接导入。</div>
      <div className="btns">
        <button className="btn btn-primary" onClick={async () => lib.afterImport(await window.api.importDialog(currentFolder, 'files'))}><Download size={15} />导入图书</button>
        <button className="btn" onClick={() => newFolder(lib, currentFolder)}><FolderPlus size={15} />新建子文件夹</button>
      </div>
    </div>
  )
  if (view.type === 'all') return (
    <div className="empty">
      <LibIcon size={40} strokeWidth={1.3} className="ico" />
      <div className="big">开始建立你的书库</div>
      <div>支持 EPUB、PDF、TXT、MOBI、AZW3、FB2、CBZ。<br />可以直接把文件或文件夹拖进窗口。</div>
      <div className="btns">
        <button className="btn btn-primary" onClick={async () => lib.afterImport(await window.api.importDialog(null, 'files'))}><Download size={15} />导入图书</button>
        <button className="btn" onClick={async () => lib.afterImport(await window.api.importDialog(null, 'directory'))}><FolderInput size={15} />导入文件夹</button>
      </div>
    </div>
  )
  return <div className="empty"><BookOpen size={34} strokeWidth={1.4} className="ico" />这里还没有书</div>
}

function EditBook({ book, onClose }) {
  const lib = useLib()
  const [title, setTitle] = useState(book.title)
  const [author, setAuthor] = useState(book.author)
  const save = async () => { await lib.updateBooks(book.id, { title: title.trim() || book.title, author: author.trim() }); onClose() }
  return (
    <Modal title="编辑图书信息" onClose={onClose} width={420}
      footer={<><button className="btn" onClick={onClose}>取消</button><button className="btn btn-primary" onClick={save}>保存</button></>}>
      <div className="form-body" onKeyDown={e => e.key === 'Enter' && save()}>
        <label>书名<input className="input" autoFocus value={title} onChange={e => setTitle(e.target.value)} /></label>
        <label>作者<input className="input" value={author} onChange={e => setAuthor(e.target.value)} /></label>
        <div className="muted" style={{ fontSize: 12 }}>文件：{book.fileName} · {(book.size / 1048576).toFixed(1)} MB</div>
      </div>
    </Modal>
  )
}
