import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, ModelUsage, Register, SessionContextUsage, SessionRateLimit } from 'claude-code'

import type { ContextPart, Snapshot } from '../types'

type Tokens = {
  id: string
  startedAt: number
  last: number
  total: number
  usd: number
  // 아래 셋은 나중에 더해서, 예전에 저장된 값에는 없을 수 있습니다.
  lastMs?: number
  turns?: number
  skills?: number
}

type Live = {
  model?: string
  effort?: string
  isFast?: boolean
  // fast를 켜려다 실패한 이유. 있으면 줄에 빨갛게 표시합니다.
  fastBlocked?: string
  context?: SessionContextUsage
  rateLimits: SessionRateLimit[]
  contextParts: ContextPart[]
  contextMax?: number
}

// 세션마다 자기 키에만 쓰므로 여러 창을 동시에 열어도 서로 덮어쓰지 않습니다.
const PREFIX = 'session:'
const KEEP = 20
const GAUGE = 10
// 마우스를 올리면 카드가 뜨는 묶음 이름
const CTX = 'total-stats-ctx'
const LIMIT = 'total-stats-limit'
const CARD_PARTS = 8
// 컨텍스트가 이만큼(%) 이하로 남으면 옆에 /compact 경고와 버튼을 띄웁니다.
const COMPACT_AT = 20
// 모델이나 effort를 누르면 여는 선택 창
const PICKER = 'total-stats-picker'
const PICK = 'total-stats-pick'
const MODELS = [
  { alias: 'opus', label: 'Opus' },
  { alias: 'sonnet', label: 'Sonnet' },
  { alias: 'haiku', label: 'Haiku' },
  { alias: 'fable', label: 'Fable' },
]
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const THEME_KEYS = new Set([
  'text', 'inactive', 'subtle', 'suggestion', 'remember', 'success', 'error', 'warning', 'merged', 'claude',
  'permission', 'planMode', 'autoAccept', 'promptBorder', 'bashBorder', 'ide',
])

const snapshot = atom({ plugin: 'total-stats', key: 'snapshot' } as const, null)

const compact = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`

const turnTokens = (u: ModelUsage) =>
  u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens + u.output_tokens

// 83000 → 1m23s, 하루가 넘으면 2d5h
const duration = (ms: number) => {
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m${String(sec % 60).padStart(2, '0')}s`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour}h${String(min % 60).padStart(2, '0')}m`
  return `${Math.floor(hour / 24)}d${hour % 24}h`
}

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
let live: Live = { rateLimits: [], contextParts: [] }
// 설정 파일의 effort가 바뀌었는지 알아보려고 지난번 값을 기억합니다.
let settingsEffort: string | undefined
// fast도 같습니다. /fast 결과가 설정 파일보다 정확할 때가 있어서, 설정이 바뀔 때만 따릅니다.
let settingsFast: boolean | undefined

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
  const nextFast = isFast !== settingsFast ? isFast : live.isFast
  settingsFast = isFast
  // effort는 요청마다 실제 값(turn.step)도 들어오므로, 모델이나 설정이 바뀌었을 때만 덮어씁니다.
  const nextEffort = isModelChanged || isEffortChanged ? effort : live.effort
  if (!isModelChanged && nextEffort === live.effort && nextFast === live.isFast) return
  live.model = model
  live.effort = nextEffort
  live.isFast = nextFast
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
  settingsFast ??= isFast
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

// /context처럼 컨텍스트를 항목별로 나눕니다. summary는 API를 부르지 않고 로컬에서 어림합니다.
async function measureContext($: EngineInterface) {
  try {
    const { context } = await $.session.usage({ breakdown: 'summary' })
    const b = context.breakdown
    if (!b) return
    live.contextMax = b.rawMaxTokens
    live.contextParts = b.categories
      .filter(c => c.kind === 'used' && c.tokens > 0)
      .sort((x, y) => y.tokens - x.tokens)
      .map(c => ({ name: c.name, tokens: c.tokens, color: c.color }))
    await publish($)
  } catch {
    // 나눠 보지 못해도 줄은 그대로 그립니다.
  }
}

// 지금 값을 밴드가 읽는 상태에 씁니다. 쓰면 밴드가 다시 그려집니다.
async function publish($: EngineInterface) {
  const tokens = await load($)
  const used = live.context?.percent
  const fiveHour = live.rateLimits.find(r => r.kind === 'five_hour')
  const sevenDay = live.rateLimits.find(r => r.kind === 'seven_day')
  const next: Snapshot = {
    model: live.model,
    effort: live.effort,
    isFast: live.isFast === true,
    fastBlocked: live.fastBlocked,
    contextLeft: used === undefined ? undefined : Math.max(0, 100 - used),
    contextParts: live.contextParts,
    contextMax: live.contextMax,
    fiveHourUsed: fiveHour?.percentUsed,
    fiveHourResetsAt: fiveHour?.resetsAt,
    sevenDayUsed: sevenDay?.percentUsed,
    sevenDayResetsAt: sevenDay?.resetsAt,
    last: tokens.last,
    total: tokens.total,
    usd: tokens.usd,
    lastMs: tokens.lastMs,
    turns: tokens.turns ?? 0,
    skills: tokens.skills ?? 0,
  }
  await update($, snapshot, () => next)
}

// /model, /effort를 직접 입력한 것처럼 실행하고, 결과를 바로 줄에 반영합니다.
async function choose($: EngineInterface, command: 'model' | 'effort', args: string) {
  const ran = await $.command.run({ command, args })
  await refresh($)
  const text = ran?.text?.trim()
  if (text) await $.ui.toast(text.length > 80 ? `${text.slice(0, 79)}…` : text)
}

// fast는 크레딧(추가 사용량)을 쓰므로 못 쓰는 환경이 있습니다. 미리 알 방법이 없어서
// /fast를 실행해 보고, 켜려 했는데 그대로 꺼져 있으면 못 쓰는 환경으로 기억합니다.
async function toggleFast($: EngineInterface) {
  const want = live.isFast !== true
  const ran = await $.command.run({ command: 'fast' })
  const text = ran?.text?.trim()
  await afterFast($, want, text)
  if (text) await $.ui.toast(text.length > 80 ? `${text.slice(0, 79)}…` : text)
}

// /fast를 버튼으로 눌렀든 직접 입력했든, 결과 문구("Fast mode ON/OFF")와 설정으로 켜졌는지 봅니다.
async function afterFast($: EngineInterface, want: boolean, text?: string) {
  const { isFast: inSettings } = await readSettings($, live.model ?? await $.session.model())
  const isFast = /\bON\b/.test(text ?? '') ? true : /\bOFF\b/.test(text ?? '') ? false : inSettings
  live.isFast = isFast
  if (want && !isFast) {
    // "Fast mode OFF"처럼 이유가 없는 문구면 짐작되는 이유를 대신 적습니다.
    const isBare = !text || /^fast mode (on|off)\.?$/i.test(text)
    live.fastBlocked = isBare ? '켜지지 않았어요: 크레딧(추가 사용량)이 없거나 이 요금제에서 못 써요' : text
  } else if (isFast) {
    live.fastBlocked = undefined
  }
  await publish($)
}

// ctx·남은 용량을 누르면 /context·/usage를 직접 친 것처럼 실행합니다. 결과는 대화창에 나옵니다.
async function runCommand($: EngineInterface, command: 'context' | 'usage' | 'compact') {
  try {
    await $.command.run({ command })
  } catch (error) {
    await $.ui.toast(`/${command}를 실행하지 못했어요: ${error instanceof Error ? error.message : String(error)}`)
  }
}

type Elements = ReturnType<EngineInterface['ui']['resolve']>

// 모델 줄과 effort 줄. 입력창 위 메뉴와 선택 창이 같이 씁니다.
// 입력창 위에서는 숫자 키를 달지 않습니다: 빈 입력창에서 숫자를 치면 그 버튼이 눌리기 때문입니다.
function choiceRows($: EngineInterface, { Box, Text, Button }: Elements, s: Snapshot | null, where: 'band' | 'pane') {
  const family = s?.model ? modelName(s.model).split(' ')[0].toLowerCase() : undefined
  const inPane = where === 'pane'
  return [
    <Box key={`${where}-models`} flexDirection="row" gap={1}>
      <Text dimColor>모델  </Text>
      {MODELS.map((m, i) => (
        <Button
          key={`${where}-model-${m.alias}`} hotkey={inPane ? String(i + 1) : undefined}
          variant={m.alias === family ? 'primary' : undefined}
          autoFocus={(inPane && m.alias === family) || undefined}
          onPress={() => choose($, 'model', m.alias)}
        >
          {m.label}
        </Button>
      ))}
      <Button key={`${where}-model-more`} dimColor onPress={() => $.command.run({ command: 'model' })}>더 보기</Button>
    </Box>,
    <Box key={`${where}-efforts`} flexDirection="row" gap={1}>
      <Text dimColor>effort</Text>
      {EFFORTS.map((level, i) => (
        <Button
          key={`${where}-effort-${level}`} hotkey={inPane ? String(i + 5) : undefined}
          variant={level === s?.effort ? 'primary' : undefined}
          onPress={() => choose($, 'effort', level)}
        >
          {level}
        </Button>
      ))}
    </Box>,
    <Box key={`${where}-fast`} flexDirection="row" gap={1}>
      <Text dimColor>fast  </Text>
      <Button
        key={`${where}-fast-toggle`} hotkey={inPane ? '0' : undefined}
        variant={s?.isFast ? 'primary' : undefined}
        onPress={() => toggleFast($)}
      >
        {s?.isFast ? '켜짐 → 끄기' : '꺼짐 → 켜기'}
      </Button>
      {s?.fastBlocked
        ? <Text color="error" wrap="truncate-end">{s.fastBlocked}</Text>
        : <Text dimColor>크레딧(추가 사용량)을 씁니다</Text>}
    </Box>,
  ]
}

async function save($: EngineInterface, change: (t: Tokens) => void) {
  const tokens = await load($)
  change(tokens)
  await $.store.set(PREFIX + tokens.id, tokens)
}

export const register: Register = on => {
  loading = undefined
  live = { rateLimits: [], contextParts: [] }
  settingsEffort = undefined
  settingsFast = undefined

  on('session.start', async ($, e, next) => {
    const ran = await next(e)
    await publish($)
    await measureContext($)
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
    }
    // 턴 수와 걸린 시간은 메인 대화만 세고, 컨텍스트 내역도 이때 새로 나눕니다.
    if (e.agentId === undefined) {
      await save($, t => {
        t.turns = (t.turns ?? 0) + 1
        t.lastMs = e.durationMs
      })
      await publish($)
      await measureContext($)
    } else if (usage) {
      await publish($)
    }
    return ran
  })

  // 직접 입력한 /fast도 결과를 보고, 켜려 했는데 안 켜지면 빨갛게 표시합니다.
  on('command.run', { command: 'fast' }, async ($, e, next) => {
    const want = live.isFast !== true
    const ran = await next(e)
    await afterFast($, want, ran?.text?.trim())
    return ran
  })

  // /이름으로 부르든 Skill 도구로 부르든 스킬이 펼쳐질 때마다 셉니다.
  on('skill.prompt', async ($, e, next) => {
    const ran = await next(e)
    await save($, t => { t.skills = (t.skills ?? 0) + 1 })
    await publish($)
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

    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const openPicker = () => $.ui.open({ id: PICKER, title: '모델 · effort · fast', focus: true, closeOnEscape: true, holdToasts: true, rows: 7 })
    const now = await $.clock.now()
    const until = (iso?: string) => {
      const at = iso === undefined ? NaN : Date.parse(iso)
      return Number.isNaN(at) ? undefined : duration(Math.max(0, at - now))
    }
    const sep = <Text dimColor> · </Text>
    const filled = s.contextLeft === undefined ? 0 : Math.round((s.contextLeft / 100) * GAUGE)

    // 카드는 평소엔 숨어 있다가 마우스를 올리면 줄 바로 위에 펼쳐집니다.
    // 줄 밖으로 띄우면(absolute) 입력창 위 영역 밖이라 잘려서 보이지 않으므로, 영역 안에 펼칩니다.
    const card = (scope: string, width: number | undefined, lines: unknown[]) => (
      <Box
        width={width} alignSelf="flex-start" flexDirection="column" borderStyle="round" borderColor="suggestion" paddingX={1}
        display="none" hover={{ scope, display: 'flex' }}
      >
        {lines}
      </Box>
    )

    const max = s.contextMax ?? 0
    const parts = s.contextParts.slice(0, CARD_PARTS)
    const nameWidth = Math.max(8, ...parts.map(p => p.name.length))
    const ctxCard = parts.length === 0 ? null : card(CTX, nameWidth + 30, [
      <Text key="title" bold>
        컨텍스트 {compact(s.contextParts.reduce((n, p) => n + p.tokens, 0))}{max > 0 ? ` / ${compact(max)}` : ''}
      </Text>,
      ...parts.map(p => {
        const share = max > 0 ? p.tokens / max : 0
        const color = (THEME_KEYS.has(p.color) ? p.color : 'suggestion') as Color
        const bar = Math.min(GAUGE, Math.max(1, Math.round(share * GAUGE)))
        return (
          <Text key={p.name} wrap="truncate-end">
            <Text>{p.name.padEnd(nameWidth)} </Text>
            <Text color={color}>{'█'.repeat(bar)}</Text>
            <Text dimColor>{'░'.repeat(GAUGE - bar)}</Text>
            <Text bold> {compact(p.tokens).padStart(6)}</Text>
            <Text dimColor> {Math.round(share * 100)}%</Text>
          </Text>
        )
      }),
    ])

    const limitLine = (key: string, label: string, used: number, resetsAt?: string) => {
      const left = Math.max(0, 100 - used)
      const wait = until(resetsAt)
      return (
        <Text key={key} wrap="truncate-end">
          <Text dimColor>{label} </Text>
          <Text color={levelColor(left)} bold>{Math.round(left)}% 남음</Text>
          <Text dimColor> ({Math.round(used)}% 사용)</Text>
          {wait ? <Text> · 리셋까지 <Text color="suggestion" bold>{wait}</Text></Text> : null}
        </Text>
      )
    }
    const limitCard = s.fiveHourUsed === undefined ? null : card(LIMIT, 48, [
      limitLine('five', '5시간', s.fiveHourUsed, s.fiveHourResetsAt),
      s.sevenDayUsed === undefined
        ? <Text key="week" dimColor>주간 한도 정보 없음</Text>
        : limitLine('week', '주간 ', s.sevenDayUsed, s.sevenDayResetsAt),
      // 구독 요금제에서는 실제로 내는 돈이 아니라 API 가격으로 셈한 값이라, 줄에서 빼고 여기에만 둡니다.
      ...(s.usd > 0 ? [<Text key="usd" dimColor>이번 세션 API 환산 비용 ${s.usd.toFixed(2)}</Text>] : []),
    ])

    // 마우스를 알아채려면 ctx와 5h가 각자 맨 바깥 Text여야 해서, 줄을 조각 여러 개로 나눕니다.
    // 창이 좁으면 줄을 바꾸지 않고 오른쪽 조각부터 잘립니다.
    return (
      <Box flexDirection="column">
        {ctxCard}
        {limitCard}
        {s.model ? card(PICK, undefined, choiceRows($, elements, s, 'band')) : null}
        <Box key="line" flexDirection="row" height={1} overflow="hidden">
          {/* 모델과 effort에 마우스를 올리면 바로 위에 고를 수 있는 메뉴가 펼쳐지고, 누르면 선택 창이 열립니다. */}
          {s.model ? (
            <Button key="model" plain hover={{ scope: PICK, color: 'claude', bold: true }} onPress={openPicker}>
              {`🧠 ${modelName(s.model)}`}
            </Button>
          ) : null}
          {s.effort ? sep : null}
          {s.effort ? (
            <Button key="effort" plain hover={{ scope: PICK, color: 'suggestion', bold: true }} onPress={openPicker}>
              {s.effort}
            </Button>
          ) : null}
          {sep}
          {/* fast에 마우스를 올려도 같은 메뉴가 펼쳐지고, 거기서 켜고 끌 수 있습니다. 못 쓰는 환경이면 빨간색입니다. */}
          {s.fastBlocked
            ? <Text color="error" bold hover={{ scope: PICK, underline: true }}>⚡fast 불가</Text>
            : s.isFast
              ? <Text color="warning" bold hover={{ scope: PICK, underline: true }}>⚡fast</Text>
              : <Text dimColor hover={{ scope: PICK, underline: true }}>fast off</Text>}
          {s.contextLeft !== undefined ? sep : null}
          {s.contextLeft !== undefined ? (
            // 버튼은 글자색을 못 바꾸므로 이름만 버튼으로 두고, 게이지는 색이 있는 글자로 둡니다.
            <Button key="ctx" plain dimColor hover={{ scope: CTX, underline: true }} onPress={() => runCommand($, 'context')}>
              ctx
            </Button>
          ) : null}
          {s.contextLeft !== undefined ? (
            <Text wrap="truncate-end" hover={{ scope: CTX, underline: true }}>
              <Text> </Text>
              <Text color={levelColor(s.contextLeft)}>{'█'.repeat(filled)}</Text>
              <Text dimColor>{'░'.repeat(GAUGE - filled)}</Text>
              <Text color={levelColor(s.contextLeft)} bold> {s.contextLeft}%</Text>
            </Text>
          ) : null}
          {s.contextLeft !== undefined && s.contextLeft <= COMPACT_AT
            ? <Text color="error" bold> ⚠ 곧 가득 참 </Text>
            : null}
          {s.contextLeft !== undefined && s.contextLeft <= COMPACT_AT ? (
            <Button key="compact" variant="primary" onPress={() => runCommand($, 'compact')}>/compact</Button>
          ) : null}
          {s.fiveHourUsed !== undefined ? sep : null}
          {s.fiveHourUsed !== undefined ? (
            // 쓴 비율 대신 남은 용량으로 보여줍니다.
            <Button key="usage" plain dimColor hover={{ scope: LIMIT, underline: true }} onPress={() => runCommand($, 'usage')}>
              남은
            </Button>
          ) : null}
          {s.fiveHourUsed !== undefined ? (
            <Text wrap="truncate-end" hover={{ scope: LIMIT, underline: true }}>
              <Text dimColor> 5h </Text>
              <Text color={levelColor(100 - s.fiveHourUsed)} bold>{Math.round(100 - s.fiveHourUsed)}%</Text>
              {s.sevenDayUsed !== undefined ? <Text dimColor> 주 </Text> : null}
              {s.sevenDayUsed !== undefined
                ? <Text color={levelColor(100 - s.sevenDayUsed)} bold>{Math.round(100 - s.sevenDayUsed)}%</Text>
                : null}
            </Text>
          ) : null}
          {sep}
          <Text wrap="truncate-end">
            <Text dimColor>직전 </Text>
            <Text bold>{compact(s.last)}</Text>
            {/* ⏱ 같은 이모지는 터미널마다 폭이 달라 눌려 보이므로 괄호로 씁니다. */}
            {s.lastMs !== undefined ? <Text color="suggestion"> ({duration(s.lastMs)})</Text> : null}
            {sep}
            <Text dimColor>세션 </Text>
            <Text bold>{s.turns}턴 </Text>
            <Text bold>{compact(s.total)}</Text>
            {sep}
            <Text dimColor>스킬 </Text>
            <Text bold>{s.skills}</Text>
          </Text>
        </Box>
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PICKER }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text } = elements
    const s = await read($, snapshot)

    return (
      <Box flexDirection="column">
        {choiceRows($, elements, s, 'pane')}
        <Text dimColor>클릭이나 숫자 키(모델 1~4, effort 5~9, fast 0)로 고르고, Esc로 닫습니다. 지금 쓰는 값은 강조색입니다.</Text>
      </Box>
    )
  })
}
