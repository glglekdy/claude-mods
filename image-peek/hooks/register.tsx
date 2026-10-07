import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Peek } from '../types'

const images = atom({ plugin: 'image-peek', key: 'images' } as const, [])

// 붙여 넣은 글에 들어 있는 이미지 파일 경로 (따옴표로 감싸였어도)
const IMAGE_PATH = /[A-Za-z]:\\[^"'\r\n]*?\.(?:png|jpe?g|gif|webp|bmp)/i
// Claude Code가 입력창에 넣는 자리표시자: [Image #1]
const PLACEHOLDER = /\[Image #(\d+)\]/g
// 자리표시자가 생긴 순간에 만들어진 파일로 볼 시간 범위
const FRESH_MS = 15_000

// PowerShell 작은따옴표 문자열 안에 넣을 수 있게 합니다.
const quote = (s: string) => `'${s.replace(/'/g, "''")}'`

const basename = (path: string) => path.slice(Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')) + 1)

// 자리표시자 번호 → 원본 파일 경로 (못 찾으면 '')
let sources = new Map<number, string>()

// 붙여 넣은 직후 임시 폴더에 새로 생긴 이미지 파일을 찾습니다.
async function freshTempImage($: EngineInterface) {
  const temp = (await $.env.get('TEMP')) ?? (await $.env.get('TMP'))
  if (!temp) return ''
  const now = await $.clock.now()
  const entries = await $.fs.list(temp).catch(() => [])
  const newest = entries
    .filter(f => f.kind === 'file' && /\.(?:png|jpe?g|gif|webp|bmp)$/i.test(f.name) && now - f.mtimeMs < FRESH_MS)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
  return newest ? `${temp}\\${newest.name}` : ''
}

async function track($: EngineInterface, inputText: string, draft: string) {
  const pasted = IMAGE_PATH.exec(inputText)?.[0] ?? ''

  const list: Peek[] = []
  for (const [, n] of draft.matchAll(PLACEHOLDER)) {
    const num = Number(n)
    if (!sources.has(num)) sources.set(num, pasted || (await freshTempImage($)))
    list.push({ label: `Image ${num}`, path: sources.get(num) ?? '' })
  }
  // 터미널이 경로를 글자 그대로 넣은 경우도 목록에 올립니다.
  const raw = IMAGE_PATH.exec(draft)?.[0]
  if (raw) list.push({ label: basename(raw), path: raw })

  const current = await read($, images)
  if (JSON.stringify(current) !== JSON.stringify(list)) await update($, images, () => list)
}

async function openImage($: EngineInterface, path: string) {
  if (!path) {
    $.ui.toast('이 이미지의 원본 파일을 찾지 못했어요')
    return
  }
  const { exitCode } = await $.process.run([
    'powershell.exe', '-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath ${quote(path)}`,
  ])
  if (exitCode !== 0) $.ui.toast('이미지를 열지 못했어요')
}

export const register: Register = on => {
  sources = new Map()

  // 입력창이 바뀔 때마다, 지금 들어 있는 이미지 자리표시자로 목록을 맞춥니다.
  on('prompt.edit', async ($, e, next) => {
    const ran = await next(e)
    const isImageEdit = IMAGE_PATH.test(e.inputText) || e.inputText.includes('[Image') ||
      e.text.includes('[Image') || ran.text.includes('[Image') || IMAGE_PATH.test(ran.text)
    if (isImageEdit) await track($, e.inputText, ran.text)
    return ran
  }).catch(($, e, next) => next(e))

  // 보내고 나면 입력창이 비므로 목록도 비웁니다.
  on('prompt.submit', async ($, e, next) => {
    const ran = await next(e)
    await update($, images, () => [])
    return ran
  }).catch(($, e, next) => next(e))

  // 아래 플러그인(예: total-stats)이 그린 줄을 감싸서 함께 보여줍니다.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, images)
    if (e.props.hasSurvey || list.length === 0) return next(e)

    const below = await next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Box gap={1}>
          <Text dimColor>📎</Text>
          {list.map(img => (
            <Button key={`${img.label}:${img.path}`} label={img.label} onPress={() => openImage($, img.path)} />
          ))}
        </Box>
        {below}
      </Box>
    )
  })
}
