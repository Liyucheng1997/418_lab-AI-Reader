// 书库操作：文件夹与图书的右键菜单、增删改
import {
  FolderPlus, Pencil, Trash2, Download, FolderInput, BookOpen, Star, StarOff, FolderMinus,
  FolderOpen, Info, CheckCircle2, Circle, BookMarked, Folder, FolderSync, RefreshCw, Unlink,
  CloudDownload, CloudOff, ImageDown,
} from 'lucide-react'
import { childrenOf } from './model.js'
import { confirmDialog, promptDialog, toast } from '../lib/ui.jsx'

export const errText = e => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
// 关联文件夹的操作会改动磁盘上的文件（重名、权限、OneDrive 占用都可能失败），失败就提示原因
export const guard = fn => async (...args) => { try { return await fn(...args) } catch (e) { toast(errText(e), 'error') } }

export const newFolder = guard(async (lib, parentId, onCreated) => {
  const parent = lib.folders.find(f => f.id === parentId)
  const name = await promptDialog({
    title: parentId ? '新建子文件夹' : '新建文件夹',
    message: parent?.linked ? '会在 OneDrive 里建一个同名目录。' : undefined,
    placeholder: '文件夹名称', value: '', okText: '创建', icon: FolderPlus,
  })
  if (!name) return
  const { folder, folders } = await window.api.createFolder(name, parentId)
  lib.setFolders(folders)
  if (parentId) {
    const p = folders.find(f => f.id === parentId)
    if (p && !p.expanded) lib.setFolders(await window.api.updateFolder(parentId, { expanded: true }))
  }
  onCreated?.(folder)
})

export const renameFolder = guard(async (lib, folder) => {
  const name = await promptDialog({
    title: '重命名文件夹', value: folder.name, okText: '保存', icon: Pencil,
    message: folder.linked ? 'OneDrive 里的目录也会一起改名。' : undefined,
  })
  if (name && name !== folder.name) lib.setFolders(await window.api.updateFolder(folder.id, { name }))
})

// 关联文件夹里的书：下载到本地（始终保留）/ 只保留在云端（释放本地空间）
export const keepLocal = guard(async (lib, ids, keep) => {
  lib.setBooks(await window.api.keepLocal(ids, keep))
  toast(keep ? 'OneDrive 正在下载到本地' : '已释放本地空间，书仍在云端', 'success')
})
export const folderLocal = guard(async (lib, folder, keep) => {
  lib.setBooks(await window.api.folderLocal(folder.id, keep))
  toast(keep ? `OneDrive 正在下载“${folder.name}”里的书` : `已释放“${folder.name}”的本地空间，书仍在云端`, 'success')
})
export const findCover = guard(async (lib, book) => {
  toast('正在联网查找封面…')
  const b = await window.api.findCover(book.id)
  if (!b) return
  lib.setBooks(lib.books.map(x => x.id === b.id ? b : x))
  toast(b.cover && b.cover !== book.cover ? '已找到封面' : '没有找到这本书的封面', b.cover !== book.cover ? 'success' : 'info')
})

export async function deleteFolder(lib, folder, onDeleted) {
  const ok = await confirmDialog({
    title: `删除“${folder.name}”？`,
    message: '文件夹及其子文件夹会被删除。\n其中的图书仍保留在书库里。',
    danger: true, okText: '删除',
  })
  if (!ok) return
  const res = await window.api.deleteFolder(folder.id)
  lib.setFolders(res.folders)
  lib.setBooks(res.books)
  onDeleted?.()
}

// 关联文件夹（OneDrive 等）：只建索引，书留在原处；本地 / 云端分别标注
export async function linkFolder(lib) {
  const res = await window.api.linkedAdd()
  if (!res) return
  lib.setBooks(res.books)
  lib.setFolders(res.folders)
  const r = res.result
  toast(`已关联：${r.total} 本书，其中 ${r.cloud} 本仅在云端`, 'success')
  return res
}

export async function rescanLinked(lib, rootId) {
  try {
    const res = await window.api.linkedRescan(rootId)
    lib.setBooks(res.books)
    lib.setFolders(res.folders)
    const added = res.results.reduce((n, r) => n + r.added, 0), removed = res.results.reduce((n, r) => n + r.removed, 0)
    toast(added || removed ? `已更新：新增 ${added} 本，移除 ${removed} 本` : '已是最新', 'success')
    return res
  } catch (e) {
    toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error')
  }
}

export async function unlinkFolder(lib, rootId, name) {
  const ok = await confirmDialog({
    title: `取消关联“${name}”？`,
    message: '书库里会移除这个文件夹的索引（含阅读进度）。\nOneDrive 里的文件不受影响，以后可以重新关联。',
    danger: true, okText: '取消关联',
  })
  if (!ok) return false
  const res = await window.api.linkedRemove(rootId)
  lib.setBooks(res.books)
  lib.setFolders(res.folders)
  return true
}

export function folderMenu(lib, folder, nav) {
  // 关联文件夹 = OneDrive 里的目录：新建、改名、拖动都会同步改动磁盘；删除目录请在 OneDrive 里做
  if (folder.linked) return [
    { label: '打开', icon: FolderOpen, onClick: () => nav({ type: 'folder', value: folder.id }) },
    { sep: true },
    { label: '新建子文件夹', icon: FolderPlus, onClick: () => newFolder(lib, folder.id) },
    folder.parentId && { label: '重命名', icon: Pencil, onClick: () => renameFolder(lib, folder) },
    { sep: true },
    { label: '全部下载到本地', icon: CloudDownload, onClick: () => folderLocal(lib, folder, true) },
    { label: '释放本地空间（只留在云端）', icon: CloudOff, onClick: () => folderLocal(lib, folder, false) },
    { label: '重新扫描', icon: RefreshCw, onClick: () => rescanLinked(lib, folder.linked) },
    !folder.parentId && { sep: true },
    !folder.parentId && { label: '取消关联…', icon: Unlink, danger: true, onClick: async () => { if (await unlinkFolder(lib, folder.linked, folder.name)) nav({ type: 'all' }) } },
  ].filter(Boolean)
  return [
    { label: '打开', icon: FolderOpen, onClick: () => nav({ type: 'folder', value: folder.id }) },
    { sep: true },
    { label: '新建子文件夹', icon: FolderPlus, onClick: () => newFolder(lib, folder.id) },
    { label: '导入图书到这里', icon: Download, onClick: async () => lib.afterImport(await window.api.importDialog(folder.id, 'files')) },
    { label: '导入文件夹到这里', icon: FolderInput, onClick: async () => lib.afterImport(await window.api.importDialog(folder.id, 'directory')) },
    { sep: true },
    { label: '重命名', icon: Pencil, onClick: () => renameFolder(lib, folder) },
    { label: '移到顶层', icon: Folder, disabled: !folder.parentId, onClick: async () => lib.setFolders(await window.api.moveFolder(folder.id, null)) },
    { label: '删除文件夹', icon: Trash2, danger: true, onClick: () => deleteFolder(lib, folder, () => nav({ type: 'all' })) },
  ]
}

// “添加到文件夹”多级子菜单
export function folderTreeItems(folders, onPick, parentId = null, exclude) {
  return childrenOf(folders, parentId).map(f => {
    const kids = folderTreeItems(folders, onPick, f.id, exclude)
    return {
      label: f.name,
      icon: Folder,
      disabled: exclude?.(f),
      onClick: () => onPick(f),
      children: kids.length ? [{ label: f.name, icon: FolderOpen, disabled: exclude?.(f), onClick: () => onPick(f) }, { sep: true }, ...kids] : null,
    }
  })
}

// 普通文件夹：归类（一本书可以在多个文件夹里）；关联文件夹：把文件移到 OneDrive 的那个目录
export const addToFolder = guard(async (lib, ids, folder) => {
  const imported = ids.filter(id => !lib.books.find(b => b.id === id)?.linked).length
  if (folder.linked && imported) {
    const ok = await confirmDialog({
      title: `把 ${imported} 本导入的书放进 OneDrive？`,
      message: `文件会从 AI Reader 的数据目录移到“${folder.name}”，此后由 OneDrive 保存和同步。`,
      okText: '移过去',
    })
    if (!ok) return
  }
  lib.setBooks(await window.api.addToFolder(ids, folder.id))
  toast(folder.linked ? `已移动到“${folder.name}”` : `已添加到“${folder.name}”`, 'success')
})

export const deleteBooks = guard(async (lib, ids, onDone) => {
  const books = ids.map(id => lib.books.find(b => b.id === id)).filter(Boolean)
  const linked = books.filter(b => b.linked)
  const own = books.length - linked.length
  if (linked.length && !own && linked.every(b => b.cloud)) return toast('这些书已经只在云端了')
  const ok = await confirmDialog({
    title: books.length > 1 ? `删除这 ${books.length} 本书？` : '删除这本书？',
    message: [
      linked.length && `OneDrive 里的书只删除本地副本，书仍保存在云端、也留在书库里，随时可以再下载。`,
      own && '导入的书连同书库中的副本、笔记和 AI 对话一起删除，原始文件不受影响。',
    ].filter(Boolean).join('\n'),
    danger: true, okText: linked.length && !own ? '删除本地副本' : '删除',
  })
  if (!ok) return
  lib.setBooks(await window.api.deleteBooks(ids))
  onDone?.()
  toast(own ? '已删除' : '已删除本地副本，书仍在云端')
})

export function bookMenu(lib, books, view, { onEdit, clearSel }) {
  const ids = books.map(b => b.id)
  const one = books.length === 1 ? books[0] : null
  const allFav = books.every(b => b.favorite)
  const inFolder = view.type === 'folder' && !lib.folders.find(f => f.id === view.value)?.linked
  const tree = folderTreeItems(lib.folders, f => addToFolder(lib, ids, f))
  const linked = books.filter(b => b.linked)
  return [
    one && { label: one.progress > 0 ? '继续阅读' : '开始阅读', icon: BookOpen, onClick: () => lib.openBook(one.id) },
    one && { sep: true },
    {
      label: '添加 / 移动到文件夹', icon: FolderPlus,
      children: [
        ...tree,
        tree.length ? { sep: true } : null,
        { label: '新建文件夹…', icon: FolderPlus, onClick: () => newFolder(lib, null, f => addToFolder(lib, ids, f)) },
      ].filter(Boolean),
    },
    inFolder && {
      label: '从当前文件夹移除', icon: FolderMinus,
      onClick: async () => { lib.setBooks(await window.api.removeFromFolder(ids, view.value)); clearSel?.() },
    },
    { label: allFav ? '取消收藏' : '收藏', icon: allFav ? StarOff : Star, onClick: () => lib.updateBooks(ids, { favorite: !allFav }) },
    {
      label: '标记为', icon: BookMarked,
      children: [
        { label: '未读', icon: Circle, onClick: () => lib.updateBooks(ids, { status: 'unread', progress: 0, location: null }) },
        { label: '在读', icon: BookOpen, onClick: () => lib.updateBooks(ids, { status: 'reading' }) },
        { label: '已读完', icon: CheckCircle2, onClick: () => lib.updateBooks(ids, { status: 'finished', progress: 1 }) },
      ],
    },
    { sep: true },
    one && { label: '编辑信息', icon: Info, onClick: () => onEdit(one) },
    one && { label: '联网查找封面', icon: ImageDown, onClick: () => findCover(lib, one) },
    one && { label: '在文件夹中显示', icon: FolderOpen, onClick: () => window.api.revealBook(one.id) },
    linked.some(b => b.cloud) && { label: '下载到本地', icon: CloudDownload, onClick: () => keepLocal(lib, linked.map(b => b.id), true) },
    { sep: true },
    {
      label: linked.length === books.length ? '删除本地副本（只留在云端）' : books.length > 1 ? `删除 ${books.length} 本书` : '删除',
      icon: linked.length === books.length ? CloudOff : Trash2, danger: true,
      disabled: linked.length === books.length && linked.every(b => b.cloud),
      onClick: () => deleteBooks(lib, ids, clearSel),
    },
  ]
}
