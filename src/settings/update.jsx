// 自动更新：状态订阅、下载完成提示条
import { useEffect, useState } from 'react'
import { X } from 'lucide-react'

export function useUpdateState() {
  const [state, setState] = useState({ status: 'idle' })
  useEffect(() => {
    window.api.updateState().then(setState)
    return window.api.onUpdateState(setState)
  }, [])
  return state
}

export function updateText(s) {
  switch (s.status) {
    case 'dev': return '开发模式下不检查更新'
    case 'checking': return '正在检查更新…'
    case 'none': return '已是最新版本'
    case 'available': return `发现新版本 ${s.version}，准备下载…`
    case 'downloading': return `正在下载 ${s.version}（${s.percent ?? 0}%）`
    case 'downloaded': return `新版本 ${s.version} 已下载，重启即可完成更新`
    case 'error': return `检查更新失败：${s.error}`
    default: return ''
  }
}

// 新版本下载完成后，在窗口右下角提示；不点也会在下次退出时自动安装
export function UpdateBanner() {
  const s = useUpdateState()
  const [hidden, setHidden] = useState(false)
  if (s.status !== 'downloaded' || hidden) return null
  return (
    <div className="update-banner">
      <span className="dot" />
      <span>新版本 {s.version} 已就绪</span>
      <button className="btn btn-sm btn-primary" onClick={() => window.api.installUpdate()}>重启更新</button>
      <button className="icon-btn" title="稍后（退出时自动安装）" onClick={() => setHidden(true)}><X size={14} /></button>
    </div>
  )
}
