// OCR 隐藏窗口的桥：接收主进程派来的识别任务，回传结果
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('ocrHost', {
  onTask: fn => ipcRenderer.on('ocr:task', (_e, task) => fn(task)),
  done: (id, result) => ipcRenderer.send('ocr:done', id, result),
  ready: info => ipcRenderer.send('ocr:ready', info),
})
