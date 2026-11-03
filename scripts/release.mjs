// 发布新版本到 GitHub Releases，已安装的客户端会自动检测并更新
//   npm run release            发布 package.json 里的当前版本
//   npm run release -- patch   先升版本号（patch | minor | major | 1.2.3），再发布
// 需要已登录的 gh（gh auth login）；安装包较大，用 gh 上传比 electron-builder 自带的上传稳定
import { execSync } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'

const run = cmd => execSync(cmd, { stdio: 'inherit' })
const out = cmd => execSync(cmd, { encoding: 'utf8' }).trim()
const fail = msg => { console.error('\n✖ ' + msg); process.exit(1) }

try { out('gh auth status') } catch { fail('需要先登录 GitHub：gh auth login') }
if (out('git status --porcelain')) fail('工作区有未提交的修改，请先提交。')

const bump = process.argv[2]
if (bump) run(`npm version ${bump} -m "v%s"`) // 自动提交并打 tag

const { version, productName } = JSON.parse(readFileSync('package.json', 'utf8'))
const tag = 'v' + version
if (out(`git ls-remote --tags origin ${tag}`)) fail(`${tag} 已经发布过，请升级版本号：npm run release -- patch`)
if (!out(`git tag -l ${tag}`)) run(`git tag ${tag}`)

console.log(`\n▶ 打包 ${tag}`)
run('npx vite build')
run('npx electron-builder --win --x64 --publish never')

console.log(`\n▶ 推送代码和 ${tag}`)
run('git push origin HEAD')
run(`git push origin ${tag}`)

// 发布说明：上个版本以来的提交标题
const prev = out(`git tag -l "v*" --sort=-v:refname`).split('\n').find(t => t && t !== tag)
const log = out(`git log ${prev ? prev + '..' : ''}${tag} --format="- %s"`).split('\n').filter(l => !/^- v\d/.test(l))
const notes = `${log.join('\n') || '- 改进与修复'}\n\n已安装 1.1.0 及以上版本的会自动更新；首次安装请下载下方的 **AI-Reader-Setup-${version}.exe**。`
writeFileSync('release/notes.md', notes)

console.log(`\n▶ 上传到 GitHub Releases`)
const files = [`AI-Reader-Setup-${version}.exe`, `AI-Reader-Setup-${version}.exe.blockmap`, 'latest.yml'].map(f => `"release/${f}"`).join(' ')
run(`gh release create ${tag} ${files} --title "${productName} ${version}" --notes-file release/notes.md`)

console.log(`\n✔ 已发布 ${tag}：https://github.com/Liyucheng1997/ai-reader/releases/tag/${tag}`)
