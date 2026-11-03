// 书库操作：文件夹与图书的右键菜单、增删改
import {
  FolderPlus, Pencil, Trash2, Download, FolderInput, BookOpen, Star, StarOff, FolderMinus,
  FolderOpen, Info, CheckCircle2, Circle, BookMarked, Folder,
} from 'lucide-react'
import { childrenOf } from './model.js'
import { confirmDialog, promptDialog, toast } from '../lib/ui.jsx'

export async function newFolder(lib, parentId, onCreated) {
  const name = await promptDialog({
    title: parentId ? '新建子文件夹' : '新建文件夹',
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
}

export async function renameFolder(lib, folder) {
  const name = await promptDialog({ title: '重命名文件夹', value: folder.name, okText: '保存', icon: Pencil })
  if (name && name !== folder.name) lib.setFolders(await window.api.updateFolder(folder.id, { name }))
}

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

export function folderMenu(lib, folder, nav) {
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

export async function addToFolder(lib, ids, folder) {
  lib.setBooks(await window.api.addToFolder(ids, folder.id))
  toast(`已添加到“${folder.name}”`, 'success')
}

export async function deleteBooks(lib, ids, onDone) {
  const ok = await confirmDialog({
    title: ids.length > 1 ? `删除这 ${ids.length} 本书？` : '删除这本书？',
    message: '书库中的副本、笔记和 AI 对话都会一起删除，原始文件不受影响。',
    danger: true, okText: '删除',
  })
  if (!ok) return
  lib.setBooks(await window.api.deleteBooks(ids))
  onDone?.()
  toast('已删除')
}

export function bookMenu(lib, books, view, { onEdit, clearSel }) {
  const ids = books.map(b => b.id)
  const one = books.length === 1 ? books[0] : null
  const allFav = books.every(b => b.favorite)
  const inFolder = view.type === 'folder'
  const tree = folderTreeItems(lib.folders, f => addToFolder(lib, ids, f))
  return [
    one && { label: one.progress > 0 ? '继续阅读' : '开始阅读', icon: BookOpen, onClick: () => lib.openBook(one.id) },
    one && { sep: true },
    {
      label: '添加到文件夹', icon: FolderPlus,
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
    one && { label: '在文件夹中显示', icon: FolderOpen, onClick: () => window.api.revealBook(one.id) },
    { label: books.length > 1 ? `删除 ${books.length} 本书` : '删除', icon: Trash2, danger: true, onClick: () => deleteBooks(lib, ids, clearSel) },
  ]
}
