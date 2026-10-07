// /context의 항목 한 줄: 무엇이 컨텍스트를 얼마나 차지하는지
export type ContextPart = {
  name: string
  tokens: number
  color: string
}

export type Snapshot = {
  model?: string
  effort?: string
  isFast: boolean
  fastBlocked?: string
  contextLeft?: number
  contextParts: ContextPart[]
  contextMax?: number
  fiveHourUsed?: number
  fiveHourResetsAt?: string
  sevenDayUsed?: number
  sevenDayResetsAt?: string
  last: number
  total: number
  usd: number
  lastMs?: number
  turns: number
  skills: number
}

declare module 'claude-code' {
  interface PluginState {
    'total-stats': { snapshot: Snapshot | null }
  }
}
