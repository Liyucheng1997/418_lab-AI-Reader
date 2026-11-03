// 书库内拖拽的共享状态（dragover 时读不到 dataTransfer 的内容）
export const drag = { kind: null, ids: [], folderId: null }

export function startBookDrag(e, ids) {
  drag.kind = 'books'
  drag.ids = ids
  e.dataTransfer.effectAllowed = 'copyMove'
  e.dataTransfer.setData('application/x-air-books', JSON.stringify(ids))
  const ghost = document.createElement('div')
  ghost.className = 'drag-ghost'
  ghost.textContent = ids.length > 1 ? `${ids.length} 本书` : '1 本书'
  document.body.append(ghost)
  e.dataTransfer.setDragImage(ghost, 20, 16)
  setTimeout(() => ghost.remove())
}

export function startFolderDrag(e, id) {
  drag.kind = 'folder'
  drag.folderId = id
  e.dataTransfer.effectAllowed = 'move'
  e.dataTransfer.setData('application/x-air-folder', id)
}

export function endDrag() {
  drag.kind = null
  drag.ids = []
  drag.folderId = null
}

export const hasFiles = e => e.dataTransfer.types.includes('Files') && !drag.kind
