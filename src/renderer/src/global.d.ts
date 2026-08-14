import type { DshApi } from '../../shared/types'

declare global {
  interface Window {
    dsh: DshApi
  }
}

declare module '*.svg?raw' {
  const content: string
  export default content
}

export {}
