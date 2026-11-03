// 朗读：逐句朗读并高亮正在读的句子，页面跟着翻；朗读中双击某句即从那里读起
//   f5：F5-TTS 本地大模型（与“静听”同一模型），边播边预合成后面几段，几乎无停顿
//   system：系统语音合成（不需要任何环境，但比较机械）

export function listVoices() {
  return speechSynthesis.getVoices()
}

const SENT_END = /[。！？!?；;….]["”’』」）)]*$/
const END_CH = /[。！？!?；;…]/
const CLOSERS = /["”’』」）)]/
const BLOCK = /^(P|DIV|H[1-6]|LI|BLOCKQUOTE|SECTION|ARTICLE|ASIDE|HEADER|FOOTER|TD|TH|DT|DD|PRE|FIGCAPTION|TR|BODY|HTML)$/
const SKIP = /^(SCRIPT|STYLE|RT|RP|NOSCRIPT)$/
const latinGap = (a, b) => /[\x21-\x7e]$/.test(a) && /^[\x21-\x7e]/.test(b) ? ' ' : '' // 英文句子之间留空格

// 纯文本按句切开；过长的句子按逗号再切，实在没有标点就硬切
export function splitSentences(text, maxLen = 110) {
  const sents = []
  for (let para of text.split(/\n+/)) {
    para = para.replace(/\s+/g, ' ').trim()
    if (!para) continue
    for (const part of para.split(/(?<=[。！？!?；;…]["”’』」）)]*|\.\s)/)) {
      const s = part.trim()
      if (!s) continue
      if (s.length <= maxLen) { sents.push(s); continue }
      let buf = ''
      for (const piece of s.split(/(?<=[，,、：:])/)) {
        if (buf && buf.length + piece.length > maxLen) { sents.push(buf); buf = '' }
        buf += piece
        while (buf.length > maxLen) { sents.push(buf.slice(0, maxLen)); buf = buf.slice(maxLen) }
      }
      if (buf) sents.push(buf)
    }
    // 标题等没有句末标点的行，补一个句号让语音停顿
    const last = sents.length - 1
    if (last >= 0 && !SENT_END.test(sents[last]) && !/[，,、：:]$/.test(sents[last])) sents[last] += /[\x21-\x7e]$/.test(sents[last]) ? '.' : '。'
  }
  return sents
}

// 把句子合并成不超过 maxLen 的朗读段：段太短语气碎，太长合成慢
// firstMax：第一段单独限长，翻页后第一段合成得快，停顿短；merge=false 时一句一段
function groupSegments(items, maxLen, firstMax = maxLen, merge = true) {
  const out = []
  let cur = null
  for (const item of items) {
    const pieces = item.text.length > maxLen ? splitSentences(item.text, maxLen) : [item.text]
    for (const text of pieces) {
      const limit = out.length ? maxLen : firstMax
      if (cur && (!merge || cur.text.length + text.length > limit)) { out.push(cur); cur = null }
      if (!cur) cur = { text: '', parts: [] }
      cur.text += latinGap(cur.text, text) + text
      cur.parts.push({ text, range: item.range })
    }
  }
  if (cur) out.push(cur)
  return out
}

export const splitSegments = (text, maxLen = 110, firstMax = maxLen) =>
  groupSegments(splitSentences(text, maxLen).map(text => ({ text })), maxLen, firstMax).map(s => s.text)

// 把页面上一段 DOM Range 切成句子，每句带自己的 Range（用于高亮和点击定位）
// openTail：页尾没有句末标点时视为半句（PDF 每页一个文本层，句子常跨页）
export function sentencesFromRange(range, { openTail = false } = {}) {
  const doc = range.startContainer.ownerDocument
  const root = range.commonAncestorContainer
  const walker = doc.createTreeWalker(root.nodeType === 3 ? root.parentNode : root, NodeFilter.SHOW_TEXT)
  const out = []
  let cur = null, block, ended = false
  const blockOf = node => { let n = node.parentElement; while (n && !BLOCK.test(n.tagName)) n = n.parentElement; return n }
  const flush = blockEnd => {
    if (cur && cur.text.trim()) {
      const r = doc.createRange()
      r.setStart(cur.sn, cur.so)
      r.setEnd(cur.en, cur.eo)
      let text = cur.text.replace(/\s+/g, ' ').trim()
      if (blockEnd && !SENT_END.test(text) && !/[，,、：:]$/.test(text)) text += /[\x21-\x7e]$/.test(text) ? '.' : '。'
      out.push({ text, range: r })
    }
    cur = null
    ended = false
  }
  let node
  while ((node = walker.nextNode())) {
    if (!range.intersectsNode(node) || SKIP.test(node.parentElement?.tagName)) continue
    const b = blockOf(node)
    if (b !== block) { flush(true); block = b }
    const data = node.data
    const start = node === range.startContainer ? range.startOffset : 0
    const end = node === range.endContainer ? range.endOffset : data.length
    for (let i = start; i < end; i++) {
      const ch = data[i]
      if (ended && !CLOSERS.test(ch)) {
        // “.”后面紧跟字母数字（3.14、e.g.）不算句末
        if (cur.text.trimEnd().endsWith('.') && !/\s/.test(ch)) ended = false
        else flush(false)
      }
      if (!cur) {
        if (/\s/.test(ch)) continue
        cur = { text: '', sn: node, so: i }
      }
      cur.text += ch
      cur.en = node
      cur.eo = i + 1
      if (END_CH.test(ch) || ch === '.') ended = true
    }
  }
  // 页尾的半句话：留给下一页和后半句一起读
  let tailOpen = false
  if (cur && cur.text.trim() && !SENT_END.test(cur.text.trim())) {
    if (openTail) tailOpen = true
    else if (block) {
      const rest = doc.createRange()
      rest.setStart(range.endContainer, range.endOffset)
      rest.setEndAfter(block.lastChild || block)
      tailOpen = !!rest.toString().trim()
    }
  }
  flush(!tailOpen)
  if (tailOpen) out.at(-1).incomplete = true
  return out
}

// 正在朗读的句子：用 CSS Custom Highlight 标出来，不改动书页 DOM
const HL = 'air-tts'
let hlWin = null
export function highlightRange(range) {
  try { hlWin?.CSS?.highlights?.delete(HL) } catch {}
  hlWin = null
  const doc = range?.startContainer?.ownerDocument
  const win = doc?.defaultView
  if (!win?.CSS?.highlights || !win.Highlight) return
  if (!doc.getElementById('air-tts-style')) {
    const st = doc.createElement('style')
    st.id = 'air-tts-style'
    st.textContent = `::highlight(${HL}) { background-color: rgba(10, 132, 255, 0.22); }`
    ;(doc.head || doc.documentElement).append(st)
  }
  win.CSS.highlights.set(HL, new win.Highlight(range))
  hlWin = win
}

// 朗读器。内容来源 source 由阅读器提供：
//   first(from) → { items, ... }   从 from（{ node, offset }，缺省为当前页开头）所在的句子起，到本块结尾
//   next(chunk) → 下一块（下一章 / 下一页），没有了返回 null
//   peek(chunk) → 下一块开头的句子（不翻页），用于提前合成，可省略
//   follow(range) → 正在读的句子不在屏幕上时翻过去，可省略
// 可重排的书按“章”连续朗读、页面跟着高亮走，翻页不停顿；PDF 按页朗读
export class Narrator {
  constructor({ source, onState, getSettings, onNotice }) {
    this.source = source
    this.onState = onState
    this.getSettings = getSettings
    this.onNotice = onNotice || (() => {})
    this.playing = false
    this.token = 0
    this.audio = null
    this.endAudio = null
  }

  get cfg() { return this.getSettings() }

  highlight(range) {
    highlightRange(range)
    if (range) try { this.source.follow?.(range) } catch {}
  }

  async start(from = null) {
    this.stopPlayback()
    this.playing = true
    this.onState(true)
    const token = ++this.token
    const alive = () => this.playing && token === this.token
    let engine = this.cfg.engine === 'f5' ? 'f5' : 'system'
    if (engine === 'f5') {
      const st = await window.api.ttsStatus().catch(e => ({ found: true, error: e.message }))
      if (!alive()) return
      if (!st.found || st.error) {
        this.onNotice(st.found ? `F5-TTS 启动失败，改用系统语音：${st.error}` : '没有找到 F5-TTS 环境，改用系统语音（可在设置 → 朗读里指定）', 'error')
        engine = 'system'
      } else if (!st.loaded) this.onNotice('正在加载 F5-TTS 语音模型，首次大约需要 20 秒…')
    }
    let chunk = await this.source.first(from)
    let carry = ''
    while (alive() && chunk) {
      let items = chunk.items
      const prevCarry = carry
      if (carry) items = items.length ? [{ ...items[0], text: carry + items[0].text }, ...items.slice(1)] : [{ text: carry }]
      carry = ''
      if (items.length > 1 && items.at(-1).incomplete) carry = items.pop().text // PDF 页尾半句并入下一页
      const current = chunk
      try {
        if (engine === 'f5') await this.playF5(groupSegments(items, 110, 40), alive, () => this.prefetchNext(current))
        else for (const seg of groupSegments(items, 160, 160, false)) { if (!alive()) return; await this.speakSystem(seg) }
      } catch (e) {
        if (!alive()) return
        this.onNotice(`F5-TTS 合成失败，改用系统语音：${String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`, 'error')
        engine = 'system'
        carry = prevCarry // 用系统语音重读这一块
        continue
      }
      if (!alive()) return
      highlightRange(null)
      chunk = await this.source.next(current)
      if (!alive()) return
      if (!chunk && carry) {
        const seg = { text: carry, parts: [{ text: carry }] }
        await (engine === 'f5' ? this.playF5([seg], alive) : this.speakSystem(seg))
      }
    }
    if (token === this.token) this.stop()
  }

  // 本块快读完时，把下一章开头两段先合成好（结果缓存在服务端，到时直接取）
  prefetchNext(chunk) {
    if (!this.source.peek || chunk.prefetched) return
    chunk.prefetched = true
    Promise.resolve(this.source.peek(chunk)).then(items => {
      if (!items?.length) return
      for (const seg of groupSegments(items, 110, 40).slice(0, 2)) window.api.ttsSynth(seg.text).catch(() => {})
    }).catch(() => {})
  }

  // 预先合成后面两段，当前段一播完下一段就已就绪；剩最后两段时开始准备下一块
  async playF5(segs, alive, nearEnd) {
    const jobs = []
    const fetchSeg = i => {
      if (i < segs.length && !jobs[i]) {
        jobs[i] = window.api.ttsSynth(segs[i].text)
        jobs[i].catch(() => {})
      }
    }
    for (let i = 0; i < segs.length; i++) {
      fetchSeg(i)
      fetchSeg(i + 1)
      fetchSeg(i + 2)
      if (i >= segs.length - 2) nearEnd?.()
      this.highlight(segs[i].parts[0].range) // 合成等待时先标出要读的句子
      const data = await jobs[i]
      if (!alive()) return
      await this.playAudio(data, segs[i].parts)
      if (!alive()) return
    }
  }

  // 一段里有几句：按字数比例估算每句的时间，播到哪句高亮哪句
  playAudio(data, parts) {
    return new Promise(resolve => {
      const url = URL.createObjectURL(new Blob([data], { type: 'audio/wav' }))
      const audio = new Audio(url)
      audio.preservesPitch = true // 变速不变调
      audio.playbackRate = this.cfg.rate || 1
      const total = parts.reduce((n, p) => n + p.text.length, 0) || 1
      let shown = -1
      const sync = () => {
        const frac = audio.duration ? audio.currentTime / audio.duration : 0
        let acc = 0, idx = parts.length - 1
        for (let k = 0; k < parts.length; k++) { acc += parts[k].text.length; if (frac < acc / total) { idx = k; break } }
        if (idx !== shown && parts[idx].range !== parts[shown]?.range) this.highlight(parts[idx].range)
        shown = idx
      }
      let finished = false
      const done = () => {
        if (finished) return
        finished = true
        URL.revokeObjectURL(url)
        if (this.audio === audio) { this.audio = null; this.endAudio = null }
        resolve()
      }
      audio.ontimeupdate = sync
      audio.onplay = sync
      audio.onended = audio.onerror = done
      this.audio = audio
      this.endAudio = done
      audio.play().catch(done)
    })
  }

  speakSystem(seg) {
    return new Promise(resolve => {
      this.highlight(seg.parts[0].range)
      const u = new SpeechSynthesisUtterance(seg.text)
      u.rate = this.cfg.rate || 1
      const lang = /[一-龥]/.test(seg.text) ? 'zh' : 'en'
      const voices = listVoices()
      const v = voices.find(x => x.voiceURI === this.cfg.systemVoice)
        || voices.find(x => x.lang.toLowerCase().startsWith(lang))
      if (v) u.voice = v
      u.onend = u.onerror = () => resolve()
      speechSynthesis.speak(u)
    })
  }

  // 朗读中调整语速立即生效
  setRate(rate) {
    if (this.audio) this.audio.playbackRate = rate
  }

  stopPlayback() {
    this.token++
    window.api.ttsCancel?.()
    speechSynthesis.cancel()
    this.audio?.pause()
    this.endAudio?.()
    highlightRange(null)
  }

  stop() {
    this.playing = false
    this.stopPlayback()
    this.onState(false)
  }
}

// 从 items 里找到包含 from 位置的句子，返回从这句开始的列表
export function itemsFrom(items, from) {
  if (!from) return items
  const i = items.findIndex(it => it.range && safeCompare(it.range, from) <= 0)
  return i > 0 ? items.slice(i) : items
}

// 位置在句子之前 / 之中返回 ≤ 0；文档已重排导致 Range 失效时当作在之前
function safeCompare(range, { node, offset }) {
  try { return range.comparePoint(node, offset) } catch { return -1 }
}
