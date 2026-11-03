// 书库的纯数据计算：文件夹树、筛选、排序

export const FORMAT_LABEL = { epub: 'EPUB', pdf: 'PDF', txt: 'TXT', mobi: 'MOBI', azw3: 'AZW3', azw: 'AZW', fb2: 'FB2', fbz: 'FB2', cbz: 'CBZ' }

export function childrenOf(folders, parentId) {
  return folders.filter(f => (f.parentId || null) === (parentId || null)).sort((a, b) => a.order - b.order || a.createdAt - b.createdAt)
}

export function descendants(folders, id) {
  const out = [id]
  for (const f of folders) if (f.parentId === id) out.push(...descendants(folders, f.id))
  return out
}

export function folderPath(folders, id) {
  const path = []
  let f = folders.find(x => x.id === id)
  while (f) { path.unshift(f); f = folders.find(x => x.id === f.parentId) }
  return path
}

// 当前视图：{ type: 'all' | 'recent' | 'favorite' | 'unfiled' | 'format' | 'folder' | 'status' | 'storage', value }
// storage：local = 不用联网就能读（导入的 + 已下载的），cloud = 只在 OneDrive 云端
export function filterBooks(books, folders, view, { query, showSub }) {
  let list = books
  switch (view.type) {
    case 'recent': list = books.filter(b => b.lastReadAt > 0); break
    case 'favorite': list = books.filter(b => b.favorite); break
    case 'unfiled': list = books.filter(b => !b.folders.length); break
    case 'format': list = books.filter(b => (FORMAT_LABEL[b.format] || b.format) === view.value); break
    case 'status': list = books.filter(b => b.status === view.value); break
    case 'storage': list = books.filter(b => view.value === 'cloud' ? b.cloud : !b.cloud); break
    case 'folder': {
      const ids = showSub ? descendants(folders, view.value) : [view.value]
      list = books.filter(b => b.folders.some(f => ids.includes(f)))
      break
    }
  }
  const q = query.trim().toLowerCase()
  if (q) list = list.filter(b => (b.title + ' ' + b.author + ' ' + b.fileName).toLowerCase().includes(q))
  return list
}

const collator = new Intl.Collator('zh-CN', { numeric: true })
export function sortBooks(list, sort, view) {
  const arr = [...list]
  const key = view.type === 'recent' ? 'lastRead' : sort
  switch (key) {
    case 'added': return arr.sort((a, b) => b.addedAt - a.addedAt)
    case 'title': return arr.sort((a, b) => collator.compare(a.title, b.title))
    case 'author': return arr.sort((a, b) => collator.compare(a.author || '￿', b.author || '￿'))
    case 'progress': return arr.sort((a, b) => b.progress - a.progress)
    default: return arr.sort((a, b) => (b.lastReadAt || b.addedAt / 1e3) - (a.lastReadAt || a.addedAt / 1e3))
  }
}

// 每个文件夹里的书数：书库 / 文件夹变了才重新统计一遍（关联 OneDrive 后有几千本书、几百个文件夹）
let counts = { books: null, folders: null, showSub: null, map: null }
export function countIn(books, folders, folderId, showSub) {
  if (counts.books !== books || counts.folders !== folders || counts.showSub !== showSub) {
    const parent = new Map(folders.map(f => [f.id, f.parentId || null]))
    const map = new Map()
    for (const b of books) {
      const hit = new Set()
      for (let f of b.folders) {
        if (!showSub) { hit.add(f); continue }
        while (f && !hit.has(f)) { hit.add(f); f = parent.get(f) }
      }
      for (const f of hit) map.set(f, (map.get(f) || 0) + 1)
    }
    counts = { books, folders, showSub, map }
  }
  return counts.map.get(folderId) || 0
}

export function formatDate(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  const now = new Date()
  const days = Math.floor((now - d) / 864e5)
  if (d.toDateString() === now.toDateString()) return `今天 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (days < 7) return `${Math.max(1, days)} 天前`
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

export const pct = p => `${Math.round((p || 0) * 100)}%`
