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
      queue.current.push(...data.books.filter(b => !b.metaParsed).map(b => b.id))
      runQueue()
    })
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
      const current = await window.api.getLibrary()
      const book = current.books.find(b => b.id === id)
      if (!book || book.metaParsed) continue
      try {
        const meta = await extractMeta(book)
        const patch = { metaParsed: true }
        // PDF 元数据常是“Administrator”“Crack by …”这类无效信息，此时保留文件名
        const cjk = s => /[一-龥]/.test(s)
        const titleOk = meta.title && !JUNK_META.test(meta.title) && !(cjk(book.title) && !cjk(meta.title) && book.format === 'pdf')
        if (titleOk) patch.title = meta.title
        if (meta.author && !JUNK_META.test(meta.author)) patch.author = meta.author
        let books = await window.api.updateBooks(id, patch)
        if (meta.cover) { await window.api.saveCover(id, meta.cover); books = (await window.api.getLibrary()).books }
        setLib(l => ({ ...l, books }))
      } catch (e) {
        console.warn('解析失败', book.fileName, e)
        const books = await window.api.updateBooks(id, { metaParsed: true })
        setLib(l => ({ ...l, books }))
      }
    }
    setParsing(0)
    busy.current = false
  }, [])

  const afterImport = useCallback(res => {
    if (!res) return
    setLib(l => ({ ...l, books: res.books, folders: res.folders }))
    const n = res.added.length
    if (n) toast(`已导入 ${n} 本书${res.duplicates ? `，${res.duplicates} 本已存在` : ''}`, 'success')
    else if (res.duplicates) toast(`${res.duplicates} 本书已在书库中`)
    else toast('没有找到支持的电子书文件', 'error')
    queue.current.push(...res.added.map(b => b.id))
    runQueue()
    return res
  }, [runQueue])

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
