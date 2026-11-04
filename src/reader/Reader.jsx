import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft, List, Search, Bookmark, BookmarkCheck, NotebookPen, Type, Sparkles, Volume2, Square,
  Maximize, Minimize, ChevronLeft, ChevronRight,
} from 'lucide-react'
import { useLib } from '../App.jsx'
import { loadFoliate, openBookRecord } from '../lib/foliate.js'
import { toast } from '../lib/ui.jsx'
import { bookCSS, resolveTheme, colorOf, isAppDark } from './theme.js'
import { Narrator, sentencesFromRange, splitSentences, itemsFrom } from './tts.js'
import { applyOcrLayer, hasPdfText, usableText, ocrPageText } from './ocrLayer.js'
import SidePanel from './SidePanel.jsx'
import SearchPanel from './SearchPanel.jsx'
import AIPanel from './AIPanel.jsx'
import TypeSettings from './TypeSettings.jsx'
import SelectionPopup from './SelectionPopup.jsx'

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36)

export default function Reader({ book: record, onClose }) {
  const lib = useLib()
  const rs = lib.settings.reader
  const stageRef = useRef()
  const viewRef = useRef()
  const bookRef = useRef()
  const modsRef = useRef()
  const [ready, setReady] = useState(false)
  const [error, setError] = useState(null)
  const [loc, setLoc] = useState(null)
  const [toc, setToc] = useState([])
  const [left, setLeft] = useState(null) // toc | bookmarks | notes
  const [right, setRight] = useState(null) // ai | search
  const [typeOpen, setTypeOpen] = useState(false)
  const [popup, setPopup] = useState(null)
  const [anns, setAnns] = useState([])
  const [aiRequest, setAiRequest] = useState(null)
  const [speaking, setSpeaking] = useState(false)
  const [full, setFull] = useState(false)
  const [scrub, setScrub] = useState(null)
  const annsRef = useRef([])
  const rsRef = useRef(rs)
  const locRef = useRef(null)
  const annClickAt = useRef(0)
  const narrator = useRef(null)
  const isFixed = ['pdf', 'cbz'].includes(record.format)
  rsRef.current = rs
  const ttsRef = useRef(lib.settings.tts)
  ttsRef.current = lib.settings.tts
  useEffect(() => { narrator.current?.setRate(lib.settings.tts.rate) }, [lib.settings.tts.rate])

  // ---------- OCR：扫描版、文字乱码的 PDF 在后台自动识别 ----------
  // 打开书就开始，不用操作：先识别正在看的页，再从这里往后，最后整本书；
  // 识别好的页铺一层透明文字，可以像普通 PDF 一样选中、复制、高亮、做笔记、朗读、搜索
  const isPdf = record.format === 'pdf'
  const ocrRef = useRef({ pages: {} })
  const [ocr, setOcr] = useState(null) // { total, done, queued, running }
  const ocrBusy = !!ocr && (ocr.queued > 0 || ocr.running != null)
  const ocrPages = async (indices, front) => {
    if (indices.length) setOcr(await window.api.ocrStart(record.id, indices, bookRef.current?.pdf?.numPages, front))
  }
  // 正在看的页没有可用文字、也还没识别：插到最前面
  const ocrVisible = () => {
    const cs = viewRef.current?.renderer.getContents?.() || []
    ocrPages(cs.filter(c => c.doc && !hasPdfText(c.doc) && !ocrRef.current.pages[c.index]).map(c => c.index), true)
  }
  // 找出全书没有可用文字的页（扫描页、乱码页），从当前页往后陆续排进后台
  const ocrWholeBook = async () => {
    const pdf = bookRef.current?.pdf
    if (!pdf) return
    const n = pdf.numPages, cur = locRef.current?.index || 0
    let batch = []
    for (let k = 0; k < n; k++) {
      const i = (cur + k) % n
      if (ocrRef.current.pages[i]) continue
      try {
        const tc = await (await pdf.getPage(i + 1)).getTextContent()
        if (!usableText(tc.items.map(x => x.str).join(''))) batch.push(i)
      } catch { continue }
      if (batch.length >= 10) { ocrPages(batch, false); batch = [] } // 边查边排，第一批马上开始
    }
    ocrPages(batch, false)
  }
  useEffect(() => {
    if (!isPdf || !ready) return
    let alive = true
    window.api.ocrGet(record.id).then(({ pages, ...st }) => {
      if (!alive) return
      ocrRef.current.pages = pages || {}
      setOcr(st)
      redrawPdfHighlights()
      setTimeout(() => { if (alive) { ocrVisible(); ocrWholeBook() } }, 800) // pdf.js 的文字层是异步画的
    })
    const off = window.api.onOcrProgress(({ bookId, index, page, error, stopped, ...st }) => {
      if (bookId !== record.id) return
      if (page) {
        ocrRef.current.pages[index] = page
        for (const c of viewRef.current?.renderer.getContents?.() || []) if (c.index === index && c.doc) drawPdfHighlights(c.doc, c.index)
      }
      if (error) console.warn(`第 ${index + 1} 页识别失败`, error)
      setOcr(st)
    })
    return () => { alive = false; off() }
  }, [ready])
  // 朗读扫描页时等它识别完；顺便把后面两页排上
  const waitOcr = indices => new Promise(resolve => {
    const need = indices.filter(i => !ocrRef.current.pages[i])
    if (!need.length) return resolve()
    const timer = setTimeout(() => { off(); resolve() }, 120000)
    const off = window.api.onOcrProgress(() => {
      if (need.every(i => ocrRef.current.pages[i])) { clearTimeout(timer); off(); resolve() }
    })
    ocrPages(need, true)
  })

  // ---------- 标注持久化 ----------
  const saveAnns = useCallback(list => {
    annsRef.current = list
    setAnns(list)
    window.api.setAnnotations(record.id, list)
  }, [record.id])

  // ---------- 打开图书 ----------
  useEffect(() => {
    let view, book, disposed = false
    ;(async () => {
      const mods = await loadFoliate()
      modsRef.current = mods
      const list = await window.api.getAnnotations(record.id)
      annsRef.current = list
      setAnns(list)
      if (record.cloud) toast(`正在从 OneDrive 下载《${record.title}》（${(record.size / 1048576).toFixed(1)} MB）…`)
      book = await openBookRecord(record)
      if (record.cloud) window.api.patchBook(record.id, { cloud: false }) // 读过一次就已下载到本地
      if (disposed) return book.destroy?.()
      bookRef.current = book
      if (book.rendition?.layout === 'pre-paginated') book.rendition.spread = rsRef.current.columns === 2 ? 'auto' : 'none'
      view = document.createElement('foliate-view')
      viewRef.current = view
      window.__airView = view // 便于在开发者工具里调试
      stageRef.current.append(view)
      view.addEventListener('relocate', onRelocate)
      view.addEventListener('load', onLoad)
      view.addEventListener('create-overlay', e => {
        for (const a of annsRef.current) if (a.type === 'highlight' && a.index === e.detail.index) view.addAnnotation({ value: a.cfi })
      })
      view.addEventListener('draw-annotation', e => {
        const a = annsRef.current.find(x => x.cfi === e.detail.annotation.value)
        if (!a) return
        const { Overlayer } = modsRef.current
        e.detail.draw(a.style === 'underline' ? Overlayer.underline : Overlayer.highlight, { color: colorOf(a.color), width: 2 })
      })
      view.addEventListener('show-annotation', e => {
        annClickAt.current = Date.now()
        const a = annsRef.current.find(x => x.cfi === e.detail.value)
        if (a) showPopupFor({ kind: 'annotation', ann: a, range: e.detail.range })
      })
      await view.open(book)
      setToc(book.toc || [])
      applyLayout()
      await view.init({ lastLocation: record.location || null, showTextStart: !record.location })
      if (!disposed) setReady(true)
    })().catch(e => { console.error(e); setError(e.message || String(e)) })
    return () => {
      disposed = true
      narrator.current?.stop()
      flushProgress()
      view?.close?.()
      view?.remove()
      book?.destroy?.()
      window.api.getLibrary().then(d => lib.setBooks(d.books))
    }
  }, [])

  // ---------- 排版 ----------
  const appDark = isAppDark(lib.settings.theme)
  const darkRef = useRef(appDark)
  darkRef.current = appDark
  const theme = resolveTheme(rs.bg, appDark)
  const applyLayout = useCallback(() => {
    const view = viewRef.current
    if (!view?.renderer) return
    const r = rsRef.current
    const th = resolveTheme(r.bg, darkRef.current)
    if (view.isFixedLayout) {
      view.renderer.setAttribute('zoom', r.pdfZoom)
      for (const c of view.renderer.getContents?.() || []) if (c.doc) tintPdfPage(c.doc)
    } else {
      view.renderer.setStyles?.(bookCSS(r, th))
      view.renderer.setAttribute('flow', r.flow)
      view.renderer.setAttribute('gap', '6%')
      view.renderer.setAttribute('margin', `${r.margin}px`)
      view.renderer.setAttribute('max-inline-size', `${r.maxWidth}px`)
      view.renderer.setAttribute('max-column-count', String(r.columns))
    }
  }, [])
  useEffect(() => { applyLayout() }, [rs, applyLayout, appDark])

  // PDF 页面是画在白纸上的图片：在页面里用“正片叠底”把白纸染成所选的背景色，文字不变
  // （夜间模式另外整体反色，这里不染）
  function tintPdfPage(doc) {
    const th = resolveTheme(rsRef.current.bg, darkRef.current)
    let st = doc.getElementById('air-paper')
    if (!st) {
      st = doc.createElement('style')
      st.id = 'air-paper'
      ;(doc.head || doc.documentElement).append(st)
    }
    st.textContent = th.dark || th.bg.toLowerCase() === '#ffffff' ? ''
      : `html, body { background: ${th.bg} !important; } canvas { mix-blend-mode: multiply; }`
  }

  // ---------- 位置与进度 ----------
  const progressTimer = useRef()
  const flushProgress = () => {
    clearTimeout(progressTimer.current)
    const l = locRef.current
    if (!l) return
    window.api.updateBooks(record.id, {
      location: l.cfi, progress: l.fraction, lastReadAt: Date.now(),
      status: l.fraction >= 0.995 ? 'finished' : 'reading',
    })
  }
  const onRelocate = e => {
    const d = e.detail
    const l = {
      fraction: d.fraction ?? 0, cfi: d.cfi, range: d.range,
      index: d.section?.current ?? viewRef.current?.renderer?.index ?? 0,
      sectionTotal: d.section?.total, location: d.location, tocItem: d.tocItem, pageItem: d.pageItem,
    }
    locRef.current = l
    setLoc(l)
    clearTimeout(progressTimer.current)
    progressTimer.current = setTimeout(flushProgress, 800)
    if (viewRef.current?.isFixedLayout) setTimeout(redrawPdfHighlights, 60)
    if (isPdf) setTimeout(ocrVisible, 800) // 翻到还没识别的扫描页：优先识别（文字层是异步画的，稍等再判断）
  }

  // ---------- 书页内事件 ----------
  const onLoad = e => {
    const { doc, index } = e.detail
    doc.addEventListener('keydown', onKey)
    doc.addEventListener('wheel', onWheel, { passive: false })
    doc.addEventListener('pointerup', () => setTimeout(() => checkSelection(doc, index), 20))
    doc.addEventListener('click', ev => onDocClick(ev, doc))
    doc.addEventListener('dblclick', ev => onDocDblClick(ev, doc))
    doc.addEventListener('contextmenu', ev => { if (!doc.getSelection()?.isCollapsed) ev.preventDefault() })
    if (viewRef.current?.isFixedLayout) {
      tintPdfPage(doc)
      setTimeout(() => drawPdfHighlights(doc, index), 80)
    }
  }

  const frameRect = (doc, rect) => {
    const frame = doc.defaultView?.frameElement
    if (!frame) return rect
    const fr = frame.getBoundingClientRect()
    const sx = fr.width / (frame.offsetWidth || fr.width) || 1
    const sy = fr.height / (frame.offsetHeight || fr.height) || 1
    return { left: fr.left + rect.left * sx, right: fr.left + rect.right * sx, top: fr.top + rect.top * sy, bottom: fr.top + rect.bottom * sy }
  }

  const showPopupFor = ({ kind, ann, range, text, cfi, index }) => {
    const doc = range?.startContainer?.ownerDocument
    let rect = null
    if (range && doc) {
      const rects = [...range.getClientRects()].filter(r => r.width > 0)
      const first = rects[0] || range.getBoundingClientRect()
      const last = rects.at(-1) || first
      const a = frameRect(doc, first), b = frameRect(doc, last)
      rect = { left: Math.min(a.left, b.left), right: Math.max(a.right, b.right), top: a.top, bottom: b.bottom }
    }
    setPopup({ kind, ann, text: text ?? ann?.text, cfi: cfi ?? ann?.cfi, index: index ?? ann?.index, rect, range })
  }

  const checkSelection = (doc, index) => {
    const sel = doc.getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount) return
    const range = sel.getRangeAt(0)
    const text = sel.toString().trim()
    if (!text) return
    let cfi = null
    try { cfi = viewRef.current.getCFI(index, range) } catch {}
    showPopupFor({ kind: 'select', range, text, cfi, index })
  }

  // 鼠标下面确实是文字时，返回对应的文本位置（点在页边空白处返回 null）
  const textPointAt = (doc, x, y) => {
    const caret = doc.caretRangeFromPoint?.(x, y)
    const node = caret?.startContainer
    if (!node || node.nodeType !== 3) return null
    const offset = caret.startOffset
    const r = doc.createRange()
    for (const [a, b] of [[offset, offset + 1], [offset - 1, offset]]) {
      if (a < 0 || b > node.length) continue
      r.setStart(node, a)
      r.setEnd(node, b)
      const box = r.getBoundingClientRect()
      if (x >= box.left - 4 && x <= box.right + 4 && y >= box.top - 4 && y <= box.bottom + 4) return { node, offset }
    }
    return null
  }

  // 朗读中双击文字：从这一句开始读（不选中词、不弹工具条）
  const onDocDblClick = (ev, doc) => {
    if (!narrator.current?.playing) return
    const at = textPointAt(doc, ev.clientX, ev.clientY)
    if (!at) return
    doc.getSelection()?.removeAllRanges()
    readFrom(at.node, at.offset)
  }

  const onDocClick = (ev, doc) => {
    if (!doc.getSelection()?.isCollapsed) return
    if (ev.target.closest?.('a[href]')) return
    setTimeout(() => {
      if (Date.now() - annClickAt.current < 400) return
      setPopup(null)
      setTypeOpen(false)
      // 朗读中单击文字不翻页，免得双击跳转时连翻两页
      if (narrator.current?.playing && textPointAt(doc, ev.clientX, ev.clientY)) return
      if (rsRef.current.flow === 'scrolled' && !viewRef.current?.isFixedLayout) return
      const stage = stageRef.current.getBoundingClientRect()
      const x = frameRect(doc, { left: ev.clientX, right: ev.clientX, top: ev.clientY, bottom: ev.clientY }).left
      const rel = (x - stage.left) / stage.width
      if (rel < 0.22) viewRef.current.goLeft()
      else if (rel > 0.78) viewRef.current.goRight()
    }, 30)
  }

  const wheelAt = useRef(0)
  const onWheel = e => {
    const view = viewRef.current
    if (!view || (rsRef.current.flow === 'scrolled' && !view.isFixedLayout)) return
    if (view.isFixedLayout && rsRef.current.pdfZoom === 'fit-width') return
    e.preventDefault?.()
    const now = Date.now()
    if (now - wheelAt.current < 280 || Math.abs(e.deltaY) < 4) return
    wheelAt.current = now
    setPopup(null)
    e.deltaY > 0 ? view.next() : view.prev()
  }

  // ---------- 快捷键 ----------
  const keyRef = useRef()
  keyRef.current = e => {
    const view = viewRef.current
    if (!view) return
    const typing = e.target.closest?.('input, textarea, [contenteditable]')
    const mod = e.ctrlKey || e.metaKey
    if (mod && e.key === 'f') { e.preventDefault(); setRight('search'); return }
    if (mod && e.key === 'j') { e.preventDefault(); setRight(r => r === 'ai' ? null : 'ai'); return }
    if (mod && e.key === 'd') { e.preventDefault(); setLeft(l => l === 'toc' ? null : 'toc'); return }
    if (mod && e.key === 'b') { e.preventDefault(); toggleBookmark(); return }
    if (e.key === 'F11') { e.preventDefault(); toggleFull(); return }
    if (typing) return
    if (e.key === 'Escape') {
      if (popup) setPopup(null)
      else if (typeOpen) setTypeOpen(false)
      else if (right || left) { setRight(null); setLeft(null) }
      else onClose()
      return
    }
    if (['ArrowLeft', 'PageUp'].includes(e.key) || (e.key === ' ' && e.shiftKey)) { e.preventDefault(); setPopup(null); view.goLeft() }
    else if (['ArrowRight', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); setPopup(null); view.goRight() }
    else if (e.key === 'ArrowUp' && view.isFixedLayout) { e.preventDefault(); view.prev() }
    else if (e.key === 'ArrowDown' && view.isFixedLayout) { e.preventDefault(); view.next() }
  }
  const onKey = e => keyRef.current(e)
  useEffect(() => {
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ---------- PDF 高亮（固定版式没有 overlayer，自己画） ----------
  const drawPdfHighlights = (doc, index) => {
    applyOcrLayer(doc, ocrRef.current.pages?.[index]) // 扫描页：先铺 OCR 文字，高亮才找得到位置
    doc.getElementById('air-hl')?.remove()
    const list = annsRef.current.filter(a => a.type === 'highlight' && a.index === index)
    if (!list.length || !doc.body) return
    const html = doc.documentElement
    const hr = html.getBoundingClientRect()
    const s = hr.width / (html.offsetWidth || hr.width) || 1
    const layer = doc.createElement('div')
    layer.id = 'air-hl'
    layer.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;z-index:5;pointer-events:none'
    for (const a of list) {
      let range
      try { range = viewRef.current.resolveCFI(a.cfi).anchor(doc) } catch {}
      if (!range) continue
      for (const r of range.getClientRects()) {
        if (!r.width) continue
        const d = doc.createElement('div')
        const under = a.style === 'underline'
        const top = (r.top - hr.top) / s + (under ? r.height / s - 2 / s : 0)
        d.style.cssText = `position:absolute;left:${(r.left - hr.left) / s}px;top:${top}px;width:${r.width / s}px;height:${under ? 2 / s : r.height / s}px;background:${colorOf(a.color)};opacity:${under ? 0.9 : 0.32};mix-blend-mode:multiply;pointer-events:auto;cursor:pointer;border-radius:2px`
        d.addEventListener('click', ev => {
          ev.stopPropagation()
          annClickAt.current = Date.now()
          showPopupFor({ kind: 'annotation', ann: a, range })
        })
        layer.append(d)
      }
    }
    doc.body.append(layer)
  }
  const redrawPdfHighlights = () => {
    const view = viewRef.current
    if (!view?.isFixedLayout) return
    for (const c of view.renderer.getContents?.() || []) if (c.doc) drawPdfHighlights(c.doc, c.index)
  }
  useEffect(() => {
    if (!isFixed) return
    let t
    const onResize = () => { clearTimeout(t); t = setTimeout(redrawPdfHighlights, 400) }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // ---------- 标注操作 ----------
  const chapterLabel = () => locRef.current?.tocItem?.label || ''
  const addHighlight = (color, style = 'highlight', note = '') => {
    if (!popup?.cfi) return
    const view = viewRef.current
    const existing = annsRef.current.find(a => a.cfi === popup.cfi)
    if (existing) return updateAnn(existing.id, { color, style })
    const ann = {
      id: uid(), type: 'highlight', style, color, cfi: popup.cfi, index: popup.index,
      text: popup.text, note, chapter: chapterLabel(), createdAt: Date.now(),
    }
    saveAnns([...annsRef.current, ann])
    if (view.isFixedLayout) redrawPdfHighlights()
    else view.addAnnotation({ value: ann.cfi })
    view.deselect()
    return ann
  }
  const updateAnn = (id, patch) => {
    const list = annsRef.current.map(a => a.id === id ? { ...a, ...patch } : a)
    saveAnns(list)
    const a = list.find(x => x.id === id)
    if (a?.type === 'highlight') {
      if (viewRef.current.isFixedLayout) redrawPdfHighlights()
      else viewRef.current.addAnnotation({ value: a.cfi })
    }
    return a
  }
  const removeAnn = id => {
    const a = annsRef.current.find(x => x.id === id)
    saveAnns(annsRef.current.filter(x => x.id !== id))
    if (a?.type === 'highlight') {
      if (viewRef.current.isFixedLayout) redrawPdfHighlights()
      else viewRef.current.deleteAnnotation({ value: a.cfi })
    }
  }

  // 书签：当前页是否已有书签
  const pageBookmark = useMemo(() => {
    if (!loc?.cfi || !modsRef.current) return null
    const { CFI } = modsRef.current
    const bms = anns.filter(a => a.type === 'bookmark')
    if (isFixed) return bms.find(b => b.index === loc.index) || null
    try {
      const start = CFI.collapse(loc.cfi), end = CFI.collapse(loc.cfi, true)
      return bms.find(b => CFI.compare(b.cfi, start) >= 0 && CFI.compare(b.cfi, end) <= 0) || null
    } catch { return null }
  }, [loc, anns])

  const toggleBookmark = () => {
    const l = locRef.current
    if (!l?.cfi) return
    if (pageBookmarkRef.current) { removeAnn(pageBookmarkRef.current.id); toast('已删除书签'); return }
    const { CFI } = modsRef.current
    const text = (l.range?.toString() || '').replace(/\s+/g, ' ').trim().slice(0, 80)
    saveAnns([...annsRef.current, {
      id: uid(), type: 'bookmark', cfi: isFixed ? l.cfi : CFI.collapse(l.cfi), index: l.index,
      text, chapter: chapterLabel(), fraction: l.fraction, createdAt: Date.now(),
    }])
    toast('已添加书签', 'success')
  }
  const pageBookmarkRef = useRef()
  pageBookmarkRef.current = pageBookmark

  // ---------- 取文本（给 AI 和朗读用） ----------
  const getPageText = async () => {
    const view = viewRef.current
    const l = locRef.current
    if (l?.range) return l.range.toString()
    return (view?.renderer.getContents?.() || [])
      .map(c => [...(c.doc?.querySelectorAll('.textLayer') || [])].filter(x => x.style.display !== 'none').map(x => x.textContent).join('') // 含 OCR 文字层
        || ocrPageText(ocrRef.current.pages?.[c.index]) || c.doc?.body?.textContent || '').join('\n')
  }
  const getChapterText = async limit => {
    const view = viewRef.current
    const book = bookRef.current
    const l = locRef.current
    if (!view || !l) return ''
    if (book.pdf) {
      const pages = []
      let total = 0
      for (let i = Math.max(0, l.index - 1); i < book.pdf.numPages && total < limit; i++) {
        const tc = await (await book.pdf.getPage(i + 1)).getTextContent()
        const t = tc.items.map(x => x.str + (x.hasEOL ? '\n' : '')).join('').trim() || ocrPageText(ocrRef.current.pages?.[i]) // 扫描页用 OCR 结果
        pages.push(`[第 ${i + 1} 页]\n${t}`)
        total += t.length
        if (i > l.index + 6) break
      }
      return pages.join('\n\n').slice(0, limit)
    }
    const section = book.sections[l.index]
    if (!section?.createDocument) return getPageText()
    const doc = await section.createDocument()
    const text = (doc.body?.textContent || '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim()
    if (text.length <= limit) return text
    const page = (l.range?.toString() || '').replace(/\s+/g, ' ').trim().slice(0, 24)
    const at = page ? text.replace(/\s+/g, ' ').indexOf(page) : 0
    const start = Math.max(0, Math.min(text.length - limit, (at > 0 ? at : 0) - limit / 2))
    return text.slice(start, start + limit)
  }

  // ---------- 朗读 ----------
  // ---------- 朗读内容来源 ----------
  // 可重排的书（EPUB/TXT/MOBI…）按章连续朗读，页面跟着正在读的句子翻，翻页不停顿；
  // PDF 按页读（用文本层），拿不到文本层时退回纯文本
  const sectionItems = doc => {
    const r = doc.createRange()
    r.selectNodeContents(doc.body)
    return sentencesFromRange(r)
  }
  const nextSectionIndex = index => {
    const sections = bookRef.current?.sections || []
    for (let i = index + 1; i < sections.length; i++) if (sections[i]?.linear !== 'no') return i
    return null
  }
  const pageItems = async () => {
    const view = viewRef.current
    if (isPdf) {
      // 扫描页没有文字：先识别再读
      const cs = view.renderer.getContents?.() || []
      if (cs.some(c => c.doc && !hasPdfText(c.doc) && !ocrRef.current.pages[c.index])) {
        await waitOcr(cs.map(c => c.index))
        redrawPdfHighlights()
      }
    }
    if (view?.isFixedLayout) {
      const out = []
      for (const c of view.renderer.getContents?.() || []) {
        for (const layer of c.doc?.querySelectorAll('.textLayer') || []) { // PDF 自带的文字层，或 OCR 文字层
          if (!layer.textContent.trim() || layer.style.display === 'none') continue // 被 OCR 替换掉的乱码层不读
          const r = c.doc.createRange()
          r.selectNodeContents(layer)
          out.push(...sentencesFromRange(r, { openTail: true }))
        }
      }
      if (out.length) return out
    }
    return splitSentences(await getPageText()).map(text => ({ text }))
  }
  const narrationSource = {
    async first(from) {
      const view = viewRef.current
      const vis = locRef.current?.range
      if (!view.isFixedLayout && vis) {
        const { doc, index } = view.renderer.getContents()[0]
        const at = from || { node: vis.startContainer, offset: vis.startOffset }
        return { section: true, index, items: itemsFrom(sectionItems(doc), at) }
      }
      return { items: itemsFrom(await pageItems(), from) }
    },
    async next(chunk) {
      const view = viewRef.current
      if (chunk.section) {
        const index = nextSectionIndex(chunk.index)
        if (index == null) return null
        await view.renderer.goTo({ index })
        const c = view.renderer.getContents()[0]
        if (c?.index !== index) return null
        return { section: true, index, items: sectionItems(c.doc) }
      }
      if (locRef.current?.fraction >= 0.999) return null
      await view.next()
      await new Promise(r => setTimeout(r, 400))
      return { items: await pageItems() }
    },
    async peek(chunk) {
      if (!chunk.section) return null
      const index = nextSectionIndex(chunk.index)
      const section = index != null && bookRef.current.sections[index]
      if (!section?.createDocument) return null
      return sectionItems(await section.createDocument())
    },
    // 正在读的句子翻出了屏幕（读到下一页了，或用户自己翻走了）就把页面翻过去
    follow(range) {
      const vis = locRef.current?.range
      const view = viewRef.current
      if (!vis || view.isFixedLayout || vis.startContainer.ownerDocument !== range.startContainer.ownerDocument) return
      const { startContainer: sn, startOffset: so, endContainer: en, endOffset: eo } = range
      const startPos = vis.comparePoint(sn, so)
      const after = startPos > 0 || (startPos === 0 && sn === vis.endContainer && so >= vis.endOffset)
      const before = vis.comparePoint(en, eo) < 0
      if (after || before) view.renderer.scrollToAnchor(range)
    },
  }

  const ensureNarrator = () => {
    if (!narrator.current) {
      narrator.current = new Narrator({
        source: narrationSource,
        onState: setSpeaking,
        getSettings: () => ttsRef.current,
        onNotice: (msg, type) => toast(msg, type),
      })
    }
    return narrator.current
  }
  const toggleSpeak = () => {
    if (speaking) ensureNarrator().stop()
    else ensureNarrator().start()
  }
  const readFrom = (node, offset) => {
    setPopup(null)
    viewRef.current?.deselect()
    ensureNarrator().start({ node, offset })
  }

  const toggleFull = async () => setFull(await window.api.toggleFullscreen())

  // ---------- AI 入口 ----------
  const askAI = (action, text, cfi, index) => {
    setRight('ai')
    setAiRequest({ id: uid(), action, text, cfi, index })
    setPopup(null)
    viewRef.current?.deselect()
  }
  const saveAINote = (content, quote, cfi, index) => {
    if (cfi) {
      const existing = annsRef.current.find(a => a.cfi === cfi)
      if (existing) updateAnn(existing.id, { note: (existing.note ? existing.note + '\n\n' : '') + content })
      else {
        saveAnns([...annsRef.current, {
          id: uid(), type: 'highlight', style: 'highlight', color: 'blue', cfi, index,
          text: quote, note: content, chapter: chapterLabel(), createdAt: Date.now(),
        }])
        if (viewRef.current.isFixedLayout) redrawPdfHighlights()
        else viewRef.current.addAnnotation({ value: cfi })
      }
    } else {
      const l = locRef.current
      saveAnns([...annsRef.current, {
        id: uid(), type: 'note', cfi: l?.cfi, index: l?.index, text: quote || '', note: content,
        chapter: chapterLabel(), createdAt: Date.now(),
      }])
    }
    toast('已保存到笔记', 'success')
  }

  const goTo = async target => {
    setPopup(null)
    await viewRef.current?.goTo(target)
  }

  const pct = loc ? Math.round((scrub ?? loc.fraction) * 1000) / 10 : 0
  const title = record.title

  return (
    <div className={`reader ${full ? 'is-full' : ''}`} style={{ '--page-bg': theme.bg, '--page-fg': theme.fg }}>
      <header className="r-top drag">
        <button className="icon-btn" title="返回书库 (Esc)" onClick={onClose}><ArrowLeft size={18} /></button>
        <div className="r-tools">
          <button className={`icon-btn ${left === 'toc' ? 'on' : ''}`} title="目录 (Ctrl+D)" onClick={() => setLeft(l => l === 'toc' ? null : 'toc')}><List size={18} strokeWidth={1.75} /></button>
          <button className={`icon-btn ${left === 'notes' || left === 'bookmarks' ? 'on' : ''}`} title="书签与笔记" onClick={() => setLeft(l => l === 'notes' ? null : 'notes')}><NotebookPen size={17} strokeWidth={1.75} /></button>
        </div>
        <div className="r-title">
          <span className="t">{title}</span>
          {loc?.tocItem?.label && <span className="c">{loc.tocItem.label}</span>}
        </div>
        <div className="r-tools">
          <button className={`icon-btn ${right === 'search' ? 'on' : ''}`} title="搜索 (Ctrl+F)" onClick={() => setRight(r => r === 'search' ? null : 'search')}><Search size={17} strokeWidth={1.75} /></button>
          <button className={`icon-btn ${pageBookmark ? 'on' : ''}`} title="书签 (Ctrl+B)" onClick={toggleBookmark}>
            {pageBookmark ? <BookmarkCheck size={17} strokeWidth={1.75} /> : <Bookmark size={17} strokeWidth={1.75} />}
          </button>
          <button className={`icon-btn type-toggle ${typeOpen ? 'on' : ''}`} title="排版与主题" onClick={() => setTypeOpen(v => !v)}><Type size={17} strokeWidth={1.75} /></button>
          <button className={`icon-btn ${speaking ? 'on' : ''}`} title={speaking ? '停止朗读' : '朗读（右键：音色与语速）'} onClick={toggleSpeak}
            onContextMenu={e => { e.preventDefault(); lib.openSettings('tts') }}>
            {speaking ? <Square size={15} fill="currentColor" /> : <Volume2 size={17} strokeWidth={1.75} />}
          </button>
          <button className="icon-btn" title="全屏 (F11)" onClick={toggleFull}>{full ? <Minimize size={17} strokeWidth={1.75} /> : <Maximize size={17} strokeWidth={1.75} />}</button>
          <button className={`ai-btn ${right === 'ai' ? 'on' : ''}`} title="AI 助手 (Ctrl+J)" onClick={() => setRight(r => r === 'ai' ? null : 'ai')}>
            <Sparkles size={15} strokeWidth={2} />AI 助手
          </button>
        </div>
      </header>

      <div className="r-body">
        {left && (
          <SidePanel tab={left} setTab={setLeft} toc={toc} loc={loc} anns={anns} book={record}
            goTo={goTo} removeAnn={removeAnn} updateAnn={updateAnn} onClose={() => setLeft(null)} />
        )}
        <div className="r-stage-wrap">
          <div className={`r-stage ${isFixed && theme.dark ? 'invert' : ''} ${rs.flow === 'scrolled' ? 'scrolled' : ''}`} ref={stageRef}
            onWheel={onWheel}>
            {!ready && !error && <div className="r-loading"><span className="spinner" />正在打开…</div>}
            {error && <div className="r-loading err">无法打开这本书：{error}</div>}
          </div>
          {ready && rs.flow !== 'scrolled' && (
            <>
              <button className="turn prev" onClick={() => viewRef.current.goLeft()}><ChevronLeft size={22} /></button>
              <button className="turn next" onClick={() => viewRef.current.goRight()}><ChevronRight size={22} /></button>
            </>
          )}
          {typeOpen && <TypeSettings isFixed={isFixed} onClose={() => setTypeOpen(false)} />}
        </div>
        {right === 'search' && (
          <SearchPanel view={viewRef.current} book={bookRef.current} goTo={goTo} onClose={() => setRight(null)}
            ocrText={i => ocrPageText(ocrRef.current.pages?.[i])} />
        )}
        {right === 'ai' && (
          <AIPanel record={record} request={aiRequest} onRequestHandled={() => setAiRequest(null)} getPageText={getPageText} getChapterText={getChapterText}
            chapter={loc?.tocItem?.label} onSaveNote={saveAINote} onClose={() => setRight(null)} />
        )}
      </div>

      <footer className="r-bottom">
        <span className="r-chapter">{loc?.tocItem?.label || ' '}</span>
        <input type="range" className="r-slider" min={0} max={1} step={0.0005}
          value={scrub ?? loc?.fraction ?? 0}
          style={{ '--p': `${(scrub ?? loc?.fraction ?? 0) * 100}%` }}
          onChange={e => setScrub(+e.target.value)}
          onPointerUp={() => { if (scrub != null) { viewRef.current?.goToFraction(scrub); setScrub(null) } }}
          onKeyUp={() => { if (scrub != null) { viewRef.current?.goToFraction(scrub); setScrub(null) } }} />
        {ocrBusy && (
          <span className="ocr-status tabular" title="扫描页在后台识别文字，识别好的页可以直接选中、复制">
            <span className="spinner" />识别文字 · 还剩 {ocr.queued + (ocr.running != null ? 1 : 0)} 页
          </span>
        )}
        <span className="r-pct tabular">
          {isFixed && loc ? `${loc.index + 1} / ${loc.sectionTotal ?? '?'} 页 · ` : loc?.location ? `${loc.location.current + 1} / ${loc.location.total} · ` : ''}
          {pct}%
        </span>
      </footer>

      {popup && (
        <SelectionPopup popup={popup} onClose={() => setPopup(null)}
          addHighlight={addHighlight} updateAnn={updateAnn} removeAnn={removeAnn}
          askAI={askAI}
          onReadFrom={range => readFrom(range.startContainer, range.startOffset)}
          onSearch={text => { setRight('search'); setPopup(null); setTimeout(() => window.dispatchEvent(new CustomEvent('air-search', { detail: text })), 50) }}
          onCopied={() => { toast('已复制'); setPopup(null) }} />
      )}
    </div>
  )
}
