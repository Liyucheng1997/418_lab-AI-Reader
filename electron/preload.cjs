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

  aiModels: cfg => invoke('ai:models', cfg),
  aiChat: (reqId, payload) => invoke('ai:chat', reqId, payload),
  aiAbort: reqId => invoke('ai:abort', reqId),
  onAiDelta: fn => {
    const listener = (_e, reqId, text) => fn(reqId, text)
    ipcRenderer.on('ai:delta', listener)
    return () => ipcRenderer.removeListener('ai:delta', listener)
  },
})
