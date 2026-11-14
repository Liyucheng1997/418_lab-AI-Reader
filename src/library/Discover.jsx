import { useEffect, useState } from 'react'
import { Sparkles, RefreshCw, Download, X, ExternalLink, BookOpen, Compass, ChevronDown } from 'lucide-react'
import { useLib } from '../App.jsx'
import { toast } from '../lib/ui.jsx'
import { formatDate, FORMAT_LABEL } from './model.js'
import { Cover } from './Library.jsx'
import { aiReady } from '../lib/ai.js'

const search = {
  douban: q => `https://search.douban.com/book/subject_search?search_text=${encodeURIComponent(q)}`,
  jd: q => `https://search.jd.com/Search?keyword=${encodeURIComponent(q)}`,
}

// 为你推荐：上半部分从书库里没读的书中挑（本地算法，填了 API Key 还可以让 AI 精选）；
// 下半部分是 AI 推荐的书库外的书，通过配置的 Z-Library 书源下载入库
export default function Discover() {
  const lib = useLib()
  const [data, setData] = useState(null)
  const [wish, setWish] = useState('')
  const [loading, setLoading] = useState({ lib: false, ext: false })
  const [error, setError] = useState('')
  const [showBasis, setShowBasis] = useState(false)
  const [libMode, setLibMode] = useState('ai') // ai | local：书库推荐看 AI 精选还是本地算法
  const hasKey = aiReady(lib.settings.ai)
  const busy = loading.lib || loading.ext

  useEffect(() => { window.api.recGet().then(d => { setData(d); setWish(w => w || d.wish || d.lib?.wish || '') }) }, [lib.settings])

  // 书库精选和书库外推荐同时请求，哪个先好就先显示哪个（书库外还要联网查封面，通常慢一些）
  const refresh = async () => {
    if (!hasKey) return lib.openSettings('ai')
    setLoading({ lib: true, ext: true }); setError('')
    const errs = new Set()
    const run = (key, call) => call.then(res => {
      if (res.ok) { setData(res); if (key === 'lib') setLibMode('ai') } else errs.add(res.error)
    }).finally(() => setLoading(l => ({ ...l, [key]: false })))
    await Promise.all([run('lib', window.api.recLibAI(wish)), run('ext', window.api.recRefresh(wish))])
    setData(await window.api.recGet())
    if (errs.size) setError([...errs].join('；'))
  }
  const dismiss = async id => {
    const items = await window.api.recDismiss(id)
    setData(d => ({ ...d, items }))
  }
  const dismissLib = async bookId => setData(await window.api.recLibDismiss(bookId))

  if (!data) return null
  const { items, profile, local } = data
  const byId = new Map(lib.books.map(b => [b.id, b]))
  const unread = b => b && b.status !== 'finished' && (b.progress || 0) < 0.05
  // AI 精选的书开始读了或删掉了就不再显示；剩得太少就回到本地算法
  const aiPicks = (data.lib?.items || []).filter(x => unread(byId.get(x.bookId)))
  const useAI = libMode === 'ai' && aiPicks.length >= 4
  const libItems = (useAI ? aiPicks : local.items).filter(x => byId.has(x.bookId))
  const basis = profile.liked.length
    ? `根据你读过、在读和收藏的 ${profile.liked.length} 本书`
    : '你还没开始读书，先读几本，推荐会越来越准'

  return (
    <>
      <div className="lib-head">
        <div className="titles">
          <div className="crumbs" />
          <div className="lib-title">为你推荐</div>
          <div className="lib-sub">
            {basis}
            {profile.liked.length > 0 && (
              <span className="link rec-basis-toggle" onClick={() => setShowBasis(s => !s)}>
                推荐依据<ChevronDown size={12} style={{ transform: showBasis ? 'rotate(180deg)' : 'none' }} />
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="lib-body">
        {showBasis && (
          <div className="rec-basis">
            {profile.liked.slice(0, 20).map(r => (
              <span key={r.id} className="rec-chip" title={r.author}>《{r.title}》<em>{r.state}</em></span>
            ))}
          </div>
        )}

        <form className="rec-ask" onSubmit={e => { e.preventDefault(); refresh() }}>
          <Sparkles size={16} className="ico" />
          <input value={wish} onChange={e => setWish(e.target.value)} disabled={busy}
            placeholder="想读点什么？可以不填，比如“轻松一点的历史”“和《人类简史》类似的”" />
          <button className="btn btn-primary" disabled={busy}>
            {busy ? <><span className="spinner" />正在挑书…</> : items.length || aiPicks.length ? <><RefreshCw size={15} />换一批</> : <><Sparkles size={15} />AI 推荐</>}
          </button>
        </form>

        {!hasKey && (
          <div className="rec-note">书库推荐在本地计算，不用联网；AI 精选和书库外的新书需要 Claude 订阅或 API Key，请先在设置里配置。
            <span className="link" onClick={() => lib.openSettings('ai')}>去设置</span>
          </div>
        )}
        {error && <div className="rec-note error">{error}</div>}

        <div className="rec-section-head">
          <div>
            <div className="rec-section-title">书库里值得先读</div>
            <div className="rec-section-sub">
              从书库 {local.unread} 本还没读的书里挑 · {useAI
                ? `AI 精选${data.lib.wish ? `「${data.lib.wish}」` : ''}，更新于 ${formatDate(data.lib.at)}`
                : '按作者、系列和文件夹兴趣在本地计算'}
            </div>
          </div>
          {aiPicks.length >= 4 && (
            <div className="seg">
              <button className={useAI ? 'active' : ''} onClick={() => setLibMode('ai')}>AI 精选</button>
              <button className={!useAI ? 'active' : ''} onClick={() => setLibMode('local')}>本地算法</button>
            </div>
          )}
        </div>
        {libItems.length ? (
          <div className={`rec-grid ${loading.lib ? 'dim' : ''}`}>
            {libItems.map((it, i) => (
              <LibCard key={it.bookId} book={byId.get(it.bookId)} reason={it.reason} index={i} onDismiss={() => dismissLib(it.bookId)} />
            ))}
          </div>
        ) : (
          <div className="rec-empty">{local.seeds ? '书库里暂时没有找到和你口味相近、还没读的书。' : '先读几本书、收藏或划线，就能从书库里给你挑下一本。'}</div>
        )}

        <div className="rec-section-head">
          <div>
            <div className="rec-section-title">书库外的新书</div>
            <div className="rec-section-sub">
              AI 推荐 · Z-Library 书源 · 一键下载加入书库{data.at > 0 && ` · 更新于 ${formatDate(data.at)}`}
            </div>
          </div>
          <button className="btn btn-sm" onClick={() => lib.openSettings('sources')}>{data.source?.configured ? '书源设置' : '连接 Z-Library'}</button>
        </div>
        {items.length === 0 ? (
          <div className="rec-empty">
            <Compass size={16} className="ico" />
            {hasKey ? '点上面的“AI 推荐”，看看书库以外还有哪些适合你的书。' : '配置好 AI（Claude 订阅或 API Key）后，会推荐书库以外适合你的书。'}
          </div>
        ) : (
          <div className={`rec-grid ${loading.ext ? 'dim' : ''}`}>
            {items.map((it, i) => <RecCard key={it.id} item={it} index={i} source={data.source} onDismiss={() => dismiss(it.id)} />)}
          </div>
        )}
      </div>
    </>
  )
}

function LibCard({ book, reason, index, onDismiss }) {
  const lib = useLib()
  return (
    <div className="rec-card" style={{ animationDelay: Math.min(index, 12) * 30 + 'ms' }}>
      <div className="rec-cover clickable" onClick={() => lib.openBook(book.id)}><Cover book={book} /></div>
      <div className="rec-info">
        <div className="rec-top">
          <div className="rec-title">{book.title}</div>
          <button className="icon-btn rec-x" title="不感兴趣" onClick={onDismiss}><X size={15} /></button>
        </div>
        <div className="rec-meta">{[book.author, FORMAT_LABEL[book.format]].filter(Boolean).join(' · ')}{book.cloud && ' · 在云端'}</div>
        <div className="rec-reason">{reason}</div>
        <div className="rec-actions">
          <button className="btn btn-sm btn-primary" onClick={() => lib.openBook(book.id)}><BookOpen size={14} />开始阅读</button>
        </div>
      </div>
    </div>
  )
}

function RecCard({ item, index, source, onDismiss }) {
  const lib = useLib()
  const [busy, setBusy] = useState(false)
  const [bookId, setBookId] = useState(item.bookId)
  const [imgOk, setImgOk] = useState(true)
  const inLib = bookId && lib.books.some(b => b.id === bookId)
  const q = `${item.title} ${item.author}`.trim()
  const version = item.free?.source === 'Z-Library' ? item.free : null

  const download = async () => {
    setBusy(true)
    try {
      const res = await window.api.recDownload(item.id)
      lib.setBooks(res.books)
      setBookId(res.bookId)
      toast(res.added.length ? `《${item.title}》已下载到书库` : '这本书已在书库中', 'success')
    } catch (e) {
      toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error')
    } finally { setBusy(false) }
  }

  return (
    <div className="rec-card" style={{ animationDelay: Math.min(index, 12) * 30 + 'ms' }}>
      <div className="rec-cover">
        {item.cover && imgOk
          ? <img src={item.cover} alt="" referrerPolicy="no-referrer" onError={() => setImgOk(false)} />
          : <div className="cover-ph"><div className="ph-title">{item.title}</div>{item.author && <div className="ph-author">{item.author}</div>}</div>}
      </div>
      <div className="rec-info">
        <div className="rec-top">
          <div className="rec-title">{item.title}</div>
          <button className="icon-btn rec-x" title="不感兴趣" disabled={busy} onClick={onDismiss}><X size={15} /></button>
        </div>
        <div className="rec-meta">
          {[item.author, item.year].filter(Boolean).join(' · ')}
          {item.originalTitle && item.originalTitle !== item.title && <span className="rec-orig"> {item.originalTitle}</span>}
        </div>
        <div className="rec-tags">
          {item.kind === 'explore' && <span className="rec-tag explore">拓展视野</span>}
          {item.tags.map(t => <span key={t} className="rec-tag">{t}</span>)}
        </div>
        <div className="rec-reason">{item.reason}</div>
        {version && <div className="rec-meta">{[version.format?.toUpperCase(), version.lang, version.size].filter(Boolean).join(' · ')}</div>}
        {source?.configured && item.sourceError && <div className="rec-meta" title={item.sourceError}>书源暂不可用，点击下载可重试</div>}
        <div className="rec-actions">
          {inLib ? (
            <button className="btn btn-sm btn-primary" onClick={() => lib.openBook(bookId)}><BookOpen size={14} />开始阅读</button>
          ) : source?.configured ? (
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={download}
              title={version ? `来自 Z-Library · ${version.format.toUpperCase()} · ${version.lang}` : '查找书名和作者匹配的 EPUB / PDF 版本并下载'}>
              {busy ? <span className="spinner" /> : <Download size={14} />}{busy ? '下载入库中…' : version ? '一键下载' : '查找并下载'}
            </button>
          ) : <button className="btn btn-sm btn-primary" onClick={() => lib.openSettings('sources')}>连接书源</button>}
          <button className="btn btn-sm" onClick={() => window.api.openExternal(search.douban(q))}><ExternalLink size={13} />豆瓣</button>
          <button className="btn btn-sm" onClick={() => window.api.openExternal(search.jd(q))}><ExternalLink size={13} />京东</button>
        </div>
      </div>
    </div>
  )
}
