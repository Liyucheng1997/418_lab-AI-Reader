// 思维导图的侧重点：不同的书、不同的读者想看的不一样。
// 生成前先让 AI 翻一翻这本书，提出几个适合的方向，读者勾选（可多选、可自己加），再按所选方向去读、去画。

export const LENSES = {
  characters: { label: '人物关系', branch: '人物', hint: '人物的身份、性格、经历，以及人物之间的关系' },
  concepts: { label: '核心概念', branch: '核心概念', hint: '术语、思想、理论、组织、器物，分类整理' },
  plot: { label: '情节脉络', branch: '情节脉络', hint: '按先后顺序的关键情节和转折' },
  outline: { label: '章节框架', branch: '章节框架', hint: '逐章梳理要点，看清全书结构和论证顺序' },
  themes: { label: '主题思想', branch: '主题', hint: '全书想表达的主题、观点和作者立场' },
  methods: { label: '方法与行动', branch: '方法', hint: '书里可以照着做的方法、建议和步骤' },
  quotes: { label: '金句摘录', branch: '金句', hint: '值得摘抄、反复回味的原文句子' },
  places: { label: '地点场景', branch: '地点', hint: '故事发生的地点、场景和世界观' },
}

// 旧版导图（还没有“侧重点”时生成的）按这个顺序显示
export const DEFAULT_FOCUS = ['characters', 'concepts', 'themes', 'plot', 'places'].map(kind => ({ id: kind, kind, title: LENSES[kind].label }))

// AI 分析失败时的备用方向
export function fallbackDirections() {
  return ['characters', 'concepts', 'plot', 'outline', 'themes', 'methods', 'quotes'].map((kind, i) => ({
    id: kind, kind, title: LENSES[kind].label, desc: LENSES[kind].hint, recommended: i < 2,
  }))
}

export const branchLabel = f => f.kind === 'custom' ? f.title : LENSES[f.kind]?.branch || f.title
export const focusOf = map => map?.focus?.length ? map.focus : DEFAULT_FOCUS
export const hasFocus = (map, kind) => focusOf(map).some(f => f.kind === kind)

// 每段抽取结果里的字段 → “刚刚记下”里显示的类别
export function feedLabels(focus) {
  const out = { characters: '人物', relations: '关系', concepts: '概念', places: '地点', events: '情节', outline: '章节', themes: '主题', methods: '方法', quotes: '金句' }
  for (const f of focus) if (f.kind === 'custom') out['x_' + f.id] = f.title.length > 4 ? f.title.slice(0, 4) : f.title
  return out
}
