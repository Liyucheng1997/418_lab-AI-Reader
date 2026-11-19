// 思维导图：数据 → 树 → 左右展开的布局；人物关系：力导向布局；导出 Markdown

export const BRANCH_COLORS = ['#0071e3', '#ff9500', '#34c759', '#af52de', '#ff2d55', '#30b0c7', '#5856d6', '#a2845e']
export const GROUP_COLORS = ['#0071e3', '#ff9500', '#34c759', '#af52de', '#ff2d55', '#30b0c7', '#5856d6', '#a2845e', '#ffcc00', '#8e8e93']

export function palette(dark) {
  return dark
    ? { bg: '#111113', text: '#f5f5f7', text2: '#a1a1a6', panel: '#1c1c1e', line: 'rgba(255,255,255,0.14)', match: '#ffd60a', dim: 0.18 }
    : { bg: '#f5f5f7', text: '#1d1d1f', text2: '#6e6e73', panel: '#ffffff', line: 'rgba(0,0,0,0.12)', match: '#ffcc00', dim: 0.15 }
}

// ---------- 数据 → 树 ----------
// 节点：{ id, label, sub, level, branch, ref: { kind, name, index }, children, collapsed }
export function buildTree(map, title) {
  let n = 0
  const node = (label, extra = {}) => ({ id: 'n' + n++, label, sub: '', children: [], ...extra })
  const root = node(title, { level: 0, ref: { kind: 'book' }, sub: map.genre || '' })
  const top = []

  const chars = map.characters || []
  if (chars.length) {
    const b = node('人物', { ref: { kind: 'branch', name: 'characters' } })
    const rels = map.relations || []
    const charNode = c => {
      const cn = node(c.name, { sub: c.role === '主角' ? `主角 · ${c.desc}` : c.desc, ref: { kind: 'character', name: c.name }, star: c.role === '主角' })
      if (c.role !== '次要') {
        cn.children = rels.filter(r => r.from === c.name || r.to === c.name).map(r => {
          const other = r.from === c.name ? r.to : r.from
          return node(`${other} · ${r.type}`, { sub: r.desc, ref: { kind: 'character', name: other } })
        })
        cn.collapsed = true
      }
      return cn
    }
    const groups = (map.groups || []).map(g => g.name)
    const named = [...new Set([...groups, ...chars.map(c => c.group).filter(Boolean)])]
    const order = { 主角: 0, 主要: 1, 次要: 2 }
    const sorted = [...chars].sort((a, b) => order[a.role] - order[b.role])
    if (named.length > 1) {
      for (const g of named) {
        const members = sorted.filter(c => c.group === g)
        if (!members.length) continue
        const gn = node(g, { ref: { kind: 'group', name: g }, sub: `${members.length} 人` })
        gn.children = members.map(charNode)
        b.children.push(gn)
      }
      const rest = sorted.filter(c => !c.group || !named.includes(c.group))
      if (rest.length) { const gn = node('其他', { ref: { kind: 'group', name: '其他' } }); gn.children = rest.map(charNode); b.children.push(gn) }
    } else {
      for (const role of ['主角', '主要', '次要']) {
        const members = sorted.filter(c => c.role === role)
        if (!members.length) continue
        const gn = node(role === '主角' ? '主角' : role === '主要' ? '主要人物' : '次要人物', { ref: { kind: 'branch', name: 'characters' }, sub: `${members.length} 人` })
        gn.children = members.map(charNode)
        if (role === '次要' && members.length > 8) gn.collapsed = true
        b.children.push(gn)
      }
    }
    top.push(b)
  }

  const cats = map.conceptCategories || []
  if (cats.length) {
    const b = node('核心概念', { ref: { kind: 'branch', name: 'concepts' } })
    b.children = cats.map(c => {
      const cn = node(c.name, { ref: { kind: 'category', name: c.name }, sub: `${c.items.length} 项` })
      cn.children = c.items.map(i => node(i.name, { sub: i.desc, ref: { kind: 'concept', name: i.name } }))
      return cn
    })
    top.push(b)
  }

  if (map.themes?.length) {
    const b = node('主题', { ref: { kind: 'branch', name: 'themes' } })
    b.children = map.themes.map(t => node(t.name, { sub: t.desc, ref: { kind: 'theme', name: t.name } }))
    top.push(b)
  }

  if (map.timeline?.length) {
    const b = node('情节脉络', { ref: { kind: 'branch', name: 'timeline' } })
    b.children = map.timeline.map((e, i) => node(`${i + 1}. ${e.title}`, { sub: e.chapter || e.desc, ref: { kind: 'event', index: i } }))
    top.push(b)
  }

  if (map.places?.length) {
    const b = node('地点', { ref: { kind: 'branch', name: 'places' } })
    b.children = map.places.map(p => node(p.name, { sub: p.desc, ref: { kind: 'place', name: p.name } }))
    top.push(b)
  }

  root.children = top
  const walk = (x, level, branch) => {
    x.level = level
    x.branch = branch
    x.children.forEach((c, i) => walk(c, level + 1, level === 0 ? i : branch))
  }
  walk(root, 0, -1)
  return root
}

// ---------- 布局 ----------
let ctx, font
function textW(text, size, weight = 400) {
  ctx ||= document.createElement('canvas').getContext('2d')
  font ||= getComputedStyle(document.body).fontFamily || 'sans-serif'
  ctx.font = `${weight} ${size}px ${font}`
  return ctx.measureText(text).width
}
function fit(text, size, weight, max) {
  if (textW(text, size, weight) <= max) return text
  let lo = 0, hi = text.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (textW(text.slice(0, mid) + '…', size, weight) <= max) lo = mid
    else hi = mid - 1
  }
  return text.slice(0, lo) + '…'
}

export const STYLE = [
  { size: 20, weight: 650, padX: 24, h: 54, subSize: 12 },
  { size: 15, weight: 600, padX: 18, h: 40, subSize: 11.5 },
  { size: 13.5, weight: 600, padX: 14, h: 32, subSize: 11.5 },
  { size: 13, weight: 500, padX: 12, h: 30, subSize: 11 },
]
const styleOf = level => STYLE[Math.min(level, 3)]
const MAX_W = 250

function measure(n) {
  const st = styleOf(n.level)
  n.text = fit(n.label, st.size, st.weight, MAX_W)
  n.subText = n.sub ? fit(n.sub.replace(/\s+/g, ' '), st.subSize, 400, Math.max(MAX_W - 10, textW(n.text, st.size, st.weight))) : ''
  if (n.subText && n.level >= 2 && n.subText.length > 22) n.subText = fit(n.subText, st.subSize, 400, Math.max(160, textW(n.text, st.size, st.weight)))
  const w = Math.max(textW(n.text, st.size, st.weight) + (n.star ? 16 : 0), n.subText ? textW(n.subText, st.subSize) : 0)
  n.w = Math.ceil(w + st.padX * 2)
  n.h = st.h + (n.subText ? st.subSize + 5 : 0)
}

const visibleKids = n => n.collapsed ? [] : n.children
const VGAP = [24, 16, 8, 6]
const HGAP = [64, 44, 36, 30]

function subH(n) {
  const kids = visibleKids(n)
  if (!kids.length) return (n._sh = n.h)
  const gap = VGAP[Math.min(n.level, 3)]
  const sum = kids.reduce((s, c) => s + subH(c), 0) + gap * (kids.length - 1)
  return (n._sh = Math.max(n.h, sum))
}

function place(n, edgeX, centerY, side) {
  n.side = side
  n.cx = side > 0 ? edgeX + n.w / 2 : edgeX - n.w / 2
  n.cy = centerY
  const kids = visibleKids(n)
  if (!kids.length) return
  const gap = VGAP[Math.min(n.level, 3)]
  const total = kids.reduce((s, c) => s + c._sh, 0) + gap * (kids.length - 1)
  let y = centerY - total / 2
  const childEdge = n.cx + side * (n.w / 2 + HGAP[Math.min(n.level, 3)])
  for (const c of kids) {
    place(c, childEdge, y + c._sh / 2, side)
    y += c._sh + gap
  }
}

// 返回 { nodes, links, bbox }；节点坐标为中心点
export function layoutTree(root) {
  const all = []
  const visit = n => { measure(n); all.push(n); for (const c of n.children) visit(c) }
  visit(root)
  for (const c of root.children) subH(c)
  root.cx = 0; root.cy = 0; root.side = 0
  // 一级分支左右分配，两边高度尽量接近（右边先排）
  const kids = root.children
  const total = kids.reduce((s, c) => s + c._sh, 0)
  let acc = 0
  const right = [], left = []
  for (const c of kids) {
    if (acc < total / 2 || !right.length) { right.push(c); acc += c._sh } else left.push(c)
  }
  const stack = (list, side) => {
    const gap = VGAP[0]
    const h = list.reduce((s, c) => s + c._sh, 0) + gap * Math.max(0, list.length - 1)
    let y = -h / 2
    for (const c of list) {
      place(c, side * (root.w / 2 + HGAP[0]), y + c._sh / 2, side)
      y += c._sh + gap
    }
  }
  stack(right, 1)
  stack(left, -1)

  const nodes = [], links = []
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  const collect = n => {
    nodes.push(n)
    x0 = Math.min(x0, n.cx - n.w / 2); x1 = Math.max(x1, n.cx + n.w / 2)
    y0 = Math.min(y0, n.cy - n.h / 2); y1 = Math.max(y1, n.cy + n.h / 2)
    for (const c of visibleKids(n)) { links.push({ from: n, to: c }); collect(c) }
  }
  collect(root)
  return { nodes, links, bbox: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } }
}

export function linkPath(a, b) {
  const side = b.side
  const sx = a.level === 0 ? a.cx + side * a.w * 0.38 : a.cx + side * a.w / 2
  const sy = a.cy
  const tx = b.cx - side * b.w / 2
  const ty = b.cy
  const mx = (sx + tx) / 2
  return `M${sx},${sy} C${mx},${sy} ${mx},${ty} ${tx},${ty}`
}

export function findPath(root, pred) {
  const path = []
  const dfs = n => {
    path.push(n)
    if (pred(n)) return true
    for (const c of n.children) if (dfs(c)) return true
    path.pop()
    return false
  }
  return dfs(root) ? path : null
}

// ---------- 人物关系图：力导向 ----------
export function layoutGraph(chars, relations, prev = {}) {
  const nodes = chars.map((c, i) => {
    const r = c.role === '主角' ? 26 : c.role === '主要' ? 19 : 13
    const p = prev[c.name]
    const a = (i / Math.max(1, chars.length)) * Math.PI * 2
    return { id: c.name, c, r, x: p?.x ?? Math.cos(a) * 300 + (i % 7), y: p?.y ?? Math.sin(a) * 300 + (i % 5) }
  })
  const idx = new Map(nodes.map((n, i) => [n.id, i]))
  const edges = relations.filter(r => idx.has(r.from) && idx.has(r.to)).map(r => ({ s: idx.get(r.from), t: idx.get(r.to), rel: r }))
  const n = nodes.length
  if (!n) return { nodes, edges }
  const deg = new Array(n).fill(0)
  for (const e of edges) { deg[e.s]++; deg[e.t]++ }
  // 没有关系的人物不参与模拟（否则会被斥力推得很远），最后排在关系网下方
  const live = nodes.map((_, i) => i).filter(i => deg[i])
  const m = live.length
  const k = Math.sqrt((700 * 560) / Math.max(1, m)) * 0.8
  const warm = live.some(i => prev[nodes[i].id])
  const iters = warm ? 120 : 450
  let temp = warm ? k * 0.5 : k * 2
  for (let it = 0; it < iters && m; it++) {
    const dx = new Float64Array(n), dy = new Float64Array(n)
    for (let a = 0; a < m; a++) {
      const i = live[a]
      for (let b = a + 1; b < m; b++) {
        const j = live[b]
        let x = nodes[i].x - nodes[j].x, y = nodes[i].y - nodes[j].y
        let d2 = x * x + y * y
        if (d2 < 0.01) { x = Math.random() - 0.5; y = Math.random() - 0.5; d2 = 0.5 }
        const d = Math.sqrt(d2)
        const min = nodes[i].r + nodes[j].r + 46
        const f = (k * k) / d + (d < min ? (min - d) * 4 : 0)
        dx[i] += (x / d) * f; dy[i] += (y / d) * f
        dx[j] -= (x / d) * f; dy[j] -= (y / d) * f
      }
    }
    for (const e of edges) {
      const a = nodes[e.s], b = nodes[e.t]
      const x = a.x - b.x, y = a.y - b.y
      const d = Math.sqrt(x * x + y * y) || 0.01
      const f = (d * d) / k / Math.max(1, Math.min(deg[e.s], deg[e.t]) * 0.6)
      dx[e.s] -= (x / d) * f; dy[e.s] -= (y / d) * f
      dx[e.t] += (x / d) * f; dy[e.t] += (y / d) * f
    }
    for (const i of live) {
      dx[i] -= nodes[i].x * 0.09
      dy[i] -= nodes[i].y * 0.09
      const d = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]) || 1
      const step = Math.min(d, temp)
      nodes[i].x += (dx[i] / d) * step
      nodes[i].y += (dy[i] / d) * step
    }
    temp = Math.max(1, temp * 0.985)
  }
  const lone = nodes.filter((_, i) => !deg[i])
  if (lone.length) {
    let x0 = 0, x1 = 0, y1 = 0
    if (m) {
      x0 = Math.min(...live.map(i => nodes[i].x)); x1 = Math.max(...live.map(i => nodes[i].x))
      y1 = Math.max(...live.map(i => nodes[i].y + nodes[i].r))
    }
    const cols = Math.max(1, Math.min(lone.length, Math.floor((x1 - x0) / 110) + 1))
    lone.forEach((nd, i) => {
      const p = prev[nd.id]
      if (p && warm) return
      nd.x = (x0 + x1) / 2 + ((i % cols) - (cols - 1) / 2) * 110
      nd.y = y1 + 90 + Math.floor(i / cols) * 80
    })
  }
  return { nodes, edges }
}

export function graphBBox(nodes) {
  if (!nodes.length) return { x: -100, y: -100, w: 200, h: 200 }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const n of nodes) {
    x0 = Math.min(x0, n.x - n.r - 40); x1 = Math.max(x1, n.x + n.r + 40)
    y0 = Math.min(y0, n.y - n.r); y1 = Math.max(y1, n.y + n.r + 24)
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

// ---------- 导出 Markdown ----------
export function toMarkdown(map, record) {
  const L = [`# 《${record.title}》思维导图`, '']
  if (record.author) L.push(`作者：${record.author}`, '')
  if (map.summary) L.push(`> ${map.summary}`, '')
  if (map.themes?.length) {
    L.push('## 主题', '')
    for (const t of map.themes) L.push(`- **${t.name}**${t.desc ? `：${t.desc}` : ''}`)
    L.push('')
  }
  if (map.characters?.length) {
    L.push('## 人物', '')
    const groups = [...new Set(map.characters.map(c => c.group || '其他'))]
    for (const g of groups) {
      if (groups.length > 1) L.push(`### ${g}`, '')
      for (const c of map.characters.filter(c => (c.group || '其他') === g)) {
        L.push(`- **${c.name}**（${c.role}）${c.aliases?.length ? `　又称：${c.aliases.join('、')}` : ''}`)
        if (c.desc) L.push(`  - ${c.desc}`)
        if (c.traits?.length) L.push(`  - 特点：${c.traits.join('、')}`)
        if (c.arc) L.push(`  - 经历：${c.arc}`)
      }
      L.push('')
    }
  }
  if (map.relations?.length) {
    L.push('## 人物关系', '')
    for (const r of map.relations) L.push(`- ${r.from} — ${r.to}：${r.type}${r.desc ? `（${r.desc}）` : ''}`)
    L.push('')
  }
  if (map.conceptCategories?.length) {
    L.push('## 核心概念', '')
    for (const c of map.conceptCategories) {
      L.push(`### ${c.name}`, '')
      for (const i of c.items) L.push(`- **${i.name}**${i.desc ? `：${i.desc}` : ''}${i.related?.length ? `（相关：${i.related.join('、')}）` : ''}`)
      L.push('')
    }
  }
  if (map.timeline?.length) {
    L.push('## 情节脉络', '')
    map.timeline.forEach((e, i) => L.push(`${i + 1}. **${e.title}**${e.chapter ? `〔${e.chapter}〕` : ''}${e.desc ? `：${e.desc}` : ''}`))
    L.push('')
  }
  if (map.places?.length) {
    L.push('## 地点', '')
    for (const p of map.places) L.push(`- **${p.name}**${p.desc ? `：${p.desc}` : ''}`)
    L.push('')
  }
  return L.join('\n')
}
