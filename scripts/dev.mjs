// 开发模式：启动 Vite 开发服务器，再用 Electron 打开它
import { createServer } from 'vite'
import { spawn } from 'child_process'
import electron from 'electron'

const server = await createServer({ configFile: 'vite.config.js' })
await server.listen()
const url = server.resolvedUrls.local[0]
console.log('Vite dev server:', url)

const child = spawn(electron, ['.', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_URL: url },
})
child.on('close', async code => {
  await server.close()
  process.exit(code ?? 0)
})
