import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

type Node = { props?: { color?: unknown }; children?: unknown[] }

// 줄 안의 글자 조각마다 색을 모읍니다: { '🧠 Opus 5.5': 'claude', ... }
const spans = (node: unknown, out: Record<string, unknown> = {}) => {
  const { props, children = [] } = (node ?? {}) as Node
  if (children.length > 0 && children.every(c => typeof c === 'string')) {
    out[children.join('')] = props?.color
  }
  for (const c of children) if (typeof c === 'object') spans(c, out)
  return out
}

type Drawn = { type: string; props?: Record<string, unknown>; hover?: Record<string, unknown>; children?: unknown[] }

// 그려진 트리에서 hover가 달린 요소를 모두 모읍니다(find 결과에는 hover가 빠져 있습니다).
const hovers = (node: unknown, out: Drawn[] = []) => {
  const el = node as Drawn
  if (el?.hover) out.push(el)
  for (const c of el?.children ?? []) if (typeof c === 'object') hovers(c, out)
  return out
}

const usage = (n: number) => ({
  model: 'claude-opus-5-5',
  input_tokens: n, output_tokens: n, cache_read_input_tokens: n, cache_creation_input_tokens: n,
})

const turn = (turnId: string, n: number, agentId?: string, durationMs = 10) => ({
  reason: 'answer' as const, answer: 'done', durationMs, isAborted: false, turnId,
  usage: usage(n), ...(agentId ? { agentId } : {}),
})

const BAND = {
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking: false, maxRows: 10, columns: 120 } as never,
}

const NOW = Date.parse('2026-10-07T12:00:00Z')
const HOUR = 3_600_000

const part = (name: string, tokens: number, color: string, kind = 'used') =>
  ({ name, tokens, color, kind, isDeferred: false })

const BREAKDOWN = {
  rawMaxTokens: 200_000,
  categories: [
    part('System prompt', 4_000, 'promptBorder'),
    part('Messages', 50_000, 'claude'),
    part('MCP tools', 10_000, 'nope-not-a-theme-key'),
    part('Free space', 100_000, 'inactive', 'free'),
  ],
}

// 세션 값을 바꿀 수 있게 열어 둔 가짜 엔진
const engine = (on: On) => {
  const world = {
    model: 'claude-opus-5-5',
    settings: { fastMode: true, modelSettings: { 'claude-opus-5-5': { effortLevel: 'medium' } } } as Record<string, unknown>,
  }
  mock.store(on)
  on('session.id', () => ({ value: 'now' }))
  on('session.model', () => ({ value: world.model }))
  on('session.usage', ($, e) => ({
    value: {
      startedAt: 1000,
      context: {
        window: 200_000, tokens: 64_000, percent: 32,
        ...((e as { breakdown?: string }).breakdown ? { breakdown: BREAKDOWN } : {}),
      },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 85, resetsAt: new Date(NOW + 2 * HOUR + 13 * 60_000).toISOString() },
        { kind: 'seven_day', percentUsed: 40, resetsAt: new Date(NOW + 3 * 24 * HOUR + 4 * HOUR).toISOString() },
      ],
    },
  }) as never)
  on('clock.now', () => ({ value: NOW }) as never)
  on('settings.read', () => ({ value: world.settings }))
  on('turn.complete', ($, e) => ({ text: e.answer, usage: e.usage }))
  on('skill.prompt', ($, e) => ({ text: e.text }))
  on('classic.PostModelSwitch', () => ({}) as never)
  on('classic.ConfigChange', () => ({}) as never)
  // 엔진이 원래 그리는 줄 대신
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  return world
}

test('입력창 위 한 줄에 색으로 구분된 통계가 나오고, 아래 줄도 함께 그린다', async ($, on) => {
  engine(on)
  await $.turn.complete(turn('t1', 10_000))
  await $.turn.complete(turn('t2', 1_000, undefined, 83_000))
  await $.turn.complete(turn('sub', 50_000, 'agent-1', 999_000))
  await $.skill.prompt({ skill: 'commit', text: 'x' })
  await $.skill.prompt({ skill: 'review', text: 'y' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'total-stats', surface, ...BAND })
    const line = await ui.find({ key: 'line' })

    expect(line?.props.height).toBe(1)
    expect(line?.text).toBe('🧠 Opus 5.5 · medium · ⚡fast · ctx ███████░░░ 68% · 남은 5h 15% 주 60% · 직전 4.0k (1m23s) · 세션 2턴 244.0k · 스킬 2')

    const pieces = spans(line)
    // 모델과 effort는 누를 수 있는 버튼이다.
    for (const [key, label] of [['model', '🧠 Opus 5.5'], ['effort', 'medium']]) {
      const button = await ui.find({ key })
      expect(button?.type).toBe('Button')
      expect(button?.text).toBe(label)
    }
    expect(pieces['⚡fast']).toBe('warning')
    expect(pieces['███████']).toBe('success')
    expect(pieces[' 68%']).toBe('success')
    // 한도는 남은 용량으로: 5시간은 15% 남아 빨강, 주간은 60% 남아 초록
    expect(pieces['15%']).toBe('error')
    expect(pieces['60%']).toBe('success')
    expect(pieces[' (1m23s)']).toBe('suggestion')

    expect(await ui.find({ type: 'Text', text: 'engine' })).toBeDefined()
    await ui.unmount()
  }
})

test('ctx와 5h에 마우스를 올리면 뜨는 카드에 컨텍스트 내역과 한도 리셋 시간이 있다', async ($, on) => {
  engine(on)
  await $.turn.complete(turn('t1', 1_000))

  const ui = await $.ui.mount({ plugin: 'total-stats', surface: 'terminal', ...BAND })

  // ctx·5h 조각과 각 카드는 같은 hover 묶음이고, 카드는 평소엔 숨어 있다가 줄 위에 펼쳐진다.
  // drawn()은 터미널이 그릴 수 없는 트리면 실패하므로, 카드 모양이 받아들여지는지도 함께 본다.
  const hovered = hovers(await ui.drawn())
  for (const scope of ['total-stats-ctx', 'total-stats-limit']) {
    expect(hovered.some(el => el.type === 'Text' && el.hover?.scope === scope && el.hover?.underline === true)).toBe(true)
    const card = hovered.find(el => el.type === 'Box' && el.hover?.scope === scope)
    expect(card?.hover?.display).toBe('flex')
    expect(card?.props?.display).toBe('none')
    // 입력창 위 영역 밖으로 띄우면 잘려서 안 보이므로, 영역 안에 둔다.
    expect(card?.props?.position).toBeUndefined()
  }

  const title = await ui.find({ type: 'Text', text: /^컨텍스트 / })
  expect(title?.text).toBe('컨텍스트 64.0k / 200.0k')

  // 쓰인 항목만, 많은 순서대로. 남은 공간은 빠진다.
  const rows = (await ui.findAll({ type: 'Text', text: /█.*%$/ })).filter(r => /^[A-Za-z]/.test(r.text))
  const names = rows.map(r => r.text.split(' ')[0])
  expect(names).toEqual(['Messages', 'MCP', 'System'])
  const messages = rows.find(r => r.text.startsWith('Messages'))
  expect(messages?.text).toBe('Messages      ███░░░░░░░  50.0k 25%')
  expect(spans(messages)['███']).toBe('claude')
  // 테마에 없는 색 이름은 기본 색으로 바꾼다.
  expect(spans(rows.find(r => r.text.startsWith('MCP')))['█']).toBe('suggestion')

  expect((await ui.find({ type: 'Text', text: /^5시간 / }))?.text).toBe('5시간 15% 남음 (85% 사용) · 리셋까지 2h13m')
  expect((await ui.find({ type: 'Text', text: /^주간 / }))?.text).toBe('주간  60% 남음 (40% 사용) · 리셋까지 3d4h')
  await ui.unmount()
})

test('모델·effort·fast를 바꾸면 다음 요청을 기다리지 않고 바로 반영된다', async ($, on) => {
  const world = engine(on)
  await $.turn.complete(turn('t1', 1_000))

  world.model = 'claude-sonnet-5-5'
  world.settings = { fastMode: false, modelSettings: { 'claude-sonnet-5-5': { effortLevel: 'xhigh' } } }
  await $.classic.PostModelSwitch({
    from_model: 'claude-opus-5-5', to_model: 'claude-sonnet-5-5', requested_model: 'sonnet', source: 'command',
  } as never)

  const ui = await $.ui.mount({ plugin: 'total-stats', surface: 'terminal', ...BAND })
  const line = await ui.find({ key: 'line' })
  expect(line?.text).toContain('🧠 Sonnet 5.5 · xhigh · fast off')
  await ui.unmount()

  world.settings = { fastMode: true, modelSettings: { 'claude-sonnet-5-5': { effortLevel: 'low' } } }
  await $.classic.ConfigChange({ source: 'user_settings' } as never)

  const again = await $.ui.mount({ plugin: 'total-stats', surface: 'terminal', ...BAND })
  expect((await again.find({ key: 'line' }))?.text).toContain('🧠 Sonnet 5.5 · low · ⚡fast')
  await again.unmount()
})

test('모델이나 effort를 누르면 선택 창이 열리고, 고르면 /model·/effort가 실행되어 바로 반영된다', async ($, on) => {
  const world = engine(on)
  const opened: unknown[] = []
  const runs: string[] = []
  const toasts: string[] = []
  on('ui.open', ($, e) => { opened.push(e); return { value: undefined } as never })
  on('ui.toast', ($, e) => { toasts.push((e as { text: string }).text); return { value: undefined } as never })
  on('command.run', ($, e) => {
    runs.push(`/${e.command} ${e.args}`.trim())
    if (e.command === 'model' && e.args === 'sonnet') world.model = 'claude-sonnet-5-5'
    if (e.command === 'effort') world.settings = { ...world.settings, effortLevel: e.args, modelSettings: {} }
    return { text: `${e.command} → ${e.args}` } as never
  })
  await $.turn.complete(turn('t1', 1_000))

  const band = await $.ui.mount({ plugin: 'total-stats', surface: 'terminal', ...BAND })
  for (const key of ['model', 'effort']) {
    await $.ui.press({ plugin: 'total-stats', key })
  }
  expect(opened).toHaveLength(2)
  expect(opened[0]).toMatchObject({ id: 'total-stats-picker', focus: true, closeOnEscape: true })

  const picker = await $.ui.mount({
    plugin: 'total-stats', surface: 'terminal', component: 'Pane', requestId: 'total-stats-picker',
    props: {} as never,
  } as never)
  // 지금 쓰는 모델과 effort가 강조된다.
  expect((await picker.find({ key: 'pane-model-opus' }))?.props.variant).toBe('primary')
  expect((await picker.find({ key: 'pane-effort-medium' }))?.props.variant).toBe('primary')
  expect((await picker.find({ key: 'pane-model-sonnet' }))?.props.hotkey).toBe('2')

  await $.ui.press({ plugin: 'total-stats', key: 'pane-model-sonnet' })
  await $.ui.press({ plugin: 'total-stats', key: 'pane-effort-high' })
  // 입력창 위에 펼쳐지는 메뉴에서 바로 골라도 같다.
  await $.ui.press({ plugin: 'total-stats', key: 'band-effort-max' })
  expect(runs).toEqual(['/model sonnet', '/effort high', '/effort max'])
  expect(toasts).toEqual(['model → sonnet', 'effort → high', 'effort → max'])

  expect((await band.find({ key: 'line' }))?.text).toContain('🧠 Sonnet 5.5 · max')
  await picker.unmount()
  await band.unmount()
})

test('모델이나 effort에 마우스를 올리면 바로 위에 모델·effort 메뉴가 펼쳐진다', async ($, on) => {
  engine(on)
  await $.turn.complete(turn('t1', 1_000))
  const ui = await $.ui.mount({ plugin: 'total-stats', surface: 'terminal', ...BAND })

  const hovered = hovers(await ui.drawn())
  for (const key of ['model', 'effort']) {
    expect(hovered.find(el => el.type === 'Button' && el.props?.key === key)?.hover?.scope).toBe('total-stats-pick')
  }
  const menu = hovered.find(el => el.type === 'Box' && el.hover?.scope === 'total-stats-pick')
  expect(menu?.props?.display).toBe('none')
  expect(menu?.hover?.display).toBe('flex')

  // 메뉴 버튼에는 숫자 키가 없다(빈 입력창에서 숫자를 쳐도 모델이 바뀌지 않게).
  const opus = await ui.find({ key: 'band-model-opus' })
  expect(opus?.props.variant).toBe('primary')
  expect(opus?.props.hotkey).toBeUndefined()
  expect((await ui.find({ key: 'band-effort-medium' }))?.props.variant).toBe('primary')
  expect((await ui.findAll({ type: 'Button' })).map(b => b.text)).toEqual(
    ['Opus', 'Sonnet', 'Haiku', 'Fable', '더 보기', 'low', 'medium', 'high', 'xhigh', 'max', '켜짐 → 끄기', '🧠 Opus 5.5', 'medium', 'ctx', '남은'],
  )
  await ui.unmount()
})

test('fast를 메뉴에서 켜고 끄고, 크레딧이 없어 못 켜는 환경이면 빨간색으로 바뀐다', async ($, on) => {
  const world = engine(on)
  let isAllowed = true
  on('ui.toast', () => ({ value: undefined }) as never)
  on('command.run', ($, e) => {
    if (e.command !== 'fast') return { text: '' } as never
    if (!isAllowed) return { text: 'Fast mode requires extra usage credits' } as never
    world.settings = { ...world.settings, fastMode: world.settings.fastMode !== true }
    return { text: 'Fast mode toggled' } as never
  })
  await $.turn.complete(turn('t1', 1_000))
  const ui = await $.ui.mount({ plugin: 'total-stats', surface: 'terminal', ...BAND })
  const line = async () => (await ui.find({ key: 'line' }))?.text

  // fast 글자에 마우스를 올려도 같은 메뉴가 펼쳐진다.
  expect(hovers(await ui.drawn()).some(el => el.type === 'Text' && el.hover?.scope === 'total-stats-pick')).toBe(true)

  await $.ui.press({ plugin: 'total-stats', key: 'band-fast-toggle' })
  expect(await line()).toContain('fast off')
  expect((await ui.find({ key: 'band-fast-toggle' }))?.text).toBe('꺼짐 → 켜기')

  isAllowed = false
  await $.ui.press({ plugin: 'total-stats', key: 'band-fast-toggle' })
  expect(await line()).toContain('⚡fast 불가')
  expect(spans(await ui.find({ key: 'line' }))['⚡fast 불가']).toBe('error')
  const reason = await ui.find({ type: 'Text', text: 'Fast mode requires extra usage credits' })
  expect(reason?.props.color).toBe('error')

  // 다시 켤 수 있게 되면 빨간 표시가 사라진다.
  isAllowed = true
  await $.ui.press({ plugin: 'total-stats', key: 'band-fast-toggle' })
  expect(await line()).toContain('⚡fast ·')
  await ui.unmount()
})

test('직접 입력한 /fast가 켜지지 않으면 빨갛게 표시하고, 세션 비용은 한도 카드에만 나온다', async ($, on) => {
  engine(on)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('session.measure', () => ({ changed: [] }) as never)
  on('command.run', () => ({ text: 'Fast mode OFF' }) as never)
  await $.turn.complete(turn('t1', 1_000))
  await $.session.measure({
    context: { window: 200_000, tokens: 64_000, percent: 32 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 85 }],
    cost: { usd: 0.31 },
  } as never)

  const ui = await $.ui.mount({ plugin: 'total-stats', surface: 'terminal', ...BAND })
  // 설정상 fast가 켜져 있던 상태에서 /fast를 치면 꺼지는 것이니 빨간색이 아니다.
  await $.command.run({ command: 'fast', args: '' })
  expect((await ui.find({ key: 'line' }))?.text).toContain('fast off')

  // 꺼진 상태에서 켜려고 쳤는데 그대로 OFF면 빨간색이고, 메뉴에 짐작되는 이유가 나온다.
  await $.command.run({ command: 'fast', args: '' })
  const line = await ui.find({ key: 'line' })
  expect(line?.text).toContain('⚡fast 불가')
  expect(spans(line)['⚡fast 불가']).toBe('error')
  expect((await ui.find({ type: 'Text', text: /^켜지지 않았어요/ }))?.props.color).toBe('error')

  // $는 줄에서 빠지고 한도 카드에만 있다.
  expect(line?.text).not.toContain('$')
  expect((await ui.find({ type: 'Text', text: /API 환산 비용/ }))?.text).toBe('이번 세션 API 환산 비용 $0.31')
  await ui.unmount()
})

test('ctx를 누르면 /context, 남은 용량을 누르면 /usage가 실행된다', async ($, on) => {
  engine(on)
  const runs: string[] = []
  on('command.run', ($, e) => { runs.push(`/${e.command}`); return { text: '' } as never })
  await $.turn.complete(turn('t1', 1_000))
  const ui = await $.ui.mount({ plugin: 'total-stats', surface: 'terminal', ...BAND })

  // 버튼이 돼도 줄 모양은 그대로다.
  expect((await ui.find({ key: 'line' }))?.text).toContain('ctx ███████░░░ 68% · 남은 5h 15% 주 60%')
  // 버튼에 마우스를 올려도 카드가 펼쳐진다.
  const hovered = hovers(await ui.drawn())
  expect(hovered.find(el => el.props?.key === 'ctx')?.hover?.scope).toBe('total-stats-ctx')
  expect(hovered.find(el => el.props?.key === 'usage')?.hover?.scope).toBe('total-stats-limit')

  await $.ui.press({ plugin: 'total-stats', key: 'ctx' })
  await $.ui.press({ plugin: 'total-stats', key: 'usage' })
  expect(runs).toEqual(['/context', '/usage'])
  await ui.unmount()
})

test('컨텍스트가 20% 이하로 남으면 경고와 /compact 버튼이 뜨고, 누르면 /compact가 실행된다', async ($, on) => {
  engine(on)
  const runs: string[] = []
  on('command.run', ($, e) => { runs.push(`/${e.command}`); return { text: '' } as never })
  on('session.measure', () => ({ changed: [] }) as never)
  await $.turn.complete(turn('t1', 1_000))
  const ui = await $.ui.mount({ plugin: 'total-stats', surface: 'terminal', ...BAND })

  // 68% 남았을 때는 없다.
  expect(await ui.find({ key: 'compact' })).toBeUndefined()

  await $.session.measure({
    context: { window: 200_000, tokens: 170_000, percent: 85 },
    rateLimits: [],
  } as never)
  const line = await ui.find({ key: 'line' })
  expect(line?.text).toContain('ctx ██░░░░░░░░ 15% ⚠ 곧 가득 참 /compact')
  expect(spans(line)[' ⚠ 곧 가득 참 ']).toBe('error')
  expect((await ui.find({ key: 'compact' }))?.props.variant).toBe('primary')

  await $.ui.press({ plugin: 'total-stats', key: 'compact' })
  expect(runs).toEqual(['/compact'])
  await ui.unmount()
})
