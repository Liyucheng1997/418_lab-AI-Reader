// F5-TTS 朗读服务（主进程）：与“静听”听书软件同一个本地大模型，支持声音克隆
// 需要本机已装好 F5-TTS 的 Python 环境（默认使用静听的 .venv），按需启动、随应用退出
const { app } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')

// 静听（听书软件）的常见位置：用它现成的 Python 环境和已添加的音色
const JINGTING_DIRS = [
  'F:\\我的编程项目\\114_听书软件',
  path.join(app.getPath('home'), '114_听书软件'),
]

function detect() {
  for (const dir of JINGTING_DIRS) {
    const python = path.join(dir, '.venv', 'Scripts', 'python.exe')
    if (fs.existsSync(python)) return { python, jingting: dir }
  }
  return { python: '', jingting: '' }
}

function resolveConfig(cfg) {
  const auto = detect()
  const python = cfg.f5Python || auto.python
  // 自定义环境时，也看看它是不是在静听目录里（…/114_听书软件/.venv/Scripts/python.exe）
  const root = python ? path.resolve(python, '..', '..', '..') : ''
  const jingting = fs.existsSync(path.join(root, 'data', 'library.db')) ? root : auto.jingting
  return { python, jingting }
}

// 打包后 python 读不到 asar 里的脚本，用解包出来的那份
const SERVER_SCRIPT = path.join(__dirname, 'f5_server.py').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep)

let srv = null // { proc, python, port, ready, dead, log }

function start(python, jingting) {
  if (srv && srv.python === python && !srv.dead) return srv
  stop()
  if (!python || !fs.existsSync(python)) throw new Error('未找到 F5-TTS 的 Python 环境，请在“设置 → 朗读”里指定 python.exe')
  const cacheDir = path.join(app.getPath('userData'), 'tts-cache')
  const args = ['-u', SERVER_SCRIPT, '--cache', cacheDir, '--parent-pid', String(process.pid)]
  if (jingting) args.push('--jingting', jingting)
  const proc = spawn(python, args, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, KMP_DUPLICATE_LIB_OK: 'TRUE', HF_HUB_DISABLE_XET: '1', PYTHONIOENCODING: 'utf-8' },
  })
  const self = { proc, python, port: 0, dead: false, log: '' }
  self.ready = new Promise((resolve, reject) => {
    proc.stdout.on('data', d => {
      const m = d.toString().match(/F5_READY (\d+)/)
      if (m) { self.port = +m[1]; resolve(self.port) }
    })
    proc.stderr.on('data', d => { self.log = (self.log + d.toString()).slice(-4000) })
    proc.on('error', e => { self.dead = true; reject(e) })
    proc.on('exit', code => {
      self.dead = true
      reject(new Error(`F5-TTS 服务已退出（${code}）：${self.log.trim().split('\n').pop() || ''}`))
    })
  })
  self.ready.catch(() => {})
  srv = self
  return self
}

function stop() {
  if (srv && !srv.dead) srv.proc.kill()
  srv = null
}

async function request(cfg, route, body) {
  const { python, jingting } = resolveConfig(cfg)
  const port = await start(python, jingting).ready
  const res = await fetch(`http://127.0.0.1:${port}${route}`, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : undefined)
  if (!res.ok) throw new Error((await res.text()) || `F5-TTS 出错（${res.status}）`)
  return res
}

async function synth(cfg, text) {
  const v = cfg.f5Voice || cfg.customVoices?.[0] || {} // 都没有时由服务选第一个可用音色
  const res = await request(cfg, '/synth', { text, ref_audio: v.refAudio || '', ref_text: v.refText || '' })
  return new Uint8Array(await res.arrayBuffer())
}

const voices = async cfg => (await request(cfg, '/voices')).json()

async function status(cfg) {
  const { python } = resolveConfig(cfg)
  if (!python) return { found: false }
  try {
    return { found: true, python, ...(await (await request(cfg, '/status')).json()) }
  } catch (e) {
    return { found: true, python, error: e.message }
  }
}

module.exports = { synth, voices, status, stop }
