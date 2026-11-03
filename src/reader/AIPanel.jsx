import { useEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { Sparkles, X, Trash2, Settings, ArrowUp, Square, Copy, NotebookPen, RotateCcw, Quote, KeyRound } from 'lucide-react'
import { useLib } from '../App.jsx'
import { toast, confirmDialog } from '../lib/ui.jsx'

const uid = () => Math.random().toString(36).slice(2, 10)

const QUICK = [
  ['summary', '总结本章'],
  ['page', '讲解本页'],
  ['concepts', '关键概念'],
  ['questions', '思考题'],
]

function prompts(lang) {
  return {
    explain: q => `请解释下面这段文字：它是什么意思、在上下文中起什么作用；如果涉及术语、典故、人物或背景知识，也一并说明。\n\n「${q}」`,
    translate: q => `请把下面这段文字翻译成${lang}。先给出通顺的译文，再简要说明值得注意的词句和译法。\n\n「${q}」`,
    summary: () => '请总结本章内容：先用 3~6 条要点概括，再写一段 200 字以内的概述。',
    page: () => '请讲解我正在读的这一页：梳理要点，解释其中难懂的地方。',
    concepts: () => '列出本章出现的关键概念、人物或术语，并逐一简要解释。',
    questions: () => '根据本章内容，提出 5 个能帮助我深入思考的问题，每个附一句思考提示。',
  }
}
const LABEL = { explain: 'AI 解释', translate: '翻译', summary: '总结本章', page: '讲解本页', concepts: '关键概念', questions: '思考题' }

const md = text => DOMPurify.sanitize(marked.parse(text || '', { breaks: true }))

export default function AIPanel({ record, request, onRequestHandled, getPageText, getChapterText, chapter, onSaveNote, onClose }) {
  const lib = useLib()
  const ai = lib.settings.ai
  const [msgs, setMsgs] = useState([])
  const [input, setInput] = useState('')
  const [ctxMode, setCtxMode] = useState('chapter')
  const [busy, setBusy] = useState(null)
  const [quote, setQuote] = useState(null)
  const listRef = useRef()
  const inputRef = useRef()
  const handled = useRef(null)
  const msgsRef = useRef([])
  msgsRef.current = msgs
  const P = useMemo(() => prompts(ai.targetLang), [ai.targetLang])

  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    window.api.getChat(record.id).then(m => {
      const list = m.filter(x => !x.pending)
      msgsRef.current = list
      setMsgs(list)
      setLoaded(true)
    })
  }, [record.id])
  useEffect(() => {
    const el = listRef.current
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight
  }, [msgs])

  // 来自选中文字的请求（AI 解释 / 翻译）
  useEffect(() => {
    if (!loaded || !request || handled.current === request.id) return
    handled.current = request.id
    onRequestHandled()
    const q = { text: request.text, cfi: request.cfi, index: request.index }
    if (!ai.apiKey) { setQuote(q); return }
    send({ action: request.action, quote: q })
  }, [request, loaded])

  const persist = list => window.api.setChat(record.id, list.filter(m => !m.pending).slice(-200))

  async function buildContext(action) {
    const mode = action === 'page' ? 'page' : ['summary', 'concepts', 'questions'].includes(action) ? 'chapter' : ctxMode
    if (mode === 'none') return { text: '', label: '' }
    if (mode === 'page') return { text: (await getPageText()).slice(0, ai.contextChars), label: '当前页' }
    return { text: await getChapterText(ai.contextChars), label: chapter ? `本章：${chapter}` : '本章' }
  }

  async function send({ action, text, quote: q }) {
    if (busy) return
    const userText = action ? P[action](q?.text || '') : q ? `关于这段文字：「${q.text}」\n\n${text}` : text
    const display = action ? LABEL[action] : text
    const user = { id: uid(), role: 'user', content: userText, display, quote: q?.text, action }
    const asst = { id: uid(), role: 'assistant', content: '', pending: true, quote: q?.text, cfi: q?.cfi, index: q?.index }
    setMsgs(m => [...m, user, asst])
    setInput(''); setQuote(null)
    requestAnimationFrame(() => { if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight })

    const ctx = await buildContext(action)
    const system = [
      `你是「AI Reader」里的阅读助手，正在陪用户阅读《${record.title}》${record.author ? `（作者：${record.author}）` : ''}。`,
      '默认用简体中文回答（翻译任务或用户另有要求除外）。讲解要准确、具体、有条理，可以使用 Markdown 小标题和列表，但不要冗长。',
      '优先依据提供的原文作答；超出原文的内容请标明是补充知识；不确定时直接说明。',
      chapter ? `用户当前所在章节：${chapter}` : '',
      ctx.text ? `\n下面是用户当前阅读位置附近的原文（${ctx.label}）：\n<book_excerpt>\n${ctx.text}\n</book_excerpt>` : '',
    ].filter(Boolean).join('\n')

    const history = [...msgsRef.current.filter(m => !m.pending && !m.error && m.content), user].slice(-12)
    while (history.length && history[0].role !== 'user') history.shift()
    const reqId = uid()
    setBusy(reqId)
    const off = window.api.onAiDelta((id, t) => {
      if (id === reqId) setMsgs(m => m.map(x => x.id === asst.id ? { ...x, content: x.content + t } : x))
    })
    const res = await window.api.aiChat(reqId, { system, messages: history.map(m => ({ role: m.role, content: m.content })) })
    off()
    setBusy(null)
    setMsgs(m => {
      const next = m.map(x => x.id === asst.id ? { ...x, pending: false, error: res.ok ? null : res.error, stopped: res.aborted } : x)
      persist(next)
      return next
    })
  }

  const submit = () => {
    const t = input.trim()
    if (!t || busy) return
    send({ text: t, quote })
  }
  const retry = m => {
    const i = msgs.findIndex(x => x.id === m.id)
    const u = msgs[i - 1]
    if (!u) return
    const rest = msgs.slice(0, i - 1)
    setMsgs(rest)
    msgsRef.current = rest
    const q = u.quote ? { text: u.quote, cfi: m.cfi, index: m.index } : null
    setTimeout(() => send(u.action ? { action: u.action, quote: q } : { text: u.display, quote: q }))
  }
  const clear = async () => {
    if (!msgs.length) return
    if (!(await confirmDialog({ title: '清空 AI 对话？', message: '这本书的对话记录会被删除。', danger: true, okText: '清空' }))) return
    setMsgs([]); persist([])
  }

  const provider = ai.provider === 'anthropic' ? 'Claude' : ai.model
  return (
    <aside className="r-panel right ai">
      <div className="r-panel-head">
        <span className="ai-mark"><Sparkles size={14} strokeWidth={2.2} /></span>
        <span className="panel-title">AI 助手</span>
        {ai.apiKey && <span className="model-chip" title={ai.model}>{ai.model || provider}</span>}
        <span style={{ flex: 1 }} />
        <button className="icon-btn" title="清空对话" onClick={clear} disabled={!msgs.length || !!busy}><Trash2 size={15} /></button>
        <button className="icon-btn" title="AI 设置" onClick={() => lib.openSettings('ai')}><Settings size={15} /></button>
        <button className="icon-btn" onClick={onClose}><X size={16} /></button>
      </div>

      <div className="ai-list" ref={listRef}>
        {!ai.apiKey && (
          <div className="ai-setup">
            <div className="confirm-icon"><KeyRound size={22} strokeWidth={1.8} /></div>
            <div className="confirm-title">先配置 AI</div>
            <div className="confirm-msg">填入 Claude、DeepSeek、通义千问等任一服务的 API Key，就能让 AI 帮你解释、翻译、总结。</div>
            <button className="btn btn-primary" onClick={() => lib.openSettings('ai')}>打开 AI 设置</button>
          </div>
        )}
        {ai.apiKey && !msgs.length && (
          <div className="ai-welcome">
            <div className="hello">读到哪里，问到哪里。</div>
            <div className="muted">选中书中文字可以直接让我解释或翻译；也可以试试：</div>
            <div className="quick-grid">
              {QUICK.map(([k, l]) => <button key={k} className="quick-card" onClick={() => send({ action: k })}>{l}</button>)}
            </div>
          </div>
        )}
        {msgs.map(m => m.role === 'user' ? (
          <div key={m.id} className="msg user">
            {m.quote && <div className="msg-quote"><Quote size={12} />{m.quote.length > 120 ? m.quote.slice(0, 120) + '…' : m.quote}</div>}
            <div className="bubble">{m.display}</div>
          </div>
        ) : (
          <div key={m.id} className="msg assistant">
            {m.error ? (
              <div className="msg-error"><span className="status-line err">请求失败</span><div>{m.error}</div></div>
            ) : m.pending && !m.content ? (
              <div className="typing"><i /><i /><i /></div>
            ) : (
              <div className="md" dangerouslySetInnerHTML={{ __html: md(m.content) }} />
            )}
            {!m.pending && (
              <div className="msg-actions">
                {m.content && <button className="icon-btn mini" title="复制" onClick={() => { navigator.clipboard.writeText(m.content); toast('已复制') }}><Copy size={13} /></button>}
                {m.content && <button className="icon-btn mini" title="保存到笔记" onClick={() => onSaveNote(m.content, m.quote, m.cfi, m.index)}><NotebookPen size={13} /></button>}
                <button className="icon-btn mini" title="重新生成" onClick={() => retry(m)} disabled={!!busy}><RotateCcw size={13} /></button>
                {m.stopped && <span className="muted" style={{ fontSize: 11.5 }}>已停止</span>}
              </div>
            )}
          </div>
        ))}
      </div>

      {ai.apiKey && msgs.length > 0 && (
        <div className="quick-row">
          {QUICK.map(([k, l]) => <button key={k} className="chip" disabled={!!busy} onClick={() => send({ action: k })}>{l}</button>)}
        </div>
      )}
      <div className="composer">
        {quote && (
          <div className="composer-quote">
            <Quote size={12} /><span>{quote.text}</span>
            <button className="icon-btn mini" onClick={() => setQuote(null)}><X size={12} /></button>
          </div>
        )}
        <textarea ref={inputRef} rows={2} value={input} disabled={!ai.apiKey}
          placeholder={quote ? '针对这段文字提问…' : '问点什么，回车发送，Shift + 回车换行'}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() } }} />
        <div className="composer-bar">
          <div className="seg small">
            {[['chapter', '附带本章'], ['page', '本页'], ['none', '不附带']].map(([v, l]) => (
              <button key={v} className={ctxMode === v ? 'active' : ''} onClick={() => setCtxMode(v)}>{l}</button>
            ))}
          </div>
          <span style={{ flex: 1 }} />
          {busy ? (
            <button className="send stop" title="停止" onClick={() => window.api.aiAbort(busy)}><Square size={12} fill="currentColor" /></button>
          ) : (
            <button className="send" title="发送" disabled={!input.trim() || !ai.apiKey} onClick={submit}><ArrowUp size={16} strokeWidth={2.4} /></button>
          )}
        </div>
      </div>
    </aside>
  )
}
