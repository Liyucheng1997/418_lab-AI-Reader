// 自动更新：从 GitHub Releases 检测新版本，后台下载，下载完成后提示重启安装
const { app } = require('electron')
const { autoUpdater } = require('electron-updater')

let state = { status: 'idle' } // idle | checking | none | available | downloading | downloaded | error | dev
let send = () => {}
let manual = false

function set(patch) {
  state = { ...patch, version: patch.version ?? state.version }
  send(state)
}

function setupUpdater(onState) {
  send = onState
  if (!app.isPackaged && !process.env.AIR_DEV_UPDATE) { state = { status: 'dev' }; return }
  if (!app.isPackaged) autoUpdater.forceDevUpdateConfig = true
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('checking-for-update', () => set({ status: 'checking' }))
  autoUpdater.on('update-not-available', () => set({ status: 'none' }))
  autoUpdater.on('update-available', info => set({ status: 'available', version: info.version }))
  autoUpdater.on('download-progress', p => set({ status: 'downloading', percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', info => set({ status: 'downloaded', version: info.version }))
  autoUpdater.on('error', err => {
    // 自动检查时网络失败不打扰用户，只有手动检查才显示错误
    set(manual ? { status: 'error', error: String(err?.message || err).split('\n')[0] } : { status: 'idle' })
  })
}

function checkForUpdates(isManual = false) {
  if (state.status === 'dev') return state
  if (['checking', 'downloading', 'downloaded'].includes(state.status)) return state
  manual = isManual
  autoUpdater.checkForUpdates().catch(() => {}) // 错误已由 error 事件处理
  return state
}

const getState = () => state
// 静默安装并自动重新打开
const installNow = () => { if (state.status === 'downloaded') autoUpdater.quitAndInstall(true, true) }

module.exports = { setupUpdater, checkForUpdates, getState, installNow }
