import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { UIHost, toast } from './lib/ui.jsx'
import { extractMeta } from './lib/foliate.js'
import Library from './library/Library.jsx'
import Reader from './reader/Reader.jsx'
import SettingsDialog from './settings/SettingsDialog.jsx'
import { UpdateBanner } from './settings/update.jsx'

const JUNK_META = /^(administrator|admin|user|unknown|anonymous|untitled|microsoft|作者|无标题|未知)\b|crack|^document\d*$|\.(docx?|pdf|indd|tex)$/i

const LibCtx = createContext(null)
export const useLib = () => useContext(LibCtx)

export default function App() {
  const [lib, setLib] = useState(null)
  const [readingId, setReadingId] = useState(null)
  const [settingsTab, setSettingsTab] = useState(null)
  const [parsing, setParsing] = useState(0)
  const queue = useRef([])
  const busy = useRef(false)

  useEffect(() => {
    window.api.getLibrary().then(data => {
      setLib({ books: data.books, folders: data.folders, settings: data.settings })
    })
    // 关联文件夹在后台重新扫描后，书库跟着更新
    window.api.onLibChanged(snap => setLib(l => ({ ...l, books: snap.books, folders: snap.folders })))
    // 后台联网找到封面后，单本更新
    window.api.onBookUpdated(book => setLib(l => ({ ...l, books: l.books.map(b => b.id === book.id ? book : b) })))
  }, [])

  // ---------- 主题 ----------
  const theme = lib?.settings.theme
  useEffect(() => {
    if (!theme) return
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && mq.matches)
      document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [theme])

  // ---------- 后台解析书名/作者/封面 ----------
  const runQueue = useCallback(async () => {
    if (busy.current) return
    busy.current = true
    while (queue.current.length) {
      setParsing(queue.current.length)
      const id = queue.current.shift()
      const book = await window.api.getBook(id)
      if (!book || book.metaParsed || book.cloud) continue // 云端的书一读就会触发下载，等打开过再解析
      try {
        // 个别损坏的大 PDF 可能一直解析不完，别让一本书卡住后面所有的书
        const meta = await Promise.race([
          extractMeta(book),
          new Promise((_, reject) => setTimeout(() => reject(new Error('解析超时')), 90000)),
        ])
        const patch = { metaParsed: true }
        // PDF 元数据常是“Administrator”“Crack by …”这类无效信息，此时保留文件名
        const cjk = s => /[一-龥]/.test(s)
        const titleOk = meta.title && !JUNK_META.test(meta.title) && !(cjk(book.title) && !cjk(meta.title) && book.format === 'pdf')
        if (titleOk) patch.title = meta.title
        if (meta.author && !JUNK_META.test(meta.author)) patch.author = meta.author
        let updated = await window.api.patchBook(id, patch)
        if (meta.cover) updated = await window.api.saveCover(id, meta.cover)
        setLib(l => ({ ...l, books: l.books.map(b => b.id === id ? updated : b) }))
      } catch (e) {
        console.warn('解析失败', book.fileName, e)
        // 超时可能只是一时卡住，下次启动再试一次；两次都不行或文件本身解析失败就算了
        const tries = (book.metaTries || 0) + 1
        const done = e.message !== '解析超时' || tries >= 2
        const updated = await window.api.patchBook(id, done ? { metaParsed: true } : { metaTries: tries })
        setLib(l => ({ ...l, books: l.books.map(b => b.id === id ? updated : b) }))
      }
    }
    setParsing(0)
    busy.current = false
  }, [])

  // 书库里凡是在本地、还没解析过的书都排进队列：不管是导入、关联文件夹、重新扫描、
  // 从云端下载还是打开过一次，都不用各处单独通知
  const queued = useRef(new Set())
  const books = lib?.books
  useEffect(() => {
    if (!books) return
    const ids = books.filter(b => !b.metaParsed && !b.cloud && !queued.current.has(b.id)).map(b => b.id)
    if (!ids.length) return
    for (const id of ids) queued.current.add(id)
    queue.current.push(...ids)
    runQueue()
  }, [books, runQueue])

  const afterImport = useCallback(res => {
    if (!res) return
    setLib(l => ({ ...l, books: res.books, folders: res.folders }))
    const n = res.added.length
    if (n) toast(`已导入 ${n} 本书${res.duplicates ? `，${res.duplicates} 本已存在` : ''}`, 'success')
    else if (res.duplicates) toast(`${res.duplicates} 本书已在书库中`)
    else toast('没有找到支持的电子书文件', 'error')
    return res
  }, [])

  // 双击文件 / 命令行打开
  useEffect(() => {
    const open = async files => {
      const res = afterImport(await window.api.importPaths(files, null))
      const id = res?.added[0]?.id ?? res?.books.find(b => files.some(f => f.endsWith(b.fileName)))?.id
      if (id) setReadingId(id)
    }
    window.api.pendingFiles().then(f => f.length && open(f))
    window.api.onOpenFiles(open)
  }, [afterImport])

  const api = useMemo(() => ({
    ...lib,
    setBooks: books => setLib(l => ({ ...l, books })),
    setFolders: folders => setLib(l => ({ ...l, folders })),
    async updateSettings(patch) {
      const settings = await window.api.setSettings(patch)
      setLib(l => ({ ...l, settings }))
      return settings
    },
    async updateBooks(ids, patch) {
      const books = await window.api.updateBooks(ids, patch)
      setLib(l => ({ ...l, books }))
    },
    afterImport,
    parsing,
    openBook: id => setReadingId(id),
    openSettings: (tab = 'general') => setSettingsTab(tab),
  }), [lib, afterImport, parsing])

  if (!lib) return null
  const reading = readingId && lib.books.find(b => b.id === readingId)
  return (
    <LibCtx.Provider value={api}>
      <div className="app">
        {reading
          ? <Reader key={reading.id} book={reading} onClose={() => setReadingId(null)} />
          : <Library />}
      </div>
      {settingsTab && <SettingsDialog tab={settingsTab} onClose={() => setSettingsTab(null)} />}
      <UpdateBanner />
      <UIHost />
    </LibCtx.Provider>
  )
}
