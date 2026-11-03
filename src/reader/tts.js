// 朗读：系统语音合成，逐句朗读当前页，读完自动翻页继续

export function listVoices() {
  return speechSynthesis.getVoices()
}

function splitSentences(text) {
  const out = []
  for (const part of text.replace(/\s+/g, ' ').split(/(?<=[。！？!?；;…]|\.\s)/)) {
    const s = part.trim()
    if (!s) continue
    // 过长的句子再按逗号切开，避免语音引擎中途停止
    if (s.length > 160) out.push(...s.split(/(?<=[，,、])/).map(x => x.trim()).filter(Boolean))
    else out.push(s)
  }
  return out
}

export class Narrator {
  constructor({ getPageText, nextPage, onState }) {
    this.getPageText = getPageText
    this.nextPage = nextPage
    this.onState = onState
    this.rate = 1
    this.voiceURI = null
    this.playing = false
    this.token = 0
  }
  pickVoice(lang = 'zh') {
    const voices = listVoices()
    return voices.find(v => v.voiceURI === this.voiceURI)
      || voices.find(v => v.lang.toLowerCase().startsWith(lang))
      || voices[0]
  }
  async start() {
    this.playing = true
    this.onState(true)
    const token = ++this.token
    while (this.playing && token === this.token) {
      const text = await this.getPageText()
      const lang = /[一-龥]/.test(text) ? 'zh' : 'en'
      for (const s of splitSentences(text)) {
        if (!this.playing || token !== this.token) return
        await this.speak(s, lang)
      }
      if (!this.playing || token !== this.token) return
      const moved = await this.nextPage()
      if (!moved) break
    }
    this.stop()
  }
  speak(text, lang) {
    return new Promise(resolve => {
      const u = new SpeechSynthesisUtterance(text)
      u.rate = this.rate
      const v = this.pickVoice(lang)
      if (v) u.voice = v
      u.onend = u.onerror = () => resolve()
      speechSynthesis.speak(u)
    })
  }
  stop() {
    this.playing = false
    this.token++
    speechSynthesis.cancel()
    this.onState(false)
  }
}
