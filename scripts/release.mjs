// 发布新版本到 GitHub Releases，已安装的客户端会自动检测并更新
//   npm run release            发布 package.json 里的当前版本
//   npm run release -- patch   先升版本号（patch | minor | major | 1.2.3），再发布
import { execSync } from 'child_process'
import { readFileSync } from 'fs'

const run = (cmd, env) => execSync(cmd, { stdio: 'inherit', env: { ...process.env, ...env } })
const out = cmd => execSync(cmd, { encoding: 'utf8' }).trim()
const fail = msg => { console.error('\n✖ ' + msg); process.exit(1) }

if (out('git status --porcelain')) fail('工作区有未提交的修改，请先提交。')

const bump = process.argv[2]
if (bump) run(`npm version ${bump} -m "v%s"`) // 自动提交并打 tag

const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
const tag = 'v' + version
if (out(`git ls-remote --tags origin ${tag}`)) fail(`${tag} 已经发布过，请升级版本号：npm run release -- patch`)
if (!out(`git tag -l ${tag}`)) run(`git tag ${tag}`)

let token = process.env.GH_TOKEN
if (!token) {
  try { token = out('gh auth token') } catch { fail('需要 GitHub 令牌：先运行 gh auth login，或设置环境变量 GH_TOKEN。') }
}

console.log(`\n▶ 推送代码和 ${tag}`)
run('git push origin HEAD')
run(`git push origin ${tag}`)

console.log(`\n▶ 打包并上传 ${tag}`)
run('npx vite build')
run('npx electron-builder --win --x64 --publish always', { GH_TOKEN: token })

console.log(`\n✔ 已发布 ${tag}：https://github.com/Liyucheng1997/ai-reader/releases/tag/${tag}`)
