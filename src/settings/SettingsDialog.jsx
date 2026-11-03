import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Settings, Sparkles, Info, X, Eye, EyeOff, Keyboard } from 'lucide-react'
import { useLib } from '../App.jsx'
import { toast } from '../lib/ui.jsx'
import { useUpdateState, updateText } from './update.jsx'

// 常用服务商预设（除 Claude 外均为 OpenAI 兼容接口）
export const PROVIDERS = [
  { id: 'anthropic', name: 'Anthropic Claude', baseUrl: '', models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'] },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: [] },
  { id: 'deepseek', name: 'DeepSeek 深度求索', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { id: 'qwen', name: '通义千问（阿里云百炼）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-plus', 'qwen-max', 'qwen-turbo'] },
  { id: 'moonshot', name: 'Kimi（月之暗面）', baseUrl: 'https://api.moonshot.cn/v1', models: [] },
  { id: 'zhipu', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: [] },
  { id: 'siliconflow', name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', models: [] },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', models: [] },
  { id: 'custom', name: '自定义（OpenAI 兼容）', baseUrl: '', models: [] },
]

export default function SettingsDialog({ tab: initial, onClose }) {
  const [tab, setTab] = useState(initial)
  const Nav = ({ id, icon: Icon, children }) => (
    <div className={`nav-item ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>
      <Icon size={17} strokeWidth={1.75} className="ico" /><span className="label">{children}</span>
    </div>
  )
  return createPortal(
    <div className="modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" style={{ width: 860 }} onKeyDown={e => e.key === 'Escape' && onClose()}>
        <div className="settings">
          <div className="settings-nav">
            <div className="h">SETTINGS</div>
            <Nav id="general" icon={Settings}>通用</Nav>
            <Nav id="ai" icon={Sparkles}>AI 助手</Nav>
            <Nav id="keys" icon={Keyboard}>快捷键</Nav>
            <Nav id="about" icon={Info}>关于</Nav>
          </div>
          <div className="settings-main">
            <button className="modal-x settings-x" onClick={onClose}><X size={15} /></button>
            {tab === 'general' && <General />}
            {tab === 'ai' && <AI />}
            {tab === 'keys' && <Keys />}
            {tab === 'about' && <About />}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function General() {
  const lib = useLib()
  const s = lib.settings
  const [boss, setBoss] = useState(s.bossKey)
  return (
    <>
      <div className="eyebrow">GENERAL</div>
      <h2>通用</h2>
      <div className="set-card">
        <div className="set-row">
          <span className="k">外观</span>
          <div className="v">
            <div className="seg">
              {[['light', '浅色'], ['dark', '深色'], ['system', '跟随系统']].map(([v, l]) => (
                <button key={v} className={s.theme === v ? 'active' : ''} onClick={() => lib.updateSettings({ theme: v })}>{l}</button>
              ))}
            </div>
          </div>
        </div>
        <div className="set-row">
          <span className="k">文件夹视图</span>
          <div className="v">
            <label className="form-check">
              <input type="checkbox" checked={s.showSubfolderItems} onChange={e => lib.updateSettings({ showSubfolderItems: e.target.checked })} />
              在文件夹里同时显示子文件夹中的书（类似 Zotero 的“显示子分类条目”）
            </label>
          </div>
        </div>
        <div className="set-row">
          <span className="k">老板键</span>
          <div className="v">
            <input className="input" style={{ maxWidth: 180 }} value={boss} onChange={e => setBoss(e.target.value)}
              onKeyDown={e => {
                if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key) || e.key === 'Tab') return
                e.preventDefault()
                if (e.key === 'Backspace') { setBoss(''); return }
                const parts = []
                if (e.ctrlKey) parts.push('Ctrl')
                if (e.altKey) parts.push('Alt')
                if (e.shiftKey) parts.push('Shift')
                parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key)
                setBoss(parts.join('+'))
              }} placeholder="按下组合键" />
            <button className="btn btn-sm" onClick={async () => { await lib.updateSettings({ bossKey: boss }); toast(boss ? `老板键已设为 ${boss}` : '已关闭老板键', 'success') }}>保存</button>
            <span className="hint">一键隐藏 / 显示窗口</span>
          </div>
        </div>
      </div>
      <div className="set-hint">图书会复制到应用数据目录中保存，删除原文件不影响阅读。</div>
    </>
  )
}

function AI() {
  const lib = useLib()
  const [cfg, setCfg] = useState(lib.settings.ai)
  const [showKey, setShowKey] = useState(false)
  const [models, setModels] = useState([])
  const [status, setStatus] = useState(null)
  const preset = PROVIDERS.find(p => p.id === cfg.provider) || PROVIDERS.at(-1)
  const set = patch => { setCfg(c => ({ ...c, ...patch })); setStatus(null) }
  const pickProvider = id => {
    const p = PROVIDERS.find(x => x.id === id)
    set({ provider: id, baseUrl: p.baseUrl, model: p.models[0] || '' })
    setModels([])
  }
  const save = async () => { await lib.updateSettings({ ai: cfg }); toast('AI 设置已保存', 'success') }
  const test = async () => {
    setStatus({ busy: true })
    try {
      const ids = await window.api.aiModels(cfg)
      setModels(ids)
      setStatus({ ok: true, text: `连接成功，可用模型 ${ids.length} 个` })
    } catch (e) {
      setStatus({ ok: false, text: String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') })
    }
  }
  const suggestions = [...new Set([...preset.models, ...models])]
  return (
    <>
      <div className="eyebrow">AI ASSISTANT</div>
      <h2>AI 助手</h2>
      <div className="set-hint">填入你自己的 API Key 后，阅读时可以让 AI 解释、翻译、总结、答疑。Key 只保存在本机。</div>
      <div className="set-card">
        <div className="set-row">
          <span className="k">服务商</span>
          <div className="v">
            <select className="input" value={cfg.provider} onChange={e => pickProvider(e.target.value)}>
              {PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        </div>
        <div className="set-row">
          <span className="k">API 地址</span>
          <div className="v">
            <input className="input" value={cfg.baseUrl} onChange={e => set({ baseUrl: e.target.value })}
              placeholder={cfg.provider === 'anthropic' ? '留空使用官方地址 https://api.anthropic.com' : 'https://…/v1'} />
          </div>
        </div>
        <div className="set-row">
          <span className="k">API Key</span>
          <div className="v">
            <input className="input" type={showKey ? 'text' : 'password'} value={cfg.apiKey} onChange={e => set({ apiKey: e.target.value })}
              placeholder={cfg.provider === 'anthropic' ? 'sk-ant-…' : 'sk-…'} />
            <button className="icon-btn" onClick={() => setShowKey(v => !v)}>{showKey ? <EyeOff size={16} /> : <Eye size={16} />}</button>
          </div>
        </div>
        <div className="set-row">
          <span className="k">模型</span>
          <div className="v">
            <input className="input" list="ai-models" value={cfg.model} onChange={e => set({ model: e.target.value })} placeholder="模型名称" />
            <datalist id="ai-models">{suggestions.map(m => <option key={m} value={m} />)}</datalist>
          </div>
        </div>
      </div>
      <div className="set-card">
        <div className="set-row">
          <span className="k">翻译成</span>
          <div className="v">
            <select className="input" value={cfg.targetLang} onChange={e => set({ targetLang: e.target.value })}>
              {['中文', 'English', '日本語', '한국어', 'Français', 'Deutsch'].map(l => <option key={l}>{l}</option>)}
            </select>
          </div>
        </div>
        <div className="set-row">
          <span className="k">上下文长度</span>
          <div className="v">
            <input type="range" min={4000} max={60000} step={2000} value={cfg.contextChars}
              onChange={e => set({ contextChars: +e.target.value })} style={{ flex: 1 }} />
            <span className="tabular" style={{ width: 80, textAlign: 'right' }}>{(cfg.contextChars / 1000).toFixed(0)}k 字</span>
          </div>
        </div>
      </div>
      <div className="set-hint">“上下文长度”是让 AI 讲解本章时最多附带的原文字数，越长越准确，也越耗费额度。</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button className="btn" onClick={test} disabled={status?.busy || !cfg.apiKey}>{status?.busy ? '测试中…' : '测试连接'}</button>
        <button className="btn btn-primary" onClick={save}>保存</button>
        {status && !status.busy && <span className={`status-line ${status.ok ? 'ok' : 'err'}`}>{status.text}</span>}
      </div>
    </>
  )
}

function Keys() {
  const rows = [
    ['← / →、PageUp / PageDown、空格', '翻页'],
    ['鼠标滚轮', '翻页（分页模式）'],
    ['Ctrl + F', '书内搜索 / 书库搜索'],
    ['Ctrl + B', '添加 / 删除书签'],
    ['Ctrl + D', '打开目录'],
    ['Ctrl + J', '打开 AI 助手'],
    ['F11', '全屏阅读'],
    ['Esc', '关闭面板 / 返回书库'],
    ['Ctrl + O', '导入图书'],
    ['Ctrl + 点击 / Shift + 点击', '多选图书'],
  ]
  return (
    <>
      <div className="eyebrow">SHORTCUTS</div>
      <h2>快捷键</h2>
      <div className="set-card">
        {rows.map(([k, v]) => (
          <div className="set-row" key={k}><span className="k" style={{ width: 240 }}><span className="kbd">{k}</span></span><div className="v">{v}</div></div>
        ))}
      </div>
    </>
  )
}

function About() {
  const lib = useLib()
  const [version, setVersion] = useState('')
  const up = useUpdateState()
  useEffect(() => { window.api.appVersion().then(setVersion) }, [])
  const busy = ['checking', 'available', 'downloading'].includes(up.status)
  const text = updateText(up)
  return (
    <>
      <div className="eyebrow">ABOUT</div>
      <h2>AI Reader</h2>
      <div className="set-card">
        <div className="set-row"><span className="k">版本</span><div className="v">{version}</div></div>
        <div className="set-row">
          <span className="k">更新</span>
          <div className="v">
            {up.status === 'downloaded'
              ? <button className="btn btn-sm btn-primary" onClick={() => window.api.installUpdate()}>重启并更新</button>
              : <button className="btn btn-sm" disabled={busy || up.status === 'dev'} onClick={() => window.api.checkUpdate()}>检查更新</button>}
            {text && <span className={up.status === 'error' ? 'status-line err' : up.status === 'none' || up.status === 'downloaded' ? 'status-line ok' : 'hint'}>{text}</span>}
          </div>
        </div>
        <div className="set-row">
          <span className="k">自动更新</span>
          <div className="v">
            <label className="form-check">
              <input type="checkbox" checked={lib.settings.autoUpdate} onChange={e => lib.updateSettings({ autoUpdate: e.target.checked })} />
              启动时自动检查 GitHub 上的新版本，并在后台下载
            </label>
          </div>
        </div>
        <div className="set-row"><span className="k">支持格式</span><div className="v">EPUB · PDF · TXT · MOBI · AZW3 · FB2 · CBZ</div></div>
        <div className="set-row"><span className="k">渲染引擎</span><div className="v">foliate-js（MIT）· pdf.js</div></div>
      </div>
      <div className="set-hint">参照 Neat Reader 的阅读体验，加入了 Zotero 式的多级文件夹分类与 AI 辅助阅读。</div>
    </>
  )
}
