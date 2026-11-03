// 加载 foliate-js（public/foliate-js，原样提供，不经 Vite 打包）
import { makeTxtBook } from './txt.js'

const base = new URL('foliate-js/', document.baseURI).href
let mods = null

export async function loadFoliate() {
  if (!mods) {
    const [view, overlayer, cfi] = await Promise.all([
      import(/* @vite-ignore */ base + 'view.js'),
      import(/* @vite-ignore */ base + 'overlayer.js'),
      import(/* @vite-ignore */ base + 'epubcfi.js'),
    ])
    mods = { makeBook: view.makeBook, Overlayer: overlayer.Overlayer, CFI: cfi }
  }
  return mods
}

export const bookFileURL = id => `book://file/${encodeURIComponent(id)}`
export const coverURL = (id, v) => `book://cover/${encodeURIComponent(id)}?v=${v}`

// 根据书库记录打开电子书，返回 foliate book 对象
export async function openBookRecord(record) {
  const res = await fetch(bookFileURL(record.id))
  if (!res.ok) throw new Error('找不到图书文件')
  const blob = await res.blob()
  if (record.format === 'txt') return makeTxtBook(await blob.arrayBuffer(), record.title)
  const { makeBook } = await loadFoliate()
  const name = record.fileName.toLowerCase()
  return makeBook(new File([blob], name))
}

export const langText = x => {
  if (!x) return ''
  if (typeof x === 'string') return x
  if (Array.isArray(x)) return x.map(langText).filter(Boolean).join('、')
  if (x.name) return langText(x.name)
  const k = Object.keys(x)
  return k.length ? String(x[k[0]]) : ''
}

// 后台解析书名、作者、封面
export async function extractMeta(record) {
  const book = await openBookRecord(record)
  const meta = book.metadata || {}
  const title = langText(meta.title).trim()
  const author = langText(meta.author || meta.creator).trim()
  let cover = null
  try {
    const blob = await book.getCover?.()
    if (blob) cover = await shrinkImage(blob, 300)
  } catch {}
  book.destroy?.()
  return { title, author, cover }
}

async function shrinkImage(blob, maxW) {
  const bmp = await createImageBitmap(blob)
  const scale = Math.min(1, maxW / bmp.width)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bmp.width * scale)
  canvas.height = Math.round(bmp.height * scale)
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height)
  // JPEG 缩略图约 20–30 KB（PNG 要 200 多 KB）；文件名仍是 .png，图片按内容识别格式
  const out = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.85))
  return new Uint8Array(await out.arrayBuffer())
}
