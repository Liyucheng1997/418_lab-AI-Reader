// OCR 窗口（隐藏）：用 pdf.js 把 PDF 某一页画成图片，再用 PaddleOCR（PP-OCRv4，onnxruntime-web）识别
// 结果按阅读顺序分段返回，坐标是相对整页的比例（0–1），阅读器据此在页面上铺一层可选中的透明文字
import * as ort from 'onnxruntime-web/wasm' // 只要 CPU 的 wasm 版本（WebGPU 版要多打 30 MB）
import { init } from 'esearch-ocr'

const DEV = import.meta.env.DEV
const files = DEV
  ? {
      det: '/node_modules/@gutenye/ocr-models/assets/ch_PP-OCRv4_det_infer.onnx',
      rec: '/node_modules/@gutenye/ocr-models/assets/ch_PP-OCRv4_rec_infer.onnx',
      dict: '/node_modules/@gutenye/ocr-models/assets/ppocr_keys_v1.txt',
    }
  : { det: './ocr-models/det.onnx', rec: './ocr-models/rec.onnx', dict: './ocr-models/dict.txt' }

// 能多线程就多线程（需要 crossOriginIsolated），留两个核给阅读界面
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(8, navigator.hardwareConcurrency - 2)) : 1

let engine = null
const getEngine = () => engine ||= (async () => {
  const dict = await (await fetch(files.dict)).text()
  return init({ det: { input: files.det }, rec: { input: files.rec, decodeDic: dict }, ort })
})()

const pdfjsBase = new URL('foliate-js/vendor/pdfjs/', document.baseURI).href
let pdfjs = null
const getPdfjs = async () => {
  if (!pdfjs) {
    await import(/* @vite-ignore */ pdfjsBase + 'pdf.mjs')
    pdfjs = globalThis.pdfjsLib
    pdfjs.GlobalWorkerOptions.workerSrc = pdfjsBase + 'pdf.worker.mjs'
  }
  return pdfjs
}

let cached = { url: null, doc: null }
async function openPdf(url) {
  if (cached.url !== url) {
    cached.doc?.destroy()
    const lib = await getPdfjs()
    cached = { url, doc: await lib.getDocument({ url, cMapUrl: pdfjsBase + 'cmaps/', cMapPacked: true }).promise }
  }
  return cached.doc
}

const r4 = n => Math.round(n * 10000) / 10000
// 四个角点 → [左, 上, 右, 下]（相对整页）
const toRect = (box, w, h) => {
  const xs = box.map(p => p[0]), ys = box.map(p => p[1])
  return [r4(Math.min(...xs) / w), r4(Math.min(...ys) / h), r4(Math.max(...xs) / w), r4(Math.max(...ys) / h)]
}

async function recognize({ url, page: n }) {
  const doc = await openPdf(url)
  const page = await doc.getPage(n)
  const base = page.getViewport({ scale: 1 })
  // 长边约 1800 像素：再大也不会更准，只会更慢
  const viewport = page.getViewport({ scale: Math.min(3, 1800 / Math.max(base.width, base.height)) })
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(viewport.width)
  canvas.height = Math.round(viewport.height)
  await page.render({ canvasContext: canvas.getContext('2d'), viewport, intent: 'print' }).promise
  const res = await (await getEngine()).ocr(canvas)
  const { width: w, height: h } = canvas
  // 按版面分析的阅读顺序：分栏 → 段落 → 行
  const paras = []
  for (const col of res.columns || []) {
    for (const p of col.parragraphs || []) {
      const lines = (p.src || []).filter(l => l.text.trim()).map(l => ({ t: l.text, b: toRect(l.box, w, h) }))
      if (lines.length) paras.push(lines)
    }
  }
  if (!paras.length && res.src?.length) paras.push(res.src.filter(l => l.text.trim()).map(l => ({ t: l.text, b: toRect(l.box, w, h) })))
  page.cleanup()
  return { total: doc.numPages, paras }
}

window.ocrHost.onTask(async task => {
  try {
    window.ocrHost.done(task.id, await recognize(task))
  } catch (e) {
    window.ocrHost.done(task.id, { error: String(e?.message || e) })
  }
})
window.ocrHost.ready({ threads: ort.env.wasm.numThreads })
