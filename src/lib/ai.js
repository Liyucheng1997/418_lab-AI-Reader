// AI 是否可用：填了 API Key，或打开了“优先使用 Claude 订阅”（本机 Claude Code 登录的 claude.ai 账号）
export const aiReady = ai => !!(ai?.apiKey || ai?.useSubscription)
export const aiLabel = ai => ai?.useSubscription ? `Claude 订阅${ai.subModel ? ' · ' + ai.subModel : ''}` : ai?.model || (ai?.provider === 'anthropic' ? 'Claude' : '')
