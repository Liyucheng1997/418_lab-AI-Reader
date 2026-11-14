// AI 调用：Claude 走官方 Anthropic SDK；其他服务商走 OpenAI 兼容接口（/chat/completions）
const Anthropic = require('@anthropic-ai/sdk').default

// 这些模型支持服务端拒答兜底（refusal 时自动换模型续答）
const FALLBACK_MODELS = ['claude-opus-5-5', 'claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5-5']

function isOfficialAnthropic(baseUrl) {
  return !baseUrl || /^https:\/\/api\.anthropic\.com/i.test(baseUrl)
}

function anthropicClient(cfg) {
  // 显式给出地址，避免读取系统里的 ANTHROPIC_BASE_URL 环境变量
  return new Anthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl || 'https://api.anthropic.com', maxRetries: 2 })
}

async function streamAnthropic(cfg, { system, messages }, onDelta, signal) {
  const client = anthropicClient(cfg)
  const params = { model: cfg.model, max_tokens: 16000, system, messages }
  const useFallback = isOfficialAnthropic(cfg.baseUrl) && FALLBACK_MODELS.includes(cfg.model)
  const run = async withFallback => {
    const stream = withFallback
      ? client.beta.messages.stream(
          { ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, { signal })
      : client.messages.stream(params, { signal })
    stream.on('text', t => onDelta(t))
    return stream.finalMessage()
  }
  let msg
  try {
    msg = await run(useFallback)
  } catch (e) {
    // 代理或旧版本不认识兜底参数时，退回普通请求
    if (useFallback && e instanceof Anthropic.BadRequestError && /fallback|beta/i.test(e.message)) msg = await run(false)
    else throw e
  }
  if (msg.stop_reason === 'refusal') throw new Error('模型拒绝回答这个请求，可以换个问法再试。')
  if (msg.stop_reason === 'max_tokens') onDelta('\n\n（回答过长，已截断）')
}

async function streamOpenAI(cfg, { system, messages }, onDelta, signal) {
  const base = (cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')
  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
    body: JSON.stringify({
      model: cfg.model,
      stream: true,
      messages: [{ role: 'system', content: system }, ...messages],
    }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`请求失败 ${res.status}：${text.slice(0, 300)}`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      const s = line.trim()
      if (!s.startsWith('data:')) continue
      const data = s.slice(5).trim()
      if (data === '[DONE]') return
      try {
        const delta = JSON.parse(data).choices?.[0]?.delta
        if (delta?.content) onDelta(delta.content)
      } catch {}
    }
  }
}

// ---------- Claude 订阅：调用本机已登录 claude.ai 的 Claude Code（claude -p），不消耗 API 额度 ----------
const { spawn, execFile } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

let claudeExe // undefined = 还没找过；null = 没找到
function findClaude() {
  if (claudeExe !== undefined) return Promise.resolve(claudeExe)
  const home = os.homedir()
  const candidates = [
    path.join(home, '.local', 'bin', 'claude.exe'),
    path.join(home, '.local', 'bin', 'claude'),
    path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'),
  ]
  const hit = candidates.find(f => f && fs.existsSync(f))
  if (hit) return Promise.resolve((claudeExe = hit))
  return new Promise(resolve => {
    execFile(process.platform === 'win32' ? 'where.exe' : 'which', ['claude'], { windowsHide: true }, (err, out) => {
      const first = !err && String(out).split(/\r?\n/).map(s => s.trim()).find(Boolean)
      resolve((claudeExe = first || null))
    })
  })
}

// 不让系统里的 API Key / 代理地址抢在订阅前面；也不被当成嵌套在另一个 Claude Code 会话里
function subEnv() {
  const env = { ...process.env }
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']) delete env[k]
  return env
}

const runOpts = exe => ({ windowsHide: true, env: subEnv(), cwd: os.tmpdir(), shell: /\.cmd$/i.test(exe) })

// 订阅状态：{ found, loggedIn, method, email? }
async function subscriptionStatus() {
  const exe = await findClaude()
  if (!exe) return { found: false, loggedIn: false }
  return new Promise(resolve => {
    execFile(exe, ['auth', 'status'], { ...runOpts(exe), timeout: 20000 }, (err, out) => {
      try {
        const s = JSON.parse(out)
        resolve({ found: true, loggedIn: !!s.loggedIn, method: s.authMethod || '', subscription: s.subscriptionType || '' })
      } catch { resolve({ found: true, loggedIn: false, error: (err?.message || String(out)).slice(0, 200) }) }
    })
  })
}

const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.filter(p => p.type === 'text').map(p => p.text).join('\n') : String(c ?? '')

// claude -p 只接受一条输入：把之前的对话按记录拼进去
function flatten(messages) {
  if (messages.length === 1) return textOf(messages[0].content)
  const past = messages.slice(0, -1).map(m => `【${m.role === 'user' ? '用户' : '助手'}】\n${textOf(m.content)}`).join('\n\n')
  return `下面是我们之前的对话记录：\n\n${past}\n\n——\n请接着回答我的最新消息：\n\n${textOf(messages.at(-1).content)}`
}

class SubscriptionError extends Error {}

async function streamSubscription(cfg, { system, messages }, onDelta, signal) {
  const exe = await findClaude()
  if (!exe) throw new SubscriptionError('没有找到 Claude Code（claude 命令）。安装并登录后才能使用订阅。')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aireader-ai-'))
  const sysFile = path.join(dir, 'system.txt')
  fs.writeFileSync(sysFile, system || '', 'utf8')
  // 只当聊天模型用：不给任何工具、不加载 MCP / 插件 / 设置文件、不保存会话
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--system-prompt-file', sysFile, '--tools', '', '--no-session-persistence',
    '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands']
  if (cfg.subModel) args.push('--model', cfg.subModel)
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, runOpts(exe))
    let buf = '', errText = '', resultErr = null, done = false
    const finish = fn => { if (done) return; done = true; signal?.removeEventListener('abort', onAbort); fs.rmSync(dir, { recursive: true, force: true }); fn() }
    const onAbort = () => { child.kill(); finish(resolve) }
    signal?.addEventListener('abort', onAbort)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      buf += chunk
      const lines = buf.split('\n')
      buf = lines.pop()
      for (const line of lines) {
        if (!line.trim()) continue
        let ev
        try { ev = JSON.parse(line) } catch { continue }
        const d = ev.type === 'stream_event' && ev.event?.type === 'content_block_delta' && ev.event.delta
        if (d?.type === 'text_delta') onDelta(d.text)
        if (ev.type === 'result' && ev.is_error) resultErr = String(ev.result || ev.subtype || '订阅调用失败')
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', t => { errText += t })
    child.on('error', e => finish(() => reject(new SubscriptionError('无法启动 Claude Code：' + e.message))))
    child.on('close', code => finish(() => {
      if (resultErr || code) {
        const msg = (resultErr || errText.trim() || `Claude Code 退出码 ${code}`).slice(0, 400)
        reject(new SubscriptionError(/log ?in|auth|credential|unauthori/i.test(msg) ? 'Claude Code 还没登录 claude.ai，请在终端运行 claude 登录。' : msg))
      } else resolve()
    }))
    child.stdin.end(flatten(messages), 'utf8')
  })
}

// 优先走 Claude 订阅；订阅不可用（没装、没登录、额度用完）且还没输出任何内容时，按设置改用 API Key
async function streamChat(cfg, payload, onDelta, signal) {
  if (cfg.useSubscription) {
    let got = false
    try { return await streamSubscription(cfg, payload, t => { got = true; onDelta(t) }, signal) }
    catch (e) {
      if (signal?.aborted || got || !cfg.subFallback || !cfg.apiKey) throw e
      console.warn('Claude 订阅不可用，改用 API Key：', e.message)
    }
  }
  if (!cfg.apiKey) throw new Error('还没有填写 API Key，请先在设置里配置 AI。')
  return cfg.provider === 'anthropic'
    ? streamAnthropic(cfg, payload, onDelta, signal)
    : streamOpenAI(cfg, payload, onDelta, signal)
}

// 测试连接：列出可用模型（不消耗对话额度）
async function listModels(cfg) {
  if (!cfg.apiKey) throw new Error('请先填写 API Key')
  if (cfg.provider === 'anthropic') {
    const ids = []
    for await (const m of anthropicClient(cfg).models.list()) ids.push(m.id)
    return ids
  }
  const base = (cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')
  const res = await fetch(base + '/models', { headers: { Authorization: 'Bearer ' + cfg.apiKey } })
  if (!res.ok) throw new Error(`连接失败 ${res.status}：${(await res.text()).slice(0, 200)}`)
  const json = await res.json()
  return (json.data || []).map(m => m.id)
}

module.exports = { streamChat, listModels, subscriptionStatus }
