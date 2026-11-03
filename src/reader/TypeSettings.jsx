import { useEffect } from 'react'
import { Minus, Plus, BookOpen, ScrollText, Columns2, Square, AlignJustify, AlignLeft } from 'lucide-react'
import { useLib } from '../App.jsx'
import { BG_THEMES, FONTS } from './theme.js'

// “Aa”排版面板：主题、字体、字号、行距、页边距、翻页方式
export default function TypeSettings({ isFixed, onClose }) {
  const lib = useLib()
  useEffect(() => {
    const off = e => { if (!e.target.closest('.type-pop, .type-toggle')) onClose() }
    window.addEventListener('mousedown', off)
    return () => window.removeEventListener('mousedown', off)
  }, [onClose])
  const r = lib.settings.reader
  const set = patch => lib.updateSettings({ reader: patch })
  const Stepper = ({ k, step, min, max, fmt = v => v }) => (
    <div className="stepper">
      <button onClick={() => set({ [k]: Math.max(min, +(r[k] - step).toFixed(2)) })} disabled={r[k] <= min}><Minus size={14} /></button>
      <span className="tabular">{fmt(r[k])}</span>
      <button onClick={() => set({ [k]: Math.min(max, +(r[k] + step).toFixed(2)) })} disabled={r[k] >= max}><Plus size={14} /></button>
    </div>
  )
  return (
    <div className="type-pop" onMouseDown={e => e.stopPropagation()}>
      <div className="tp-label">背景</div>
      <div className="bg-row">
        <button className={`bg-swatch auto ${r.bg === 'auto' ? 'active' : ''}`} onClick={() => set({ bg: 'auto' })} title="跟随外观">A</button>
        {Object.entries(BG_THEMES).map(([k, t]) => (
          <button key={k} className={`bg-swatch ${r.bg === k ? 'active' : ''}`} title={t.name}
            style={{ background: t.bg, color: t.fg }} onClick={() => set({ bg: k })}>文</button>
        ))}
      </div>

      {isFixed ? (
        <>
          <div className="tp-label">缩放</div>
          <div className="seg full">
            {[['fit-page', '适应页面'], ['fit-width', '适应宽度']].map(([v, l]) => (
              <button key={v} className={r.pdfZoom === v ? 'active' : ''} onClick={() => set({ pdfZoom: v })}>{l}</button>
            ))}
          </div>
          <div className="tp-label">页面</div>
          <div className="seg full">
            <button className={r.columns === 1 ? 'active' : ''} onClick={() => set({ columns: 1 })}><Square size={14} />单页</button>
            <button className={r.columns === 2 ? 'active' : ''} onClick={() => set({ columns: 2 })}><Columns2 size={14} />双页</button>
          </div>
          <div className="tp-hint">切换单双页后需重新打开这本书</div>
        </>
      ) : (
        <>
          <div className="tp-label">字体</div>
          <div className="font-grid">
            {FONTS.map(([k, name, fam]) => (
              <button key={k} className={`font-btn ${r.fontFamily === k ? 'active' : ''}`} style={fam ? { fontFamily: fam } : null}
                onClick={() => set({ fontFamily: k })}>{name}</button>
            ))}
          </div>
          <div className="tp-row"><span>字号</span><Stepper k="fontSize" step={1} min={12} max={36} fmt={v => `${v}px`} /></div>
          <div className="tp-row"><span>行距</span><Stepper k="lineHeight" step={0.1} min={1.2} max={2.6} fmt={v => v.toFixed(1)} /></div>
          <div className="tp-row"><span>段距</span><Stepper k="paraSpacing" step={0.2} min={0} max={2} fmt={v => v.toFixed(1)} /></div>
          <div className="tp-row"><span>上下边距</span><Stepper k="margin" step={8} min={16} max={120} fmt={v => `${v}`} /></div>
          <div className="tp-row"><span>版心宽度</span><Stepper k="maxWidth" step={40} min={480} max={1400} fmt={v => `${v}`} /></div>
          <div className="tp-label">翻页方式</div>
          <div className="seg full">
            <button className={r.flow === 'paginated' ? 'active' : ''} onClick={() => set({ flow: 'paginated' })}><BookOpen size={14} />分页</button>
            <button className={r.flow === 'scrolled' ? 'active' : ''} onClick={() => set({ flow: 'scrolled' })}><ScrollText size={14} />滚动</button>
          </div>
          <div className="tp-label">分栏</div>
          <div className="seg full">
            <button className={r.columns === 1 ? 'active' : ''} onClick={() => set({ columns: 1 })}><Square size={14} />单栏</button>
            <button className={r.columns === 2 ? 'active' : ''} onClick={() => set({ columns: 2 })}><Columns2 size={14} />双栏</button>
          </div>
          <div className="tp-label">对齐</div>
          <div className="seg full">
            <button className={r.justify ? 'active' : ''} onClick={() => set({ justify: true })}><AlignJustify size={14} />两端对齐</button>
            <button className={!r.justify ? 'active' : ''} onClick={() => set({ justify: false })}><AlignLeft size={14} />左对齐</button>
          </div>
        </>
      )}
    </div>
  )
}
