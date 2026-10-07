export type Snapshot = {
  model?: string
  effort?: string
  isFast: boolean
  contextLeft?: number
  fiveHourUsed?: number
  last: number
  total: number
  usd: number
}

declare module 'claude-code' {
  interface PluginState {
    'total-stats': { snapshot: Snapshot | null }
  }
}
