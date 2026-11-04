// OCR 文字层：扫描版 PDF 没有文字，把识别结果按位置铺成一层透明文字，
// 于是可以选中、复制、高亮、搜索、朗读（逐句高亮）和交给 AI 助手
// page：{ paras: [[{ t: 文字, b: [左, 上, 右, 下] }]] }，坐标是相对整页的比例

const latin = s => /[\x21-\x7e]$/.test(s)

// PDF 自带的文字能不能用：太少（扫描页），或大多是乱码（字体没有编码表时复制出来的
// 私有区字符、替换符、Latin-1 怪字符）都算不能用，交给 OCR
export function usableText(str) {
  const s = String(str || '').replace(/\s+/g, '')
  if (s.length < 8) return false
  const bad = (s.match(/[-�\u0000-\u001FÀ-ÿ]/g) || []).length
  return bad / s.length < 0.3
}

// 这一页 PDF 本身有没有可用的文字（有就不铺 OCR 层）
export const hasPdfText = doc => usableText(doc?.querySelector('.textLayer:not(.ocrLayer)')?.textContent)

// pdf.js 文字层的尺寸写成 calc(var(--total-scale-factor) * 595.5px)，从这里取页面的原始大小（pt）
const pageSize = pdfLayer => {
  const n = v => Number(String(v).match(/\*\s*([\d.]+)px/)?.[1])
  const w = n(pdfLayer?.style.width), h = n(pdfLayer?.style.height)
  return w > 0 && h > 0 ? [w, h] : null
}

// 铺好（或已经铺过）返回 true；页面还没画完返回 false，调用方稍后再试
export function applyOcrLayer(doc, page) {
  if (!doc?.body || !page?.paras?.length || hasPdfText(doc)) return true
  if (doc.querySelector('.ocrLayer')) return true
  const pdfLayer = doc.querySelector('.textLayer:not(.ocrLayer)')
  // 尺寸跟 pdf.js 自己的文字层一样用 --total-scale-factor 表示，缩放、改窗口大小、
  // 屏幕缩放比不是 100% 时都自动跟着画布走，不用重铺
  const size = pageSize(pdfLayer)
  if (!size) return false
  const [PW, PH] = size
  // 原来的文字层是乱码时藏起来，免得选中的是乱码
  if (pdfLayer.textContent.trim()) pdfLayer.style.display = 'none'
  const layer = doc.createElement('div')
  layer.className = 'textLayer ocrLayer' // 沿用 pdf.js 文字层的样式：透明、可选中
  const px = v => `calc(var(--total-scale-factor) * ${v.toFixed(3)}px)`
  layer.style.cssText = `inset:auto;left:0;top:0;width:${px(PW)};height:${px(PH)}`
  const spans = []
  for (const para of page.paras) {
    // 每段一个块，朗读切句时段落分开；用 pdf.js 的 markedContent（display: contents），
    // 否则 pdf.js 会给文字层的直接子元素加 transform，把里面的行都挤到页顶
    const p = doc.createElement('div')
    p.className = 'markedContent'
    for (const { t, b } of para) {
      const s = doc.createElement('span')
      s.textContent = latin(t) ? t + ' ' : t
      s.style.cssText = `left:${b[0] * 100}%;top:${b[1] * 100}%;font-size:${px((b[3] - b[1]) * PH * 0.9)};line-height:1;font-family:sans-serif`
      p.append(s)
      spans.push([s, b[2] - b[0]])
    }
    p.append(doc.createElement('br')) // 复制出来的文字保留分段
    layer.append(p)
  }
  doc.body.append(layer)
  // 每行横向拉伸到原文的宽度，选中范围和高亮才对得上（比例和缩放无关，算一次就行）
  const W = layer.offsetWidth
  if (!W) { layer.remove(); return false }
  for (const [s, w] of spans) {
    const natural = s.offsetWidth
    if (natural > 0 && w > 0) s.style.transform = `scaleX(${(w * W) / natural})`
  }
  return true
}

export function removeOcrLayer(doc) { doc?.querySelector('.ocrLayer')?.remove() }

// 一页的纯文字（给 AI 和搜索用）
export const ocrPageText = page => (page?.paras || [])
  .map(para => para.reduce((s, l) => s + (s && latin(s) ? ' ' : '') + l.t, ''))
  .join('\n')
