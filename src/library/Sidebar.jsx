import { useState } from 'react'
import {
  Library as LibIcon, Clock, Star, Inbox, FileText, Folder, FolderOpen, ChevronRight, Plus,
  Settings, Moon, Sun, BookOpen, CheckCircle2, Sparkles, Cloud, HardDrive, FolderSync,
} from 'lucide-react'
import { useLib } from '../App.jsx'
import { openMenu, toast } from '../lib/ui.jsx'
import { childrenOf, countIn, descendants, FORMAT_LABEL } from './model.js'
import { folderMenu, newFolder, addToFolder, errText } from './actions.js'
import { drag, startFolderDrag, endDrag, hasFiles } from './dnd.js'

const same = (a, b) => a.type === b.type && a.value === b.value

export default function Sidebar({ view, setView }) {
  const lib = useLib()
  const { books, folders, settings } = lib
  const [rootDrop, setRootDrop] = useState(false)
  const formats = [...new Set(books.map(b => FORMAT_LABEL[b.format] || b.format))].sort()
  const dark = document.documentElement.dataset.theme === 'dark'

  const Item = ({ v, icon: Icon, label, count }) => (
    <div className={`nav-item ${same(view, v) ? 'active' : ''}`} onClick={() => setView(v)}>
      <Icon size={17} strokeWidth={1.75} className="ico" />
      <span className="label">{label}</span>
      {count != null && <span className="count">{count}</span>}
    </div>
  )

  const roots = childrenOf(folders, null)

  return (
    <aside className="sidebar">
      <div className="sb-brand drag">
        <div className="logo-mark"><BookOpen size={16} strokeWidth={2.2} /></div>
        <div>
          <div className="name">AI Reader</div>
          <div className="sub">阅读 · 整理 · 思考</div>
        </div>
      </div>
      <div className="sb-scroll">
        <div className="sb-group" style={{ marginTop: 4 }}>
          <Item v={{ type: 'all' }} icon={LibIcon} label="全部图书" count={books.length} />
          <Item v={{ type: 'recent' }} icon={Clock} label="最近阅读" />
          <Item v={{ type: 'favorite' }} icon={Star} label="收藏" count={books.filter(b => b.favorite).length || null} />
          <Item v={{ type: 'unfiled' }} icon={Inbox} label="未分类" count={books.filter(b => !b.folders.length).length || null} />
        </div>

        <div className="sb-group">
          <div className={`sb-group-head ${rootDrop ? 'drop-target' : ''}`}
            onDragOver={e => { if (drag.kind === 'folder') { e.preventDefault(); setRootDrop(true) } }}
            onDragLeave={() => setRootDrop(false)}
            onDrop={async e => {
              setRootDrop(false)
              if (drag.kind !== 'folder') return
              e.preventDefault()
              try { lib.setFolders(await window.api.moveFolder(drag.folderId, null)) } catch (err) { toast(errText(err), 'error') }
              endDrag()
            }}>
            <span>文件夹</span>
            <button className="icon-btn" title="新建文件夹" onClick={() => newFolder(lib, null)}><Plus size={15} /></button>
          </div>
          {roots.map(f => <FolderNode key={f.id} folder={f} depth={0} view={view} setView={setView} />)}
          {!roots.length && (
            <div className="tree-empty">像 Zotero 一样建立多级文件夹，把书拖进来分类。一本书可以同时放在多个文件夹里。</div>
          )}
        </div>

        <div className="sb-group">
          <div className="sb-group-head"><span>阅读状态</span></div>
          <Item v={{ type: 'status', value: 'reading' }} icon={BookOpen} label="在读" count={books.filter(b => b.status === 'reading').length || null} />
          <Item v={{ type: 'status', value: 'finished' }} icon={CheckCircle2} label="已读完" count={books.filter(b => b.status === 'finished').length || null} />
        </div>

        {books.some(b => b.linked) && (
          <div className="sb-group">
            <div className="sb-group-head"><span>位置</span></div>
            <Item v={{ type: 'storage', value: 'local' }} icon={HardDrive} label="本地" count={books.filter(b => !b.cloud).length} />
            <Item v={{ type: 'storage', value: 'cloud' }} icon={Cloud} label="仅在云端" count={books.filter(b => b.cloud).length || null} />
          </div>
        )}

        {formats.length > 0 && (
          <div className="sb-group">
            <div className="sb-group-head"><span>格式</span></div>
            {formats.map(f => (
              <Item key={f} v={{ type: 'format', value: f }} icon={FileText} label={f}
                count={books.filter(b => (FORMAT_LABEL[b.format] || b.format) === f).length} />
            ))}
          </div>
        )}
      </div>
      <div className="sb-foot">
        <button className="icon-btn" title="设置" onClick={() => lib.openSettings('general')}><Settings size={17} strokeWidth={1.75} /></button>
        <button className="icon-btn" title="AI 助手设置" onClick={() => lib.openSettings('ai')}><Sparkles size={17} strokeWidth={1.75} /></button>
        <span className="grow" />
        <button className="icon-btn" title={dark ? '浅色模式' : '深色模式'}
          onClick={() => lib.updateSettings({ theme: dark ? 'light' : 'dark' })}>
          {dark ? <Sun size={17} strokeWidth={1.75} /> : <Moon size={17} strokeWidth={1.75} />}
        </button>
      </div>
    </aside>
  )
}

function FolderNode({ folder, depth, view, setView }) {
  const lib = useLib()
  const { folders, books, settings } = lib
  const [drop, setDrop] = useState(null) // before | after | into
  const kids = childrenOf(folders, folder.id)
  const active = view.type === 'folder' && view.value === folder.id
  const count = countIn(books, folders, folder.id, settings.showSubfolderItems)
  const toggle = async e => {
    e?.stopPropagation()
    lib.setFolders(await window.api.updateFolder(folder.id, { expanded: !folder.expanded }))
  }

  const onDragOver = e => {
    if (drag.kind === 'books' || hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDrop('into'); return }
    if (drag.kind !== 'folder' || descendants(folders, drag.folderId).includes(folder.id)) return
    e.preventDefault()
    const r = e.currentTarget.getBoundingClientRect()
    const y = (e.clientY - r.top) / r.height
    setDrop(y < 0.25 ? 'before' : y > 0.75 && !(folder.expanded && kids.length) ? 'after' : 'into')
  }
  const onDrop = async e => {
    const where = drop
    setDrop(null)
    e.preventDefault()
    e.stopPropagation()
    if (drag.kind === 'books') {
      await addToFolder(lib, drag.ids, folder) // 关联文件夹：在 OneDrive 里移动文件
    } else if (drag.kind === 'folder') {
      try {
        if (where === 'into') {
          lib.setFolders(await window.api.moveFolder(drag.folderId, folder.id))
          if (!folder.expanded) lib.setFolders(await window.api.updateFolder(folder.id, { expanded: true }))
        } else {
          const siblings = childrenOf(folders, folder.parentId).filter(f => f.id !== drag.folderId)
          const idx = siblings.findIndex(f => f.id === folder.id)
          const before = where === 'before' ? folder.id : siblings[idx + 1]?.id
          lib.setFolders(await window.api.moveFolder(drag.folderId, folder.parentId, before))
        }
      } catch (err) { toast(errText(err), 'error') } // 关联文件夹只能在同一个仓库里移动
    } else if (hasFiles(e)) {
      const paths = [...e.dataTransfer.files].map(f => window.api.pathForFile(f)).filter(Boolean)
      lib.afterImport(await window.api.importPaths(paths, folder.id))
    }
    endDrag()
  }

  return (
    <>
      <div
        className={`tree-row ${active ? 'active' : ''} ${drop ? 'drop-' + drop : ''}`}
        style={{ paddingLeft: 4 + depth * 16 }}
        draggable
        onDragStart={e => startFolderDrag(e, folder.id)}
        onDragEnd={endDrag}
        onDragOver={onDragOver}
        onDragLeave={() => setDrop(null)}
        onDrop={onDrop}
        onClick={() => setView({ type: 'folder', value: folder.id })}
        onDoubleClick={toggle}
        onContextMenu={e => openMenu(e, folderMenu(lib, folder, setView))}
      >
        <span className={`twisty ${folder.expanded ? 'open' : ''}`} onClick={toggle}
          style={{ visibility: kids.length ? 'visible' : 'hidden' }}>
          <ChevronRight size={13} strokeWidth={2.2} />
        </span>
        {folder.linked && !folder.parentId
          ? <FolderSync size={16} strokeWidth={1.75} className="ico" />
          : active || (folder.expanded && kids.length)
            ? <FolderOpen size={16} strokeWidth={1.75} className="ico" />
            : <Folder size={16} strokeWidth={1.75} className="ico" />}
        <span className="label">{folder.name}</span>
        {count > 0 && <span className="count">{count}</span>}
      </div>
      {folder.expanded && kids.map(k => <FolderNode key={k.id} folder={k} depth={depth + 1} view={view} setView={setView} />)}
    </>
  )
}
