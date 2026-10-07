import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, ModelUsage, Register, SessionContextUsage, SessionRateLimit } from 'claude-code'

import type { Snapshot } from '../types'

type Tokens = {
  id: string
  startedAt: number
  last: number
  total: number
  usd: number
}

type Live = {
  model?: string
  effort?: string
  isFast?: boolean
  context?: SessionContextUsage
  rateLimits: SessionRateLimit[]
}

// 세션마다 자기 키에만 쓰므로 여러 창을 동시에 열어도 서로 덮어쓰지 않습니다.
const PREFIX = 'session:'
const KEEP = 20
const GAUGE = 10

const snapshot = atom({ plugin: 'total-stats', key: 'snapshot' } as const, null)

const compact = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`

const turnTokens = (u: ModelUsage) =>
  u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens + u.output_tokens

// claude-opus-5-5 → Opus 5.5
const modelName = (id: string) => {
  const [, family = '', major, minor] = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(id) ?? []
  return family ? `${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}.${minor}` : id
}

// 남은 양이 많을수록 초록, 적을수록 빨강
const levelColor = (left: number): Color =>
  left > 50 ? 'success' : left > 20 ? 'warning' : 'error'

// 모듈 변수는 리로드 때마다 새로 시작하므로, 토큰은 $.store에 둡니다.
let loading: Promise<Tokens> | undefined
let live: Live = { rateLimits: [] }
// 설정 파일의 effort가 바뀌었는지 알아보려고 지난번 값을 기억합니다.
let settingsEffort: string | undefined

async function readSettings($: EngineInterface, model: string) {
  const settings = await $.settings.read()
  const perModel = (settings.modelSettings as Record<string, { effortLevel?: string }> | undefined)?.[model]
  return {
    effort: perModel?.effortLevel ?? (settings.effortLevel as string | undefined),
    isFast: settings.fastMode === true,
  }
}

// 모델·effort·fast를 지금 값으로 맞추고, 바뀐 게 있으면 다시 그립니다.
async function refresh($: EngineInterface) {
  const model = await $.session.model()
  const { effort, isFast } = await readSettings($, model)
  const isModelChanged = model !== live.model
  const isEffortChanged = effort !== settingsEffort
  settingsEffort = effort
  // effort는 요청마다 실제 값(turn.step)도 들어오므로, 모델이나 설정이 바뀌었을 때만 덮어씁니다.
  const nextEffort = isModelChanged || isEffortChanged ? effort : live.effort
  if (!isModelChanged && nextEffort === live.effort && isFast === live.isFast) return
  live.model = model
  live.effort = nextEffort
  live.isFast = isFast
  await publish($)
}

async function readTokens($: EngineInterface): Promise<Tokens> {
  const id = await $.session.id()
  const usage = await $.session.usage()
  live.context ??= usage.context
  if (live.rateLimits.length === 0) live.rateLimits = usage.rateLimits

  live.model ??= await $.session.model()
  const { effort, isFast } = await readSettings($, live.model)
  settingsEffort ??= effort
  live.effort ??= effort
  live.isFast ??= isFast

  const keys = (await $.store.keys()).filter(k => k.startsWith(PREFIX))
  const all = (await Promise.all(keys.map(k => $.store.get(k)))) as Tokens[]
  const others = all.filter(t => t && t.id !== id).sort((a, b) => b.startedAt - a.startedAt)
  for (const old of others.slice(KEEP)) await $.store.delete(PREFIX + old.id)
  return all.find(t => t?.id === id) ?? { id, startedAt: usage.startedAt, last: 0, total: 0, usd: 0 }
}

function load($: EngineInterface) {
  loading ??= readTokens($)
  return loading
}

// 지금 값을 밴드가 읽는 상태에 씁니다. 쓰면 밴드가 다시 그려집니다.
async function publish($: EngineInterface) {
  const tokens = await load($)
  const used = live.context?.percent
  const next: Snapshot = {
    model: live.model,
    effort: live.effort,
    isFast: live.isFast === true,
    contextLeft: used === undefined ? undefined : Math.max(0, 100 - used),
    fiveHourUsed: live.rateLimits.find(r => r.kind === 'five_hour')?.percentUsed,
    last: tokens.last,
    total: tokens.total,
    usd: tokens.usd,
  }
  await update($, snapshot, () => next)
}

async function save($: EngineInterface, change: (t: Tokens) => void) {
  const tokens = await load($)
  change(tokens)
  await $.store.set(PREFIX + tokens.id, tokens)
}

export const register: Register = on => {
  loading = undefined
  live = { rateLimits: [] }
  settingsEffort = undefined

  on('session.start', async ($, e, next) => {
    const ran = await next(e)
    await publish($)
    // /model, /effort, /fast를 이벤트로 못 받는 경우에도 2초 안에 반영되게 확인합니다.
    $.clock.every(2000, () => refresh($))
    return ran
  })

  on('classic.PostModelSwitch', async ($, e, next) => {
    const ran = await next(e)
    await refresh($)
    return ran
  }).catch(($, e, next) => next(e))

  on('classic.ConfigChange', async ($, e, next) => {
    const ran = await next(e)
    await refresh($)
    return ran
  }).catch(($, e, next) => next(e))

  // 메인 대화의 요청마다 실제로 쓰인 모델과 effort를 읽습니다.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined && (e.model !== live.model || String(e.effort) !== live.effort)) {
      live.model = e.model
      live.effort = e.effort === undefined ? undefined : String(e.effort)
      await publish($)
    }
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    const usage = ran.usage ?? e.usage
    if (usage) {
      const n = turnTokens(usage)
      // 직전 대화는 메인 대화만, 세션 전체는 서브에이전트까지 셉니다.
      await save($, t => {
        if (e.agentId === undefined) t.last = n
        t.total += n
      })
      await publish($)
    }
    return ran
  })

  on('session.measure', async ($, e, next) => {
    const ran = await next(e)
    live.context = e.context
    live.rateLimits = e.rateLimits
    if (e.cost) {
      const usd = e.cost.usd
      await save($, t => { t.usd = usd })
    }
    await publish($)
    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, snapshot)
    if (e.props.hasSurvey || s === null) return next(e)
    // 아래 플러그인이 그린 줄도 함께 보여줍니다.
    const below = await next(e)

    const { Box, Text } = $.ui.resolve(e)
    const sep = <Text dimColor> · </Text>
    const filled = s.contextLeft === undefined ? 0 : Math.round((s.contextLeft / 100) * GAUGE)

    // 한 Text 안에 색깔별 조각을 넣어 한 줄로 그리고, 넘치면 끝을 자릅니다.
    return (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          {s.model ? <Text color="claude" bold>🧠 {modelName(s.model)}</Text> : null}
          {s.effort ? <Text>{sep}<Text color="suggestion" bold>{s.effort}</Text></Text> : null}
          {sep}
          {s.isFast ? <Text color="warning" bold>⚡fast</Text> : <Text dimColor>fast off</Text>}
          {s.contextLeft !== undefined ? (
            <Text>
              {sep}
              <Text dimColor>ctx </Text>
              <Text color={levelColor(s.contextLeft)}>{'█'.repeat(filled)}</Text>
              <Text dimColor>{'░'.repeat(GAUGE - filled)}</Text>
              <Text color={levelColor(s.contextLeft)} bold> {s.contextLeft}%</Text>
            </Text>
          ) : null}
          {s.fiveHourUsed !== undefined ? (
            <Text>
              {sep}
              <Text dimColor>5h </Text>
              <Text color={levelColor(100 - s.fiveHourUsed)} bold>{Math.round(s.fiveHourUsed)}%</Text>
            </Text>
          ) : null}
          {sep}
          <Text dimColor>직전 </Text>
          <Text bold>{compact(s.last)}</Text>
          {sep}
          <Text dimColor>세션 </Text>
          <Text bold>{compact(s.total)}</Text>
          {s.usd > 0 ? <Text color="success"> ${s.usd.toFixed(2)}</Text> : null}
        </Text>
        {below}
      </Box>
    )
  })
}
