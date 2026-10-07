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

const usage = (n: number) => ({
  model: 'claude-opus-5-5',
  input_tokens: n, output_tokens: n, cache_read_input_tokens: n, cache_creation_input_tokens: n,
})

const turn = (turnId: string, n: number, agentId?: string) => ({
  reason: 'answer' as const, answer: 'done', durationMs: 10, isAborted: false, turnId,
  usage: usage(n), ...(agentId ? { agentId } : {}),
})

const BAND = {
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking: false, maxRows: 10, columns: 120 } as never,
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
  on('session.usage', () => ({
    value: {
      startedAt: 1000,
      context: { window: 200_000, tokens: 64_000, percent: 32 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 85 }],
    },
  }) as never)
  on('settings.read', () => ({ value: world.settings }))
  on('turn.complete', ($, e) => ({ text: e.answer, usage: e.usage }))
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
  await $.turn.complete(turn('t2', 1_000))
  await $.turn.complete(turn('sub', 50_000, 'agent-1'))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'total-stats', surface, ...BAND })
    const line = await ui.find({ type: 'Text', text: /Opus 5\.5/ })

    expect(line?.props.wrap).toBe('truncate-end')
    expect(line?.text).toBe('🧠 Opus 5.5 · medium · ⚡fast · ctx ███████░░░ 68% · 5h 85% · 직전 4.0k · 세션 244.0k')

    const pieces = spans(line)
    expect(pieces['🧠 Opus 5.5']).toBe('claude')
    expect(pieces['medium']).toBe('suggestion')
    expect(pieces['⚡fast']).toBe('warning')
    expect(pieces['███████']).toBe('success')
    expect(pieces[' 68%']).toBe('success')
    expect(pieces['85%']).toBe('error')

    expect(await ui.find({ type: 'Text', text: 'engine' })).toBeDefined()
    await ui.unmount()
  }
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
  const line = await ui.find({ type: 'Text', text: /Sonnet 5\.5/ })
  expect(line?.text).toContain('🧠 Sonnet 5.5 · xhigh · fast off')
  await ui.unmount()

  world.settings = { fastMode: true, modelSettings: { 'claude-sonnet-5-5': { effortLevel: 'low' } } }
  await $.classic.ConfigChange({ source: 'user_settings' } as never)

  const again = await $.ui.mount({ plugin: 'total-stats', surface: 'terminal', ...BAND })
  expect((await again.find({ type: 'Text', text: /Sonnet 5\.5/ }))?.text).toContain('🧠 Sonnet 5.5 · low · ⚡fast')
  await again.unmount()
})
