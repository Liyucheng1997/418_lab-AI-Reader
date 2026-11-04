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
  bindSelection(doc, layer, spans.map(([s]) => s))
  return true
}

// 文字是一行行绝对定位的块，鼠标落在行间、段间或页边空白处时，Chromium 会把选区
// 端点放到整层末尾，一拖就选中本页剩下的全部文字。这里接管鼠标拖选：端点总是
// 吸附到离鼠标最近的那一行上
function caretNear(doc, spans, x, y) {
  let best = null, bestD = Infinity
  for (const s of spans) {
    const r = s.getBoundingClientRect()
    if (!r.width || !r.height) continue
    const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0
    const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0
    const d = dx * dx + dy * dy * 4 // 竖直方向权重大些：行间空隙里优先归到上下最近的行
    if (d < bestD) { bestD = d; best = [s, r] }
  }
  if (!best) return null
  const [s, r] = best
  const node = s.firstChild
  if (!node) return null
  if (x <= r.left) return { node, offset: 0 }
  if (x >= r.right) return { node, offset: node.length }
  const c = doc.caretRangeFromPoint?.(x, (r.top + r.bottom) / 2)
  if (c?.startContainer === node) return { node, offset: c.startOffset }
  return { node, offset: Math.round(((x - r.left) / r.width) * node.length) }
}

function bindSelection(doc, layer, spans) {
  layer.addEventListener('mousedown', e => {
    if (e.button !== 0) return
    const onText = spans.includes(e.target)
    // 双击 / 三击落在文字上交给浏览器选词、选段；落在空白处什么都不做
    if (e.detail > 1) { if (!onText) e.preventDefault(); return }
    const sel = doc.getSelection()
    if (!sel) return
    const at = caretNear(doc, spans, e.clientX, e.clientY)
    if (!at) return
    e.preventDefault() // 不让浏览器自己定起点；但焦点还是要给书页，键盘翻页才有效
    doc.defaultView?.focus()
    let anchor = at
    if (e.shiftKey && sel.rangeCount && layer.contains(sel.anchorNode)) anchor = { node: sel.anchorNode, offset: sel.anchorOffset }
    sel.setBaseAndExtent(anchor.node, anchor.offset, at.node, at.offset)
    const move = ev => {
      if (!(ev.buttons & 1)) return up()
      const p = caretNear(doc, spans, ev.clientX, ev.clientY)
      if (p) sel.setBaseAndExtent(anchor.node, anchor.offset, p.node, p.offset)
    }
    const up = () => {
      doc.removeEventListener('mousemove', move)
      doc.removeEventListener('mouseup', up)
    }
    doc.addEventListener('mousemove', move)
    doc.addEventListener('mouseup', up)
  })
}

export function removeOcrLayer(doc) { doc?.querySelector('.ocrLayer')?.remove() }

// 一页的纯文字（给 AI 和搜索用）
export const ocrPageText = page => (page?.paras || [])
  .map(para => para.reduce((s, l) => s + (s && latin(s) ? ' ' : '') + l.t, ''))
  .join('\n')
