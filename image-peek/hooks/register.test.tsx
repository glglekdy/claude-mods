import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

const BAND = {
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking: false, maxRows: 10, columns: 120 } as never,
}

const ORCA = 'C:\\Temp\\orca-paste-1-abc.png'
const CLIP = 'C:\\Temp\\55521830.tmp.png'

// 엔진 대신: 붙여 넣은 이미지 경로를 [Image #n] 자리표시자로 바꿔 넣는 입력창
const composer = (on: On) => {
  let count = 0
  on('prompt.edit', ($, e) => {
    const inputText = /\.png$/.test(e.inputText) ? `[Image #${++count}]` : e.inputText
    const text = e.text.slice(0, e.start) + inputText + e.text.slice(e.end)
    return { text, cursor: e.start + inputText.length } as never
  })
}

const edit = (text: string, start: number, end: number, inputText: string) => ({
  origin: { kind: 'composer' as const }, text, cursor: start, start, end, inputText,
})

test('입력창에 붙여 넣은 이미지가 보내기 전에 목록에 나오고, 누르면 원본을 연다', async ($, on) => {
  mock.env(on, { TEMP: 'C:\\Temp' })
  mock.clock(on, { now: 100_000 })
  composer(on)
  on('fs.list', () => ({
    value: [
      { name: 'old.png', kind: 'file', size: 1, mtimeMs: 1_000, isLink: false },
      { name: '55521830.tmp.png', kind: 'file', size: 1, mtimeMs: 99_000, isLink: false },
    ],
  }) as never)
  const runs: (readonly string[])[] = []
  on('process.run', ($, e) => {
    runs.push(e.argv)
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  on('prompt.submit', ($, e) => ({ text: e.text }) as never)
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  // 1) Orca가 붙여 넣은 파일 경로 → [Image #1]
  await $.prompt.edit(edit('봐줘 ', 3, 3, ORCA))
  // 2) 경로 없이 자리표시자만 들어온 경우 → 임시 폴더의 새 파일
  await $.prompt.edit(edit('봐줘 [Image #1]', 13, 13, ' [Image #2]'))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'image-peek', surface, ...BAND })
    expect(await ui.find({ type: 'Button', key: `Image 1:${ORCA}` })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: `Image 2:${CLIP}` })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'engine' })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ plugin: 'image-peek', surface: 'terminal', ...BAND })
  await ui.press({ key: `Image 1:${ORCA}` })
  expect(runs[0]?.join(' ')).toContain(`Start-Process -FilePath '${ORCA}'`)
  await ui.unmount()

  // 3) 자리표시자를 지우면 목록에서도 빠집니다.
  await $.prompt.edit(edit('봐줘 [Image #1] [Image #2]', 3, 14, ''))
  const fewer = await $.ui.mount({ plugin: 'image-peek', surface: 'terminal', ...BAND })
  expect(await fewer.find({ type: 'Button', key: `Image 1:${ORCA}` })).toBeUndefined()
  expect(await fewer.find({ type: 'Button', key: `Image 2:${CLIP}` })).toBeDefined()
  await fewer.unmount()

  // 4) 보내면 목록이 비고 아래 줄만 남습니다.
  await $.prompt.submit({ text: '봐줘 [Image #2]' } as never)
  const after = await $.ui.mount({ plugin: 'image-peek', surface: 'terminal', ...BAND })
  expect(await after.find({ type: 'Button', key: `Image 2:${CLIP}` })).toBeUndefined()
  expect(await after.find({ type: 'Text', text: 'engine' })).toBeDefined()
  await after.unmount()
})
