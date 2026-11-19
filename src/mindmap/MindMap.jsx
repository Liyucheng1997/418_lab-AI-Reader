import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  X, Network, Users, Download, RotateCcw, Search, Maximize2, Plus, Minus, Square, Sparkles, KeyRound,
  BookOpen, ChevronsDownUp, ChevronsUpDown, FileText, Image as ImageIcon, Star, Play,
} from 'lucide-react'
import { useLib } from '../App.jsx'
import { toast, openMenu, confirmDialog } from '../lib/ui.jsx'
import { aiReady, aiLabel } from '../lib/ai.js'
import { isAppDark } from '../reader/theme.js'
import { DETAIL, bookText, generate, cancel, subscribe, jobState } from './generate.js'
import {
  buildTree, layoutTree, linkPath, findPath, layoutGraph, graphBBox, toMarkdown, palette,
  BRANCH_COLORS, GROUP_COLORS, STYLE,
} from './layout.js'

const hexA = (hex, a) => {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`
}
const keyPath = path => path.map(n => n.label).join('/')

// ---------- 平移缩放 ----------
function usePanZoom() {
  const [tf, setTfState] = useState({ x: 0, y: 0, k: 1 })
  const tfRef = useRef(tf)
  const boxRef = useRef()
  const setTf = t => { tfRef.current = t; setTfState(t) }
  const fitTo = useCallback((bbox, pad = 48, maxK = 1) => {
    const el = boxRef.current
    if (!el || !bbox) return
    const W = el.clientWidth, H = el.clientHeight
    const k = Math.max(0.12, Math.min(maxK, (W - pad * 2) / bbox.w, (H - pad * 2) / bbox.h))
    setTf({ k, x: W / 2 - (bbox.x + bbox.w / 2) * k, y: H / 2 - (bbox.y + bbox.h / 2) * k })
  }, [])
  const zoomBy = useCallback((f, cx, cy) => {
    const el = boxRef.current
    const t = tfRef.current
    if (cx == null) { cx = el.clientWidth / 2; cy = el.clientHeight / 2 }
    const k = Math.max(0.12, Math.min(3, t.k * f))
    setTf({ k, x: cx - (cx - t.x) * k / t.k, y: cy - (cy - t.y) * k / t.k })
  }, [])
  const centerOn = useCallback((x, y, k) => {
    const el = boxRef.current
    const kk = k ?? Math.max(tfRef.current.k, 0.8)
    setTf({ k: kk, x: el.clientWidth / 2 - x * kk, y: el.clientHeight / 2 - y * kk })
  }, [])
  // 滚轮缩放（以鼠标为中心）；拖动空白处平移
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const onWheel = e => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      if (e.ctrlKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) zoomBy(Math.exp(-e.deltaY * 0.0016), e.clientX - r.left, e.clientY - r.top)
      else { const t = tfRef.current; setTf({ ...t, x: t.x - e.deltaX }) }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  })
  const panStart = e => {
    if (e.button !== 0 || e.target.closest('[data-node], .mm-zoom, .mm-legend, button, input, label')) return
    const t0 = tfRef.current, x0 = e.clientX, y0 = e.clientY
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    el.classList.add('panning')
    const move = ev => setTf({ ...t0, x: t0.x + ev.clientX - x0, y: t0.y + ev.clientY - y0 })
    const up = () => { el.classList.remove('panning'); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up) }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }
  return { tf, tfRef, boxRef, fitTo, zoomBy, centerOn, panStart }
}

export default function MindMap({ record, onClose, onLocate, onOpenBook }) {
  const lib = useLib()
  const ai = lib.settings.ai
  const dark = isAppDark(lib.settings.theme)
  const C = palette(dark)
  const [doc, setDoc] = useState(undefined) // undefined = 读取中；null = 还没生成过
  const [job, setJob] = useState(() => jobState(record.id))
  const [view, setView] = useState('map') // map | graph
  const [sel, setSel] = useState(null) // { kind, name, index }
  const [query, setQuery] = useState('')
  const [detail, setDetail] = useState('normal')

  useEffect(() => {
    let alive = true
    window.api.getMindMap(record.id).then(d => { if (alive) setDoc(d || null) })
    const off = subscribe(record.id, st => { setJob({ ...st }); if (st.doc) setDoc(st.doc) })
    return () => { alive = false; off() }
  }, [record.id])
  useEffect(() => { if (doc?.detail) setDetail(doc.detail) }, [doc?.detail])

  useEffect(() => {
    const k = e => {
      if (e.target.closest?.('input, textarea')) { if (e.key === 'Escape') e.target.blur(); return }
      if (document.querySelector('.modal-overlay, .popover') || e.key === 'F11') return
      e.stopPropagation() // 导图盖在阅读页上面：别让方向键、快捷键去翻下面的书
      if (e.key === 'Escape') onClose()
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); document.querySelector('.mm-search input')?.focus() }
    }
    window.addEventListener('keydown', k, true)
    return () => window.removeEventListener('keydown', k, true)
  }, [onClose])

  const running = !!job && ['reading', 'extracting', 'merging'].includes(job.phase)
  const map = doc?.map
  const start = (fresh = false) => generate(record, { detail, fresh, model: aiLabel(ai) })
  const restart = async () => {
    if (!(await confirmDialog({ title: '重新生成思维导图？', message: '会让 AI 从头再读一遍全书，现有的导图会被替换。', okText: '重新生成' }))) return
    setSel(null)
    start(true)
  }

  const exportAs = async kind => {
    if (!map) return
    const base = `${record.title} 思维导图`
    try {
      if (kind === 'md') {
        const f = await window.api.saveText(base + '.md', toMarkdown(map, record))
        if (f) toast('已导出 Markdown', 'success')
        return
      }
      const svg = document.querySelector('.mm-canvas svg.mm-svg')
      const { text, w, h } = standaloneSVG(svg, C)
      if (kind === 'svg') {
        if (await window.api.saveText(base + (view === 'graph' ? '（人物关系）' : '') + '.svg', text)) toast('已导出 SVG', 'success')
        return
      }
      const bytes = await svgToPng(text, w, h)
      if (await window.api.saveBinary(base + (view === 'graph' ? '（人物关系）' : '') + '.png', bytes)) toast('已导出图片', 'success')
    } catch (e) {
      toast('导出失败：' + (e?.message || e), 'error')
    }
  }

  const exportMenu = e => openMenu(e, [
    { label: '导出为图片（PNG）', icon: ImageIcon, onClick: () => exportAs('png') },
    { label: '导出为矢量图（SVG）', icon: ImageIcon, onClick: () => exportAs('svg') },
    { label: '导出为 Markdown 大纲', icon: FileText, onClick: () => exportAs('md') },
  ])

  // ---------- 实体索引 ----------
  const index = useMemo(() => {
    const m = new Map()
    if (!map) return m
    for (const c of map.characters || []) { m.set('character:' + c.name, c); for (const a of c.aliases || []) if (!m.has('alias:' + a)) m.set('alias:' + a, c) }
    for (const cat of map.conceptCategories || []) for (const i of cat.items) m.set('concept:' + i.name, { ...i, category: cat.name })
    for (const p of map.places || []) m.set('place:' + p.name, p)
    for (const t of map.themes || []) m.set('theme:' + t.name, t)
    return m
  }, [map])
  // 名字 → 可点击的实体
  const resolve = useCallback(name => {
    if (index.has('character:' + name)) return { kind: 'character', name }
    const a = index.get('alias:' + name)
    if (a) return { kind: 'character', name: a.name }
    if (index.has('concept:' + name)) return { kind: 'concept', name }
    if (index.has('place:' + name)) return { kind: 'place', name }
    return null
  }, [index])

  const showIntro = doc === null && !running
  const showProgress = running && !map
  return (
    <div className="mindmap">
      <header className="mm-top drag">
        <button className="icon-btn" title="关闭 (Esc)" onClick={onClose}><X size={18} /></button>
        <div className="mm-title">
          <span className="t">《{record.title}》</span>
          <span className="c">{map ? (view === 'map' ? '思维导图' : '人物关系') : '思维导图'}</span>
        </div>
        {map && (
          <div className="seg">
            <button className={view === 'map' ? 'active' : ''} onClick={() => setView('map')}><Network size={14} />思维导图</button>
            <button className={view === 'graph' ? 'active' : ''} onClick={() => setView('graph')} disabled={!map.characters?.length}><Users size={14} />人物关系</button>
          </div>
        )}
        <span style={{ flex: 1 }} />
        {map && (
          <label className="mm-search">
            <Search size={14} />
            <input value={query} placeholder="查找人物、概念…" onChange={e => setQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') window.dispatchEvent(new CustomEvent('mm-find')) }} />
            {query && <button className="icon-btn mini" onClick={() => setQuery('')}><X size={12} /></button>}
          </label>
        )}
        {onOpenBook && <button className="btn btn-sm" onClick={onOpenBook}><BookOpen size={14} />打开阅读</button>}
        {map && <button className="btn btn-sm" onClick={exportMenu}><Download size={14} />导出</button>}
        {map && !running && <button className="icon-btn" title="重新生成" onClick={restart}><RotateCcw size={16} /></button>}
      </header>

      {running && map && <ProgressBar job={job} />}
      {!running && map && job?.phase === 'error' && <div className="mm-banner err">生成中断：{job.error}<button className="btn btn-sm btn-primary" onClick={() => start()}>继续生成</button></div>}
      {!running && map && (doc.status === 'partial' || job?.message) && job?.phase !== 'error' && (
        <div className="mm-banner">
          {job?.message || `上次只读完了 ${Object.keys(doc.chunks || {}).length}/${doc.chunkCount} 段。`}
          {doc.status === 'partial' && <button className="btn btn-sm btn-primary" onClick={() => start()}>继续生成</button>}
        </div>
      )}

      <div className="mm-body">
        {doc === undefined && <div className="mm-center"><span className="spinner" /></div>}
        {showIntro && <Intro record={record} ai={ai} detail={detail} setDetail={setDetail} onStart={() => start()} job={job} />}
        {showProgress && <Progress job={job} onStop={() => cancel(record.id)} />}
        {!running && !map && doc && <Intro record={record} ai={ai} detail={detail} setDetail={setDetail} onStart={() => start()} job={job} resume={doc} />}
        {map && (
          <>
            {view === 'map'
              ? <TreeView map={map} title={record.title} C={C} sel={sel} setSel={setSel} query={query} live={running} />
              : <GraphView map={map} C={C} sel={sel} setSel={setSel} query={query} />}
            <Detail map={map} doc={doc} sel={sel} setSel={setSel} resolve={resolve} index={index} onLocate={onLocate} record={record} />
          </>
        )}
      </div>
    </div>
  )
}

// ---------- 开始前 ----------
function Intro({ record, ai, detail, setDetail, onStart, job, resume }) {
  const lib = useLib()
  const [size, setSize] = useState(null)
  useEffect(() => {
    let alive = true
    bookText(record).then(t => alive && setSize(t.total)).catch(e => alive && setSize(-1))
    return () => { alive = false }
  }, [record.id])
  const chunks = size > 0 ? Math.max(1, Math.ceil(size / DETAIL[detail].chunk)) : 0
  return (
    <div className="mm-center">
      <div className="mm-intro">
        <div className="mm-intro-icon"><Network size={26} strokeWidth={1.8} /></div>
        <div className="mm-intro-title">把这本书整理成思维导图</div>
        <div className="mm-intro-msg">AI 会通读全书，梳理出书里的人物与人物关系、核心概念、主题和情节脉络，画成可以展开、缩放、导出的思维导图和人物关系图。</div>
        <div className="mm-feats">
          <div><Users size={16} /><b>人物</b><span>身份、性格、经历，按阵营分组</span></div>
          <div><Network size={16} /><b>关系</b><span>谁和谁是什么关系，一张图看清</span></div>
          <div><Sparkles size={16} /><b>概念</b><span>术语、思想、组织、器物</span></div>
          <div><Play size={16} /><b>脉络</b><span>主题、情节或论证结构、地点</span></div>
        </div>
        {!aiReady(ai) ? (
          <>
            <div className="mm-intro-note"><KeyRound size={14} />需要先配置 AI（Claude 订阅或任一服务的 API Key）</div>
            <button className="btn btn-primary" onClick={() => lib.openSettings('ai')}>打开 AI 设置</button>
          </>
        ) : (
          <>
            <div className="mm-detail-row">
              <span className="form-label">精细程度</span>
              <div className="seg">
                {Object.entries(DETAIL).map(([k, d]) => <button key={k} className={detail === k ? 'active' : ''} title={d.hint} onClick={() => setDetail(k)}>{d.label}</button>)}
              </div>
            </div>
            <div className="mm-intro-note tabular">
              {size == null ? '正在统计全书字数…'
                : size < 0 ? '读取全书文字失败'
                : `全书约 ${size >= 10000 ? (size / 10000).toFixed(1) + ' 万' : size} 字，分 ${chunks} 段交给 AI（${aiLabel(ai)}）阅读，最后再整合一次`}
            </div>
            {job?.phase === 'error' && <div className="mm-intro-err">{job.error}</div>}
            <button className="btn btn-primary mm-go" onClick={onStart} disabled={size != null && size <= 0}>
              <Sparkles size={15} />{resume ? `继续生成（已读 ${Object.keys(resume.chunks || {}).length}/${resume.chunkCount} 段）` : '开始生成'}
            </button>
            <div className="mm-intro-tip">生成过程中可以关掉这个窗口继续读书，后台会接着整理。</div>
          </>
        )}
      </div>
    </div>
  )
}

function phaseText(job) {
  if (job.phase === 'reading') return job.message || '正在读取全书文字…'
  if (job.phase === 'merging') return job.message
  return `AI 正在阅读全书 · 第 ${Math.min(job.done + 1, job.total)} / ${job.total} 段`
}

function Progress({ job, onStop }) {
  const pct = job.total ? job.done / job.total : 0
  return (
    <div className="mm-center">
      <div className="mm-intro">
        <div className="mm-intro-icon pulse"><Sparkles size={24} strokeWidth={1.8} /></div>
        <div className="mm-intro-title">正在整理…</div>
        <div className="mm-intro-msg">{phaseText(job)}</div>
        <div className="mm-prog"><i style={{ width: `${Math.max(4, pct * 100)}%` }} /></div>
        <div className="mm-intro-tip">读完第一段就能先看到导图，后面会边读边补充。可以关掉窗口，后台会继续。</div>
        <button className="btn" onClick={onStop}><Square size={11} fill="currentColor" />停止</button>
      </div>
    </div>
  )
}

function ProgressBar({ job }) {
  const pct = job.phase === 'merging' ? 1 : job.total ? job.done / job.total : 0
  return (
    <div className="mm-banner live">
      <span className="spinner sm" />{phaseText(job)}
      <div className="mm-prog small"><i style={{ width: `${Math.max(3, pct * 100)}%` }} /></div>
      <button className="btn btn-sm" onClick={() => cancel(job.doc?.bookId)}><Square size={10} fill="currentColor" />停止</button>
    </div>
  )
}

// ---------- 思维导图 ----------
const sameRef = (a, b) => !!a && !!b && a.kind === b.kind && (a.kind === 'event' ? a.index === b.index : a.name === b.name)

function TreeView({ map, title, C, sel, setSel, query, live }) {
  const pz = usePanZoom()
  const overrides = useRef(new Map()) // 用户手动展开 / 折叠过的节点（按路径记住，导图更新后保留）
  const [ver, setVer] = useState(0)
  const root = useMemo(() => {
    const r = buildTree(map, title)
    const apply = (n, path) => {
      const k = keyPath([...path, n])
      if (overrides.current.has(k)) n.collapsed = overrides.current.get(k)
      n.children.forEach(c => apply(c, [...path, n]))
    }
    apply(r, [])
    return r
  }, [map, title, ver])
  const lay = useMemo(() => layoutTree(root), [root])
  // 第一次显示、以及边读边补充结束时，调整视野；整张图太大时不缩得太小，以书名为中心
  const fitted = useRef(false)
  const wasLive = useRef(live)
  const autoFit = () => {
    const el = pz.boxRef.current, b = layRef.current.bbox
    if (!el) return
    const k = Math.min(1, (el.clientWidth - 80) / b.w, (el.clientHeight - 80) / b.h)
    if (k >= 0.5) pz.fitTo(b, 40, 1)
    else pz.centerOn(0, 0, 0.5)
  }
  useLayoutEffect(() => {
    if ((!fitted.current || (wasLive.current && !live)) && lay.nodes.length) { autoFit(); fitted.current = true }
    wasLive.current = live
  }, [lay, live])

  const toggle = (n, value) => {
    const path = findPath(root, x => x === n)
    overrides.current.set(keyPath(path), value ?? !n.collapsed)
    setVer(v => v + 1)
  }
  const setAll = collapsed => {
    const walk = (n, path) => {
      const p = [...path, n]
      if (n.children.length && n.level >= 1) overrides.current.set(keyPath(p), collapsed && n.level >= 2)
      n.children.forEach(c => walk(c, p))
    }
    walk(root, [])
    setVer(v => v + 1)
    setTimeout(() => fitNow(), 0)
  }
  const layRef = useRef(lay)
  layRef.current = lay
  const fitNow = () => pz.fitTo(layRef.current.bbox, 40, 1)

  // 查找：高亮匹配；回车跳到下一个（必要时展开祖先）
  const q = query.trim().toLowerCase()
  const isMatch = n => q && (n.label.toLowerCase().includes(q) || (n.sub || '').toLowerCase().includes(q))
  const hit = useRef(-1)
  useEffect(() => { hit.current = -1 }, [q])
  useEffect(() => {
    const onFind = () => {
      if (!q) return
      const matches = []
      const walk = (n, path) => { const p = [...path, n]; if (n.level > 0 && isMatch(n)) matches.push(p); n.children.forEach(c => walk(c, p)) }
      walk(root, [])
      // 名字完全相同的排最前，其次是名字开头、名字里有，只是简介里提到的排最后
      const score = m => { const l = m.at(-1).label.toLowerCase(); return l === q ? 3 : l.startsWith(q) ? 2 : l.includes(q) ? 1 : 0 }
      matches.sort((a, b) => score(b) - score(a))
      if (!matches.length) return toast('没有找到')
      hit.current = (hit.current + 1) % matches.length
      const path = matches[hit.current]
      let changed = false
      for (const a of path.slice(0, -1)) if (a.collapsed) { overrides.current.set(keyPath(path.slice(0, path.indexOf(a) + 1)), false); changed = true }
      const target = path.at(-1)
      if (target.ref) setSel(target.ref)
      if (changed) setVer(v => v + 1)
      setTimeout(() => {
        const n = layRef.current.nodes.find(x => keyPath(findPath(root, y => y === x) || []) === keyPath(path)) || layRef.current.nodes.find(x => x.label === target.label)
        if (n) pz.centerOn(n.cx, n.cy)
      }, 0)
    }
    window.addEventListener('mm-find', onFind)
    return () => window.removeEventListener('mm-find', onFind)
  }, [q, root])

  const colorOf = n => n.level === 0 ? C.text : BRANCH_COLORS[n.branch % BRANCH_COLORS.length]
  const { tf } = pz
  return (
    <div className="mm-canvas" ref={pz.boxRef} onPointerDown={pz.panStart} style={{ background: C.bg }}>
      <svg className="mm-svg" width="100%" height="100%">
        <g transform={`translate(${tf.x},${tf.y}) scale(${tf.k})`} data-bbox={JSON.stringify(lay.bbox)}>
          {lay.links.map(l => (
            <path key={l.to.id} d={linkPath(l.from, l.to)} fill="none" stroke={colorOf(l.to)} strokeOpacity={l.to.level === 1 ? 0.9 : 0.55}
              strokeWidth={l.to.level === 1 ? 3 : l.to.level === 2 ? 2 : 1.5} strokeLinecap="round" />
          ))}
          {lay.nodes.map(n => {
            const st = STYLE[Math.min(n.level, 3)]
            const col = colorOf(n)
            const selected = sameRef(n.ref, sel) && n.ref.kind !== 'branch'
            const match = isMatch(n)
            let fill, stroke, fg, sub
            if (n.level === 0) { fill = dark(C) ? '#f5f5f7' : '#1d1d1f'; fg = dark(C) ? '#1d1d1f' : '#ffffff'; sub = dark(C) ? '#6e6e73' : '#a1a1a6' }
            else if (n.level === 1) { fill = col; fg = '#ffffff'; sub = 'rgba(255,255,255,0.8)' }
            else if (n.level === 2) { fill = hexA(col, dark(C) ? 0.24 : 0.12); fg = C.text; sub = C.text2 }
            else { fill = C.panel; stroke = hexA(col, 0.45); fg = C.text; sub = C.text2 }
            const x = n.cx - n.w / 2, y = n.cy - n.h / 2
            const textY = n.subText ? n.cy - (st.subSize + 5) / 2 + st.size * 0.36 : n.cy + st.size * 0.36
            const hasKids = n.children.length > 0
            return (
              <g key={n.id} data-node className="mm-node" onClick={() => n.ref && setSel(n.ref.kind === 'branch' ? null : n.ref)} onDoubleClick={() => hasKids && n.level > 0 && toggle(n)}>
                {(selected || match) && <rect x={x - 4} y={y - 4} width={n.w + 8} height={n.h + 8} rx={n.h / 2 + 4 > 16 ? 16 : n.h / 2 + 4} fill="none" stroke={selected ? col : C.match} strokeWidth={2.5} />}
                <rect x={x} y={y} width={n.w} height={n.h} rx={n.level <= 1 ? Math.min(n.h / 2, 20) : 9} fill={fill} stroke={stroke} strokeWidth={stroke ? 1 : 0} />
                {n.star && <path d={starPath(x + st.padX + 6, textY - st.size * 0.36, 5.5)} fill={n.level === 1 ? '#fff' : '#ffb800'} />}
                <text x={x + st.padX + (n.star ? 16 : 0)} y={textY} fontSize={st.size} fontWeight={st.weight} fill={fg}>{n.text}</text>
                {n.subText && <text x={x + st.padX} y={textY + st.subSize + 5} fontSize={st.subSize} fill={sub}>{n.subText}</text>}
                {hasKids && n.level > 0 && (
                  <g className="mm-fold" onClick={e => { e.stopPropagation(); toggle(n) }} transform={`translate(${n.cx + n.side * (n.w / 2 + 9)},${n.cy})`}>
                    <circle r={n.collapsed ? 9 : 6.5} fill={n.collapsed ? col : C.panel} stroke={col} strokeWidth={1.5} />
                    {n.collapsed
                      ? <text y={3.5} textAnchor="middle" fontSize={9.5} fontWeight={700} fill="#fff">{countAll(n)}</text>
                      : <path d="M-3,0 H3" stroke={col} strokeWidth={1.6} strokeLinecap="round" />}
                  </g>
                )}
              </g>
            )
          })}
        </g>
      </svg>
      <Zoom pz={pz} onFit={fitNow} extra={<>
        <button className="icon-btn" title="全部展开" onClick={() => setAll(false)}><ChevronsUpDown size={15} /></button>
        <button className="icon-btn" title="收起到第二层" onClick={() => setAll(true)}><ChevronsDownUp size={15} /></button>
      </>} />
      <div className="mm-hint">滚轮缩放 · 拖动平移 · 点圆点或双击展开 / 收起{live ? ' · 正在边读边补充' : ''}</div>
    </div>
  )
}
const dark = C => C.bg === '#111113'
const countAll = n => n.children.reduce((s, c) => s + 1 + countAll(c), 0)
function starPath(cx, cy, r) {
  let d = ''
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.45 : r
    d += (i ? 'L' : 'M') + (cx + Math.cos(a) * rr).toFixed(2) + ',' + (cy + Math.sin(a) * rr).toFixed(2)
  }
  return d + 'Z'
}

function Zoom({ pz, onFit, extra }) {
  return (
    <div className="mm-zoom">
      {extra}
      {extra && <span className="sep" />}
      <button className="icon-btn" title="缩小" onClick={() => pz.zoomBy(1 / 1.25)}><Minus size={15} /></button>
      <span className="pct tabular">{Math.round(pz.tf.k * 100)}%</span>
      <button className="icon-btn" title="放大" onClick={() => pz.zoomBy(1.25)}><Plus size={15} /></button>
      <button className="icon-btn" title="适应窗口" onClick={onFit}><Maximize2 size={14} /></button>
    </div>
  )
}

// ---------- 人物关系图 ----------
function GraphView({ map, C, sel, setSel, query }) {
  const pz = usePanZoom()
  const [minor, setMinor] = useState(true)
  const [hover, setHover] = useState(null)
  const posRef = useRef({})
  const [, force] = useState(0)
  const chars = useMemo(() => (map.characters || []).filter(c => minor || c.role !== '次要'), [map, minor])
  const groups = useMemo(() => {
    const list = [...new Set([...(map.groups || []).map(g => g.name), ...chars.map(c => c.group).filter(Boolean)])]
    return list.filter(g => chars.some(c => c.group === g))
  }, [map, chars])
  const groupColor = g => GROUP_COLORS[Math.max(0, groups.indexOf(g)) % GROUP_COLORS.length]
  const graph = useMemo(() => {
    const g = layoutGraph(chars, map.relations || [], posRef.current)
    for (const n of g.nodes) posRef.current[n.id] = { x: n.x, y: n.y }
    return g
  }, [chars, map.relations])
  const bbox = useMemo(() => graphBBox(graph.nodes), [graph])
  const fitted = useRef(false)
  useLayoutEffect(() => { if (!fitted.current && graph.nodes.length) { pz.fitTo(bbox, 50, 1.2); fitted.current = true } }, [graph])

  const focus = hover || (sel?.kind === 'character' ? sel.name : null)
  const nb = useMemo(() => {
    if (!focus) return null
    const s = new Set([focus])
    for (const e of graph.edges) { const a = graph.nodes[e.s].id, b = graph.nodes[e.t].id; if (a === focus) s.add(b); if (b === focus) s.add(a) }
    return s
  }, [focus, graph])
  const q = query.trim().toLowerCase()
  const isMatch = c => q && [c.name, ...(c.aliases || [])].some(n => n.toLowerCase().includes(q))
  useEffect(() => {
    const onFind = () => {
      const n = graph.nodes.find(n => isMatch(n.c))
      if (!n) return toast('没有找到')
      setSel({ kind: 'character', name: n.id })
      pz.centerOn(n.x, n.y)
    }
    window.addEventListener('mm-find', onFind)
    return () => window.removeEventListener('mm-find', onFind)
  }, [q, graph])

  // 拖动人物
  const dragNode = (e, n) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const k = pz.tfRef.current.k
    const x0 = e.clientX, y0 = e.clientY, nx = n.x, ny = n.y
    let moved = false
    const move = ev => {
      if (Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) > 3) moved = true
      n.x = nx + (ev.clientX - x0) / k; n.y = ny + (ev.clientY - y0) / k
      posRef.current[n.id] = { x: n.x, y: n.y }
      force(v => v + 1)
    }
    const up = () => {
      el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up)
      if (!moved) setSel({ kind: 'character', name: n.id })
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  const showAllLabels = graph.edges.length <= 36
  const { tf } = pz
  return (
    <div className="mm-canvas" ref={pz.boxRef} onPointerDown={pz.panStart} style={{ background: C.bg }}>
      <svg className="mm-svg" width="100%" height="100%">
        <g transform={`translate(${tf.x},${tf.y}) scale(${tf.k})`} data-bbox={JSON.stringify(bbox)}>
          {graph.edges.map((e, i) => {
            const a = graph.nodes[e.s], b = graph.nodes[e.t]
            const on = nb && nb.has(a.id) && nb.has(b.id) && (a.id === focus || b.id === focus)
            const op = nb ? (on ? 1 : C.dim) : 1
            const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
            const label = e.rel.type
            const lw = label.length * 11 + 10
            return (
              <g key={i} opacity={op}>
                <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={on ? groupColor(a.c.group) : C.line} strokeWidth={on ? 2 : 1.3} />
                {label && (showAllLabels || on) && (
                  <g transform={`translate(${mx},${my})`}>
                    <rect x={-lw / 2} y={-9} width={lw} height={18} rx={9} fill={C.panel} stroke={C.line} />
                    <text y={4} textAnchor="middle" fontSize={11} fill={C.text2}>{label}</text>
                  </g>
                )}
              </g>
            )
          })}
          {graph.nodes.map(n => {
            const col = groupColor(n.c.group)
            const selected = sel?.kind === 'character' && sel.name === n.id
            const op = nb ? (nb.has(n.id) ? 1 : C.dim) : 1
            return (
              <g key={n.id} data-node className="mm-gnode" opacity={op} transform={`translate(${n.x},${n.y})`}
                onPointerDown={e => dragNode(e, n)} onPointerEnter={() => setHover(n.id)} onPointerLeave={() => setHover(null)}>
                {(selected || isMatch(n.c)) && <circle r={n.r + 5} fill="none" stroke={selected ? col : C.match} strokeWidth={2.5} />}
                <circle r={n.r} fill={col} stroke={C.panel} strokeWidth={2} />
                <text y={n.r * 0.36} textAnchor="middle" fontSize={n.r * 0.95} fontWeight={600} fill="#fff">{n.id.slice(0, 1)}</text>
                <text y={n.r + 16} textAnchor="middle" fontSize={n.c.role === '主角' ? 14 : 12.5} fontWeight={n.c.role === '次要' ? 400 : 600} fill={C.text}
                  stroke={C.bg} strokeWidth={3} paintOrder="stroke">{n.id}</text>
              </g>
            )
          })}
        </g>
      </svg>
      {groups.length > 1 && (
        <div className="mm-legend">
          {groups.map(g => <span key={g}><i style={{ background: groupColor(g) }} />{g}</span>)}
        </div>
      )}
      <Zoom pz={pz} onFit={() => pz.fitTo(bbox, 50, 1.2)} extra={
        <label className="mm-check" title="显示次要人物"><input type="checkbox" checked={minor} onChange={e => setMinor(e.target.checked)} />次要人物</label>
      } />
      <div className="mm-hint">悬停看关系 · 拖动人物调整位置 · 点击看详情</div>
    </div>
  )
}

// ---------- 详情 ----------
function Detail({ map, doc, sel, setSel, resolve, index, onLocate, record }) {
  const Link = ({ name }) => {
    const r = resolve(name)
    return r ? <button className="mm-link" onClick={() => setSel(r)}>{name}</button> : <span className="mm-plain">{name}</span>
  }
  // 外文书里人名、概念是译名：用原文里真正出现的写法去搜
  const locate = (name, alts = []) => onLocate && (
    <button className="btn btn-sm mm-locate" onClick={async () => {
      const names = [name, ...alts].filter(Boolean)
      let term = names[0]
      try {
        const { parts } = await bookText(record)
        term = names.find(n => parts.some(p => p.text.includes(n))) || names.find(n => /[a-z]/i.test(n)) || term
      } catch {}
      onLocate(term)
    }}><Search size={13} />在书中查找“{name}”</button>
  )
  const ranges = chunks => {
    const list = [...new Set((chunks || []).map(i => doc?.ranges?.[i]).filter(Boolean))]
    return list.length ? list : null
  }

  let body
  if (!sel || sel.kind === 'book') {
    const n = { c: map.characters?.length || 0, r: map.relations?.length || 0, k: (map.conceptCategories || []).reduce((s, c) => s + c.items.length, 0), e: map.timeline?.length || 0 }
    body = (
      <>
        <div className="mm-d-kind">全书概览{map.genre ? ` · ${map.genre}` : ''}</div>
        <div className="mm-d-name">《{record.title}》</div>
        {record.author && <div className="mm-d-alias">{record.author}</div>}
        <div className="mm-stats tabular">
          <div><b>{n.c}</b>人物</div><div><b>{n.r}</b>关系</div><div><b>{n.k}</b>概念</div><div><b>{n.e}</b>情节</div>
        </div>
        {map.summary ? <p className="mm-d-desc">{map.summary}</p> : <p className="mm-d-desc muted">全书概述会在 AI 读完整本书、整合之后出现。</p>}
        {map.themes?.length > 0 && <Section title="主题">{map.themes.map(t => <div key={t.name} className="mm-d-item"><button className="mm-link" onClick={() => setSel({ kind: 'theme', name: t.name })}>{t.name}</button><span>{t.desc}</span></div>)}</Section>}
        {map.characters?.some(c => c.role === '主角') && <Section title="主角"><div className="mm-tags">{map.characters.filter(c => c.role === '主角').map(c => <Link key={c.name} name={c.name} />)}</div></Section>}
        <div className="mm-d-foot muted">{doc?.model ? `由 ${doc.model} 生成` : ''}{doc?.updatedAt ? ` · ${new Date(doc.updatedAt).toLocaleString()}` : ''}</div>
      </>
    )
  } else if (sel.kind === 'character') {
    const c = index.get('character:' + sel.name)
    if (c) {
      const rels = (map.relations || []).filter(r => r.from === c.name || r.to === c.name)
      const rg = ranges(c.chunks)
      body = (
        <>
          <div className="mm-d-kind">人物</div>
          <div className="mm-d-name">{c.role === '主角' && <Star size={15} fill="#ffb800" color="#ffb800" />}{c.name}</div>
          {c.aliases?.length > 0 && <div className="mm-d-alias">又称：{c.aliases.join('、')}</div>}
          <div className="mm-tags"><span className="mm-tag blue">{c.role}</span>{c.group && <button className="mm-tag" onClick={() => setSel({ kind: 'group', name: c.group })}>{c.group}</button>}</div>
          {c.desc && <p className="mm-d-desc">{c.desc}</p>}
          {c.traits?.length > 0 && <Section title="性格 / 特点"><div className="mm-tags">{c.traits.map(t => <span key={t} className="mm-tag">{t}</span>)}</div></Section>}
          {c.arc && <Section title="经历"><p className="mm-d-desc">{c.arc}</p></Section>}
          {rels.length > 0 && (
            <Section title={`人物关系（${rels.length}）`}>
              {rels.map((r, i) => {
                const other = r.from === c.name ? r.to : r.from
                return <div key={i} className="mm-d-item"><Link name={other} /><span className="mm-rel">{r.type}</span>{r.desc && <span>{r.desc}</span>}</div>
              })}
            </Section>
          )}
          {rg && <Section title="主要出现在"><div className="mm-ranges">{rg.slice(0, 8).map(r => <span key={r}>{r}</span>)}{rg.length > 8 && <span>等 {rg.length} 处</span>}</div></Section>}
          {locate(c.name, c.aliases)}
        </>
      )
    }
  } else if (sel.kind === 'group') {
    const g = (map.groups || []).find(g => g.name === sel.name)
    const members = (map.characters || []).filter(c => c.group === sel.name || (sel.name === '其他' && !c.group))
    body = (
      <>
        <div className="mm-d-kind">人物分组</div>
        <div className="mm-d-name">{sel.name}</div>
        {g?.desc && <p className="mm-d-desc">{g.desc}</p>}
        <Section title={`成员（${members.length}）`}>{members.map(c => <div key={c.name} className="mm-d-item"><Link name={c.name} /><span>{c.desc}</span></div>)}</Section>
      </>
    )
  } else if (sel.kind === 'concept') {
    const c = index.get('concept:' + sel.name)
    if (c) body = (
      <>
        <div className="mm-d-kind">概念 · {c.category}</div>
        <div className="mm-d-name">{c.name}</div>
        {c.original && <div className="mm-d-alias">原文：{c.original}</div>}
        {c.desc && <p className="mm-d-desc">{c.desc}</p>}
        {c.related?.length > 0 && <Section title="相关"><div className="mm-tags">{c.related.map(r => <Link key={r} name={r} />)}</div></Section>}
        {locate(c.name, [c.original])}
      </>
    )
  } else if (sel.kind === 'category') {
    const cat = (map.conceptCategories || []).find(c => c.name === sel.name)
    if (cat) body = (
      <>
        <div className="mm-d-kind">概念分类</div>
        <div className="mm-d-name">{cat.name}</div>
        <Section title={`包含（${cat.items.length}）`}>{cat.items.map(i => <div key={i.name} className="mm-d-item"><Link name={i.name} /><span>{i.desc}</span></div>)}</Section>
      </>
    )
  } else if (sel.kind === 'theme') {
    const t = index.get('theme:' + sel.name)
    if (t) body = <><div className="mm-d-kind">主题</div><div className="mm-d-name">{t.name}</div><p className="mm-d-desc">{t.desc}</p></>
  } else if (sel.kind === 'place') {
    const p = index.get('place:' + sel.name)
    if (p) body = <><div className="mm-d-kind">地点</div><div className="mm-d-name">{p.name}</div>{p.original && <div className="mm-d-alias">原文：{p.original}</div>}<p className="mm-d-desc">{p.desc}</p>{locate(p.name, [p.original])}</>
  } else if (sel.kind === 'event') {
    const e = map.timeline?.[sel.index]
    if (e) body = (
      <>
        <div className="mm-d-kind">情节脉络 · 第 {sel.index + 1} 个节点</div>
        <div className="mm-d-name">{e.title}</div>
        {(e.chapter || e.range) && <div className="mm-d-alias">{e.chapter || e.range}</div>}
        {e.desc && <p className="mm-d-desc">{e.desc}</p>}
        {e.people?.length > 0 && <Section title="涉及人物"><div className="mm-tags">{e.people.map(p => <Link key={p} name={p} />)}</div></Section>}
        <div className="mm-step">
          <button className="btn btn-sm" disabled={!sel.index} onClick={() => setSel({ kind: 'event', index: sel.index - 1 })}>上一个</button>
          <button className="btn btn-sm" disabled={sel.index >= map.timeline.length - 1} onClick={() => setSel({ kind: 'event', index: sel.index + 1 })}>下一个</button>
        </div>
        {e.chapter && locate(e.chapter)}
      </>
    )
  }
  if (!body) body = <div className="muted">这一项在最新的导图里已经没有了。</div>
  return (
    <aside className="mm-detail">
      {sel && sel.kind !== 'book' && <button className="mm-back" onClick={() => setSel(null)}>← 全书概览</button>}
      {body}
    </aside>
  )
}

const Section = ({ title, children }) => <div className="mm-sec"><div className="mm-sec-t">{title}</div>{children}</div>

// ---------- 导出 ----------
function standaloneSVG(svg, C) {
  const g = svg.querySelector('g')
  const bbox = JSON.parse(g.dataset.bbox)
  const pad = 40
  const w = Math.ceil(bbox.w + pad * 2), h = Math.ceil(bbox.h + pad * 2)
  const clone = g.cloneNode(true)
  clone.setAttribute('transform', `translate(${pad - bbox.x},${pad - bbox.y})`)
  clone.removeAttribute('data-bbox')
  clone.querySelectorAll('.mm-fold').forEach(el => { if (!el.querySelector('text')) el.remove() })
  const fontFamily = getComputedStyle(document.body).fontFamily.replace(/"/g, "'")
  const text = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="${fontFamily}">` +
    `<rect width="100%" height="100%" fill="${C.bg}"/>${new XMLSerializer().serializeToString(clone)}</svg>`
  return { text, w, h }
}

async function svgToPng(text, w, h) {
  const scale = Math.min(2, 12000 / Math.max(w, h))
  const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }))
  try {
    const img = new Image()
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('图片渲染失败')); img.src = url })
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale)
    const ctx = canvas.getContext('2d')
    ctx.scale(scale, scale)
    ctx.drawImage(img, 0, 0, w, h)
    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'))
    return new Uint8Array(await blob.arrayBuffer())
  } finally {
    URL.revokeObjectURL(url)
  }
}
