// 朗读：逐段朗读当前页，读完自动翻页继续
//   f5：F5-TTS 本地大模型（与“静听”同一模型），边播边预合成后面几段，几乎无停顿
//   system：系统语音合成（不需要任何环境，但比较机械）

export function listVoices() {
  return speechSynthesis.getVoices()
}

const SENT_END = /[。！？!?；;….]["”’』」）)]*$/

// 按句切开再合并成不超过 maxLen 的段：段太短语气碎，太长合成慢
// firstMax：第一段单独限长，翻页后第一段合成得快，停顿短
export function splitSegments(text, maxLen = 110, firstMax = maxLen) {
  const sents = []
  for (let para of text.split(/\n+/)) {
    para = para.replace(/\s+/g, ' ').trim()
    if (!para) continue
    for (const part of para.split(/(?<=[。！？!?；;…]["”’』」）)]*|\.\s)/)) {
      const s = part.trim()
      if (!s) continue
      if (s.length <= maxLen) sents.push(s)
      else { // 过长的句子按逗号再切，实在没有标点就硬切
        let buf = ''
        for (const piece of s.split(/(?<=[，,、：:])/)) {
          if (buf && buf.length + piece.length > maxLen) { sents.push(buf); buf = '' }
          buf += piece
          while (buf.length > maxLen) { sents.push(buf.slice(0, maxLen)); buf = buf.slice(maxLen) }
        }
        if (buf) sents.push(buf)
      }
    }
    // 标题等没有句末标点的行，补一个句号让语音停顿
    const last = sents.length - 1
    if (last >= 0 && !SENT_END.test(sents[last]) && !/[，,、：:]$/.test(sents[last])) sents[last] += /[!-~]$/.test(sents[last]) ? '.' : '。'
  }
  const out = []
  let cur = ''
  for (const s of sents) {
    if (cur && cur.length + s.length > (out.length ? maxLen : firstMax)) { out.push(cur); cur = '' }
    cur += (/[\x21-\x7e]$/.test(cur) && /^[\x21-\x7e]/.test(s) ? ' ' : '') + s // 英文句子之间留空格
  }
  if (cur) out.push(cur)
  return out
}

export class Narrator {
  constructor({ getPageText, nextPage, onState, getSettings, onNotice }) {
    this.getPageText = getPageText
    this.nextPage = nextPage
    this.onState = onState
    this.getSettings = getSettings
    this.onNotice = onNotice || (() => {})
    this.playing = false
    this.token = 0
    this.audio = null
  }

  get cfg() { return this.getSettings() }

  async start() {
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
    let carry = ''
    while (alive()) {
      const text = carry + await this.getPageText()
      const prevCarry = carry
      carry = ''
      let segs = engine === 'f5' ? splitSegments(text, 110, 40) : splitSegments(text, 160)
      // 页尾半句话留到下一页和后半句一起读，避免断在句中间
      if (segs.length > 1 && !SENT_END.test(text.trim())) {
        const tail = segs.at(-1).replace(/[。.]$/, '') // 去掉 splitSegments 补上的句号
        const cut = Math.max(...[...'。！？!?；;….'].map(c => tail.lastIndexOf(c)))
        carry = tail.slice(cut + 1)
        segs = cut >= 0 ? [...segs.slice(0, -1), tail.slice(0, cut + 1)] : segs.slice(0, -1)
      }
      try {
        if (engine === 'f5') await this.playF5(segs, alive)
        else for (const s of segs) { if (!alive()) return; await this.speakSystem(s) }
      } catch (e) {
        if (!alive()) return
        this.onNotice(`F5-TTS 合成失败，改用系统语音：${String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`, 'error')
        engine = 'system'
        carry = prevCarry // 用系统语音重读这一页
        continue
      }
      if (!alive()) return
      const moved = await this.nextPage()
      if (!moved) {
        if (carry && alive()) await (engine === 'f5' ? this.playF5([carry], alive) : this.speakSystem(carry))
        break
      }
    }
    if (token === this.token) this.stop()
  }

  // 预先合成后面两段，当前段一播完下一段就已就绪
  async playF5(segs, alive) {
    const jobs = []
    const fetchSeg = i => {
      if (i < segs.length && !jobs[i]) {
        jobs[i] = window.api.ttsSynth(segs[i])
        jobs[i].catch(() => {})
      }
      return jobs[i]
    }
    for (let i = 0; i < segs.length; i++) {
      fetchSeg(i)
      fetchSeg(i + 1)
      fetchSeg(i + 2)
      const data = await jobs[i]
      if (!alive()) return
      await this.playAudio(data)
      if (!alive()) return
    }
  }

  playAudio(data) {
    return new Promise(resolve => {
      const url = URL.createObjectURL(new Blob([data], { type: 'audio/wav' }))
      const audio = new Audio(url)
      audio.preservesPitch = true // 变速不变调
      audio.playbackRate = this.cfg.rate || 1
      const done = () => { URL.revokeObjectURL(url); if (this.audio === audio) this.audio = null; resolve() }
      audio.onended = audio.onerror = done
      audio.onpause = () => { if (!this.playing) done() }
      this.audio = audio
      audio.play().catch(done)
    })
  }

  speakSystem(text) {
    return new Promise(resolve => {
      const u = new SpeechSynthesisUtterance(text)
      u.rate = this.cfg.rate || 1
      const lang = /[一-龥]/.test(text) ? 'zh' : 'en'
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

  stop() {
    this.playing = false
    this.token++
    speechSynthesis.cancel()
    this.audio?.pause()
    this.onState(false)
  }
}
