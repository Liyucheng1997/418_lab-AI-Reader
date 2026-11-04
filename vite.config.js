import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { cpSync, mkdirSync } from 'fs'

// OCR：PaddleOCR 的 PP-OCRv4 模型，打包时复制到 dist，开发时直接从 node_modules 取（onnxruntime 的 wasm 由 Vite 自己打包）
const OCR_ASSETS = [
  ['node_modules/@gutenye/ocr-models/assets/ch_PP-OCRv4_det_infer.onnx', 'ocr-models/det.onnx'],
  ['node_modules/@gutenye/ocr-models/assets/ch_PP-OCRv4_rec_infer.onnx', 'ocr-models/rec.onnx'],
  ['node_modules/@gutenye/ocr-models/assets/ppocr_keys_v1.txt', 'ocr-models/dict.txt'],
]

const ocr = () => ({
  name: 'air-ocr',
  // OCR 窗口要 crossOriginIsolated 才能多线程跑 wasm
  configureServer(server) {
    // 跨源隔离的页面里，Worker 脚本（pdf.js、onnxruntime 的多线程）自己也得带 COEP，否则会被拦下
    server.middlewares.use((req, res, next) => {
      const page = req.url === '/' || req.url.startsWith('/index.html') // 主窗口不做跨源隔离
      if (!page) {
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
      }
      if (req.url.startsWith('/ocr.html')) res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
      next()
    })
  },
  closeBundle() {
    for (const [from, to] of OCR_ASSETS) {
      mkdirSync(`dist/${to.split('/')[0]}`, { recursive: true })
      cpSync(from, `dist/${to}`)
    }
  },
})

export default defineConfig({
  plugins: [react(), ocr()],
  base: './',
  server: { port: 5199, strictPort: false },
  build: {
    outDir: 'dist', emptyOutDir: true, target: 'esnext',
    modulePreload: { polyfill: false }, // polyfill 用到 document，Worker 里加载会报错
    rollupOptions: {
      input: { main: 'index.html', ocr: 'ocr.html' },
      // onnxruntime 的多线程 Worker 会重新加载它自己所在的文件：单独成块，别和页面代码打在一起
      output: { manualChunks: id => id.includes('onnxruntime-web') ? 'ort' : undefined },
    },
  },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
})
