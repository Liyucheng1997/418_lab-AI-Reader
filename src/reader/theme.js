// 阅读区主题与排版 CSS（注入到书页 iframe 内）

export const BG_THEMES = {
  white: { name: '白', bg: '#ffffff', fg: '#1d1d1f', link: '#0071e3' },
  sepia: { name: '米黄', bg: '#f5eedc', fg: '#3f3222', link: '#8a5a00' },
  green: { name: '护眼', bg: '#e1ebd8', fg: '#25331f', link: '#2e6b2b' },
  gray: { name: '浅灰', bg: '#ececef', fg: '#1d1d1f', link: '#0071e3' },
  dark: { name: '夜间', bg: '#1c1c1e', fg: '#cfcfd4', link: '#409cff', dark: true },
}

export const FONTS = [
  ['original', '书籍原字体', ''],
  ['sans', '黑体', '"PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif'],
  ['serif', '宋体', '"Songti SC", "Noto Serif SC", "Source Han Serif SC", SimSun, serif'],
  ['kai', '楷体', '"Kaiti SC", STKaiti, KaiTi, serif'],
  ['fangsong', '仿宋', 'STFangsong, FangSong, serif'],
]

export const HIGHLIGHT_COLORS = [
  ['yellow', '#ffd60a'],
  ['green', '#34c759'],
  ['blue', '#0a84ff'],
  ['pink', '#ff375f'],
  ['purple', '#bf5af2'],
]
export const colorOf = name => HIGHLIGHT_COLORS.find(c => c[0] === name)?.[1] || name

export function isAppDark(themeSetting) {
  return themeSetting === 'dark' || (themeSetting === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
}

export function resolveTheme(bg, appDark) {
  if (bg === 'auto') return appDark ? BG_THEMES.dark : BG_THEMES.white
  return BG_THEMES[bg] || BG_THEMES.white
}

export function bookCSS(r, theme) {
  const family = FONTS.find(f => f[0] === r.fontFamily)?.[2]
  return `
    @namespace epub "http://www.idpf.org/2007/ops";
    html { color-scheme: ${theme.dark ? 'dark' : 'light'}; color: ${theme.fg} !important; background: transparent !important; }
    html, body { font-size: ${r.fontSize}px !important; ${family ? `font-family: ${family} !important;` : ''} }
    body { background: transparent !important; color: ${theme.fg} !important; }
    ${family ? `body * { font-family: inherit !important; }` : ''}
    ${theme.dark ? `body *:not(a):not(img):not(svg):not(svg *) { color: inherit !important; background-color: transparent !important; border-color: #3a3a3c !important; }` : ''}
    p, li, blockquote, dd, div { line-height: ${r.lineHeight} !important; }
    p { text-align: ${r.justify ? 'justify' : 'start'}; margin-top: ${r.paraSpacing}em !important; margin-bottom: ${r.paraSpacing}em !important; }
    [align="left"] { text-align: left; } [align="right"] { text-align: right; } [align="center"] { text-align: center; }
    a:link, a:visited { color: ${theme.link} !important; }
    img, svg, video { max-width: 100%; height: auto; }
    ${theme.dark ? 'img { filter: brightness(.85); }' : ''}
    pre { white-space: pre-wrap !important; }
    ::selection { background: rgba(10, 132, 255, .28); }
    aside[epub|type~="endnote"], aside[epub|type~="footnote"], aside[epub|type~="note"], aside[epub|type~="rearnote"] { display: none; }
  `
}
