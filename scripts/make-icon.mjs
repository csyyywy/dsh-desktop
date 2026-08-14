// 把黑色鲸鱼 SVG 栅格化为图标（窗口/托盘/打包用）
// 产出：
//   resources/icons/icon.png       512x512 黑色（应用/安装器/窗口图标）
//   resources/icons/tray.png       32x32   黑色（托盘，浅色任务栏）
//   resources/icons/tray-white.png 32x32   白色（托盘，深色任务栏）
import { readFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import sharp from 'sharp'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const svgPath = join(root, 'resources', 'icon.svg')
const outDir = join(root, 'resources', 'icons')
const svg = readFileSync(svgPath, 'utf8')

mkdirSync(outDir, { recursive: true })

async function render(size, fill, out) {
  const replaced = svg.replace('fill="#000"', `fill="${fill}"`)
  await sharp(Buffer.from(replaced), { density: 300 })
    .resize(size, size)
    .png()
    .toFile(join(outDir, out))
  console.log('wrote', out)
}

await render(512, '#000', 'icon.png')
await render(32, '#000', 'tray.png')
await render(32, '#ffffff', 'tray-white.png')
console.log('icons done')
