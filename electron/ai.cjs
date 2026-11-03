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

function streamChat(cfg, payload, onDelta, signal) {
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

module.exports = { streamChat, listModels }
