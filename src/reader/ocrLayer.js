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

export function applyOcrLayer(doc, page) {
  if (!doc?.body || !page?.paras?.length || hasPdfText(doc)) return
  // 原来的文字层是乱码时藏起来，免得选中的是乱码
  const pdfLayer = doc.querySelector('.textLayer:not(.ocrLayer)')
  if (pdfLayer?.textContent.trim()) pdfLayer.style.display = 'none'
  let layer = doc.querySelector('.ocrLayer')
  const probe = layer || doc.querySelector('.textLayer')
  const W = probe?.clientWidth || doc.documentElement.clientWidth
  const H = probe?.clientHeight || doc.documentElement.clientHeight
  if (!W || !H) return
  if (layer && layer.dataset.size === `${W}x${H}`) return // 尺寸没变，不用重铺
  layer?.remove()
  layer = doc.createElement('div')
  layer.className = 'textLayer ocrLayer' // 沿用 pdf.js 文字层的样式：透明、可选中
  layer.dataset.size = `${W}x${H}`
  const spans = []
  for (const para of page.paras) {
    // 每段一个块，朗读切句时段落分开；用 pdf.js 的 markedContent（display: contents），
    // 否则 pdf.js 会给文字层的直接子元素加 transform，把里面的行都挤到页顶
    const p = doc.createElement('div')
    p.className = 'markedContent'
    for (const { t, b } of para) {
      const s = doc.createElement('span')
      s.textContent = latin(t) ? t + ' ' : t
      const h = (b[3] - b[1]) * H
      s.style.cssText = `left:${b[0] * 100}%;top:${b[1] * 100}%;font-size:${h * 0.9}px;line-height:1;font-family:sans-serif`
      p.append(s)
      spans.push([s, (b[2] - b[0]) * W])
    }
    p.append(doc.createElement('br')) // 复制出来的文字保留分段
    layer.append(p)
  }
  doc.body.append(layer)
  // 每行横向拉伸到原文的宽度，选中范围和高亮才对得上
  for (const [s, w] of spans) {
    const natural = s.offsetWidth
    if (natural > 0 && w > 0) s.style.transform = `scaleX(${w / natural})`
  }
}

export function removeOcrLayer(doc) { doc?.querySelector('.ocrLayer')?.remove() }

// 一页的纯文字（给 AI 和搜索用）
export const ocrPageText = page => (page?.paras || [])
  .map(para => para.reduce((s, l) => s + (s && latin(s) ? ' ' : '') + l.t, ''))
  .join('\n')
