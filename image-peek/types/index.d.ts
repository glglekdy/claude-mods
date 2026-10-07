export type Peek = {
  label: string
  path: string
}

declare module 'claude-code' {
  interface PluginState {
    'image-peek': { images: Peek[] }
  }
}
