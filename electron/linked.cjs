// 关联文件夹（OneDrive 等同步盘）：不复制图书，只建索引；文件夹结构原样映射成书库文件夹
// 每本书标注“本地 / 云端”：云端占位文件一读就会触发下载，所以扫描只读目录和文件属性，从不打开文件
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')

const hash = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16)
const collator = new Intl.Collator('zh-CN', { numeric: true })

// Windows 文件属性：RECALL_ON_DATA_ACCESS / OFFLINE = 只在云端；PINNED = 始终保留在此设备
const ATTR_RECALL = 0x400000, ATTR_OFFLINE = 0x1000

// 用 PowerShell 列出目录树（.NET 枚举只读目录项，不会触发 OneDrive 下载）
const LIST_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$root = $env:AIR_SCAN_ROOT
$exts = $env:AIR_SCAN_EXTS -split ','
$stack = New-Object System.Collections.Stack
$stack.Push((New-Object System.IO.DirectoryInfo $root))
while ($stack.Count) {
  $d = $stack.Pop()
  try { $items = $d.EnumerateFileSystemInfos() } catch { continue }
  foreach ($i in $items) {
    $a = [int]$i.Attributes
    if ($a -band 6) { continue }   # 隐藏 / 系统
    if ($i -is [System.IO.DirectoryInfo]) {
      if ($i.Name.StartsWith('.') -or $i.Name -like '*.library' -or $i.Name -eq 'node_modules') { continue }
      $stack.Push($i)
    } elseif ($exts -contains $i.Extension.ToLower()) {
      [Console]::Out.WriteLine("$a\`t$($i.Length)\`t$($i.LastWriteTimeUtc.Ticks)\`t$($i.FullName)")
    }
  }
}
`

function listBooks(root, exts) {
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', Buffer.from(LIST_SCRIPT, 'utf16le').toString('base64')], {
      windowsHide: true,
      env: { ...process.env, AIR_SCAN_ROOT: root, AIR_SCAN_EXTS: exts.map(e => '.' + e).join(',') },
    })
    let out = '', err = ''
    ps.stdout.setEncoding('utf8')
    ps.stdout.on('data', d => { out += d })
    ps.stderr.on('data', d => { err += d })
    ps.on('error', reject)
    ps.on('close', code => {
      if (code !== 0 && !out) return reject(new Error(err.trim() || `扫描失败（${code}）`))
      const files = []
      for (const line of out.split(/\r?\n/)) {
        const [attr, size, ticks, full] = line.split('\t')
        if (!full) continue
        const a = +attr
        files.push({
          full, rel: path.relative(root, full), size: +size,
          mtime: Math.round((+ticks - 621355968000000000) / 1e4),
          cloud: !!(a & ATTR_RECALL || a & ATTR_OFFLINE),
        })
      }
      resolve(files)
    })
  })
}

// 用扫描结果更新书库：新增 / 更新 / 移除这个关联文件夹下的书和文件夹
// 文件夹和书都先按相对路径对上原记录（在书库里改名、移动过的也能对上），id 只在新建时按路径生成
// helpers：{ extOf, parseFileName, now }
function applyScan(data, root, files, { extOf, parseFileName, now }) {
  const excluded = new Set(data.linkedExcluded || [])
  const key = rel => rel.toLowerCase()
  const oldFolders = data.folders.filter(f => f.linked === root.id)
  const folderById = new Map(oldFolders.map(f => [f.id, f]))
  const folderByRel = new Map(oldFolders.filter(f => f.rel != null).map(f => [key(f.rel), f]))
  const keepFolders = new Set()
  const created = []

  const ensureFolder = relDir => {
    const old = folderByRel.get(key(relDir)) || folderById.get(folderId(root.id, relDir))
    if (old && keepFolders.has(old.id)) return old.id
    const parentId = relDir ? ensureFolder(parentRel(relDir)) : null
    const name = relDir ? path.basename(relDir) : root.name
    if (old) {
      Object.assign(old, { name, rel: relDir, parentId: relDir ? parentId : old.parentId })
      keepFolders.add(old.id)
      return old.id
    }
    const folder = { id: folderId(root.id, relDir), name, parentId, order: 0, expanded: !relDir, createdAt: now(), linked: root.id, rel: relDir }
    data.folders.push(folder)
    folderById.set(folder.id, folder)
    folderByRel.set(key(relDir), folder)
    keepFolders.add(folder.id)
    created.push(folder)
    return folder.id
  }
  ensureFolder('')

  const oldBooks = data.books.filter(b => b.linked?.root === root.id)
  const bookById = new Map(oldBooks.map(b => [b.id, b]))
  const bookByRel = new Map(oldBooks.map(b => [key(b.linked.rel), b]))
  const present = new Set(files.map(f => key(f.rel)))
  const seen = new Set()
  let added = 0
  for (const file of files) {
    const id = 'lb_' + hash(root.id + '|' + key(file.rel))
    if (excluded.has(id)) continue
    const fid = ensureFolder(parentRel(file.rel))
    let book = bookByRel.get(key(file.rel)) || bookById.get(id)
    if (!book || seen.has(book.id)) {
      // 在 OneDrive 里直接移动过的书：同名同大小、原位置已经没有了的，沿用原记录（保留进度和笔记）
      book = oldBooks.find(b => !seen.has(b.id) && b.fileName === path.basename(file.rel) && b.size === file.size
        && !present.has(key(b.linked.rel)))
    }
    if (book) {
      seen.add(book.id)
      const otherFolders = book.folders.filter(f => !folderById.has(f))
      Object.assign(book, { size: file.size, cloud: file.cloud, fileName: path.basename(file.rel), folders: [...new Set([fid, ...otherFolders])] })
      book.linked = { root: root.id, rel: file.rel }
      continue
    }
    const fileName = path.basename(file.rel)
    const { title, author } = parseFileName(fileName)
    data.books.push({
      id, format: extOf(fileName), fileName, size: file.size, title, author,
      addedAt: now(), lastReadAt: 0, progress: 0, location: null,
      cover: 0, favorite: false, status: 'unread', folders: [fid],
      metaParsed: false, linked: { root: root.id, rel: file.rel }, cloud: file.cloud,
    })
    seen.add(id)
    added++
  }

  // 还存在的空目录（比如刚在书库里新建的）也保留
  for (const f of oldFolders) {
    if (!keepFolders.has(f.id) && f.rel != null && fs.existsSync(path.join(root.path, f.rel))) ensureFolder(f.rel)
  }

  // 磁盘上已经没有的书和文件夹从书库移除（笔记按书 id 保留，文件回来时还在）
  const removedBooks = oldBooks.filter(b => !seen.has(b.id)).length
  data.books = data.books.filter(b => b.linked?.root !== root.id || seen.has(b.id))
  data.folders = data.folders.filter(f => f.linked !== root.id || keepFolders.has(f.id))
  const alive = new Set(data.folders.map(f => f.id))
  for (const b of data.books) if (b.folders.some(f => !alive.has(f))) b.folders = b.folders.filter(f => alive.has(f))

  sortLinked(data, root.id)
  const top = data.folders.find(f => f.linked === root.id && f.rel === '')
  if (created.includes(top)) top.order = data.folders.filter(f => !f.parentId && f.id !== top.id).length

  const mine = data.books.filter(b => b.linked?.root === root.id)
  Object.assign(root, { lastScan: now(), count: mine.length, cloud: mine.filter(b => b.cloud).length })
  return { added, removed: removedBooks, total: mine.length, cloud: root.cloud }
}

const folderId = (rootId, rel) => 'lf_' + hash(rootId + '|' + rel)
const parentRel = rel => { const d = path.dirname(rel); return d === '.' ? '' : d }

// 映射过来的文件夹按名称排序（01_、02_ 前缀自然排序）
function sortLinked(data, rootId) {
  const kids = new Map()
  for (const f of data.folders) if (f.linked === rootId && f.parentId) {
    if (!kids.has(f.parentId)) kids.set(f.parentId, [])
    kids.get(f.parentId).push(f)
  }
  for (const list of kids.values()) list.sort((a, b) => collator.compare(a.name, b.name)).forEach((f, i) => { f.order = i })
}

function newRoot(dir) {
  return { id: hash(dir.toLowerCase()), path: dir, name: path.basename(dir), addedAt: Date.now(), lastScan: 0, count: 0, cloud: 0 }
}

// 从书库移除关联文件夹（只删索引，不动磁盘上的文件）
function removeRoot(data, rootId) {
  data.linkedRoots = data.linkedRoots.filter(r => r.id !== rootId)
  data.books = data.books.filter(b => b.linked?.root !== rootId)
  data.folders = data.folders.filter(f => f.linked !== rootId)
  const alive = new Set(data.folders.map(f => f.id))
  for (const b of data.books) b.folders = b.folders.filter(f => alive.has(f))
}

// ---------- 在书库里管理仓库：操作会同步到磁盘（OneDrive 再同步到云端） ----------
const rootOf = (data, rootId) => data.linkedRoots.find(r => r.id === rootId)
const dirOf = (data, folder) => { const r = rootOf(data, folder.linked); return r && path.join(r.path, folder.rel || '') }
const isLinkedFolder = (data, id) => !!data.folders.find(f => f.id === id)?.linked

function uniquePath(p) {
  if (!fs.existsSync(p)) return p
  const ext = path.extname(p), base = p.slice(0, p.length - ext.length)
  for (let i = 2; ; i++) { const q = `${base} (${i})${ext}`; if (!fs.existsSync(q)) return q }
}

function moveFile(src, dest) {
  try { fs.renameSync(src, dest) } catch (e) {
    if (e.code !== 'EXDEV') throw e
    fs.copyFileSync(src, dest) // 跨磁盘只能复制再删
    fs.rmSync(src)
  }
}

// 把书移到关联文件夹：仓库里的书直接移动文件（云端占位文件移动不会触发下载）；
// 导入到书库的书把文件放进这个目录，此后由 OneDrive 保存
function moveBooks(data, ids, folder, bookPath) {
  const root = rootOf(data, folder.linked)
  const dir = dirOf(data, folder)
  if (!root || !fs.existsSync(dir)) throw new Error('找不到目标文件夹：' + dir)
  let moved = 0
  for (const id of ids) {
    const b = data.books.find(x => x.id === id)
    const src = b && bookPath(b)
    if (!src || !fs.existsSync(src) || path.dirname(src).toLowerCase() === dir.toLowerCase()) continue
    const dest = uniquePath(path.join(dir, b.fileName))
    moveFile(src, dest)
    if (!b.linked) b.cloud = false
    b.linked = { root: root.id, rel: path.relative(root.path, dest) }
    b.fileName = path.basename(dest)
    b.folders = [folder.id, ...b.folders.filter(f => !isLinkedFolder(data, f))]
    moved++
  }
  return moved
}

function createFolder(data, parent, name) {
  name = name.trim().replace(/[\\/:*?"<>|]/g, '_')
  const dir = path.join(dirOf(data, parent), name)
  if (fs.existsSync(dir)) throw new Error(`“${name}”已经存在`)
  fs.mkdirSync(dir)
  const rel = path.join(parent.rel || '', name)
  const folder = { id: folderId(parent.linked, rel), name, parentId: parent.id, order: 0, expanded: false, createdAt: Date.now(), linked: parent.linked, rel }
  data.folders.push(folder)
  sortLinked(data, parent.linked)
  return folder
}

// 改名 / 移动目录，并更新它下面所有文件夹和书的相对路径
function relocateFolder(data, folder, newParent, newName = folder.name) {
  if (!folder.rel) throw new Error('关联的根文件夹不能改名或移动')
  if (!newParent?.linked || newParent.linked !== folder.linked) throw new Error('只能在同一个关联文件夹里移动')
  newName = newName.trim().replace(/[\\/:*?"<>|]/g, '_')
  const root = rootOf(data, folder.linked)
  const oldRel = folder.rel
  const newRel = path.join(newParent.rel || '', newName)
  if (newRel === oldRel) return
  const under = (rel, base) => rel.toLowerCase().startsWith(base.toLowerCase() + path.sep)
  if (under(newRel, oldRel)) throw new Error('不能移到自己的子文件夹里')
  const src = path.join(root.path, oldRel), dest = path.join(root.path, newRel)
  if (fs.existsSync(dest) && dest.toLowerCase() !== src.toLowerCase()) throw new Error(`“${newName}”已经存在`)
  fs.renameSync(src, dest)
  const re = rel => rel.toLowerCase() === oldRel.toLowerCase() ? newRel : under(rel, oldRel) ? newRel + rel.slice(oldRel.length) : rel
  for (const f of data.folders) if (f.linked === folder.linked && f.rel != null) f.rel = re(f.rel)
  for (const b of data.books) if (b.linked?.root === folder.linked) b.linked.rel = re(b.linked.rel)
  Object.assign(folder, { name: newName, parentId: newParent.id })
  sortLinked(data, folder.linked)
}

// OneDrive“释放空间 / 始终保留在此设备”：attrib -P +U / +P -U，OneDrive 随后删掉或下载本地副本
function setPinned(targets, keepLocal) {
  const flags = keepLocal ? ['+P', '-U'] : ['-P', '+U']
  return Promise.all(targets.map(({ file, dir }) => new Promise((resolve, reject) => {
    const args = dir ? [...flags, path.join(dir, '*'), '/S', '/D'] : [...flags, file]
    const p = spawn('attrib.exe', args, { windowsHide: true })
    let err = ''
    p.stdout.on('data', d => { err += d })
    p.on('error', reject)
    p.on('close', code => code === 0 ? resolve() : reject(new Error(err.trim() || `attrib 失败（${code}）`)))
  })))
}

module.exports = { listBooks, applyScan, newRoot, removeRoot, moveBooks, createFolder, relocateFolder, setPinned, rootOf, dirOf }
