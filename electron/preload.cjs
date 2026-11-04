const { contextBridge, ipcRenderer, webUtils } = require('electron')

const invoke = (ch, ...args) => ipcRenderer.invoke(ch, ...args)

contextBridge.exposeInMainWorld('api', {
  getLibrary: () => invoke('lib:get'),
  pendingFiles: () => invoke('app:pending-files'),
  onOpenFiles: fn => ipcRenderer.on('app:open-files', (_e, files) => fn(files)),
  pathForFile: file => webUtils.getPathForFile(file),

  importDialog: (folderId, kind) => invoke('books:import-dialog', folderId, kind),
  importPaths: (paths, folderId) => invoke('books:import-paths', paths, folderId),
  updateBooks: (ids, patch) => invoke('books:update', ids, patch),
  addToFolder: (ids, folderId) => invoke('books:add-to-folder', ids, folderId),
  removeFromFolder: (ids, folderId) => invoke('books:remove-from-folder', ids, folderId),
  deleteBooks: ids => invoke('books:delete', ids),
  saveCover: (id, bytes) => invoke('books:save-cover', id, bytes),
  revealBook: id => invoke('books:reveal', id),
  getBook: id => invoke('books:get', id),
  patchBook: (id, patch) => invoke('books:patch', id, patch),
  keepLocal: (ids, keep) => invoke('books:keep-local', ids, keep),
  findCover: id => invoke('books:find-cover', id),
  folderLocal: (id, keep) => invoke('folders:local', id, keep),
  onBookUpdated: fn => ipcRenderer.on('book:updated', (_e, book) => fn(book)),
  dataInfo: () => invoke('data:info'),
  moveData: target => invoke('data:move', target),
  openDataDir: () => invoke('data:open'),

  linkedList: () => invoke('linked:list'),
  linkedAdd: () => invoke('linked:add'),
  linkedRescan: rootId => invoke('linked:rescan', rootId),
  linkedRemove: rootId => invoke('linked:remove', rootId),
  onLibChanged: fn => ipcRenderer.on('lib:changed', (_e, snap) => fn(snap)),

  createFolder: (name, parentId) => invoke('folders:create', name, parentId),
  updateFolder: (id, patch) => invoke('folders:update', id, patch),
  moveFolder: (id, parentId, beforeId) => invoke('folders:move', id, parentId, beforeId),
  deleteFolder: id => invoke('folders:delete', id),

  getAnnotations: bookId => invoke('ann:get', bookId),
  setAnnotations: (bookId, list) => invoke('ann:set', bookId, list),
  allAnnotations: () => invoke('ann:all'),
  getChat: bookId => invoke('chat:get', bookId),
  setChat: (bookId, messages) => invoke('chat:set', bookId, messages),

  setSettings: patch => invoke('settings:set', patch),
  setOverlay: dark => invoke('win:overlay', dark),
  toggleFullscreen: () => invoke('win:fullscreen'),
  saveText: (name, content) => invoke('file:save-text', name, content),
  openExternal: url => invoke('shell:open', url),

  appVersion: () => invoke('app:version'),
  updateState: () => invoke('update:state'),
  checkUpdate: () => invoke('update:check'),
  installUpdate: () => invoke('update:install'),
  onUpdateState: fn => {
    const listener = (_e, state) => fn(state)
    ipcRenderer.on('update:state', listener)
    return () => ipcRenderer.removeListener('update:state', listener)
  },

  ttsSynth: text => invoke('tts:synth', text),
  ttsCancel: () => invoke('tts:cancel'),
  ttsVoices: cfg => invoke('tts:voices', cfg),
  ttsStatus: cfg => invoke('tts:status', cfg),
  ttsPickFile: kind => invoke('tts:pick-file', kind),

  ocrGet: bookId => invoke('ocr:get', bookId),
  ocrStart: (bookId, indices, total, front) => invoke('ocr:start', bookId, indices, total, front),
  ocrStop: bookId => invoke('ocr:stop', bookId),
  onOcrProgress: fn => {
    const listener = (_e, ev) => fn(ev)
    ipcRenderer.on('ocr:progress', listener)
    return () => ipcRenderer.removeListener('ocr:progress', listener)
  },

  aiModels: cfg => invoke('ai:models', cfg),
  aiChat: (reqId, payload) => invoke('ai:chat', reqId, payload),
  aiAbort: reqId => invoke('ai:abort', reqId),
  onAiDelta: fn => {
    const listener = (_e, reqId, text) => fn(reqId, text)
    ipcRenderer.on('ai:delta', listener)
    return () => ipcRenderer.removeListener('ai:delta', listener)
  },
})
