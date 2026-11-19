/**
 * 测试用 chrome API 最小 mock：storage.local（Map 后端）+ storage.onChanged 监听器。
 * 各测试文件 beforeEach 中调用 installChromeMock() 重置。
 */

type Listener = (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void

export interface ChromeMock {
  storage: {
    local: {
      get: (keys?: string | string[]) => Promise<Record<string, unknown>>
      set: (entries: Record<string, unknown>) => Promise<void>
      remove: (keys: string | string[]) => Promise<void>
      _map: Map<string, unknown>
    }
    onChanged: {
      addListener: (fn: Listener) => void
      removeListener: (fn: Listener) => void
      _listeners: Set<Listener>
      /** 测试辅助：触发变更通知 */
      _emit: (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>) => void
    }
  }
  runtime: {
    getManifest: () => { version: string }
    openOptionsPage: () => void
  }
}

export function installChromeMock(): ChromeMock {
  const map = new Map<string, unknown>()
  const listeners = new Set<Listener>()

  const mock: ChromeMock = {
    storage: {
      local: {
        async get(keys?: string | string[]) {
          if (keys == null) return Object.fromEntries(map)
          const list = Array.isArray(keys) ? keys : [keys]
          const out: Record<string, unknown> = {}
          for (const k of list) {
            if (map.has(k)) out[k] = map.get(k)
          }
          return out
        },
        async set(entries: Record<string, unknown>) {
          for (const [k, v] of Object.entries(entries)) map.set(k, v)
        },
        async remove(keys: string | string[]) {
          for (const k of Array.isArray(keys) ? keys : [keys]) map.delete(k)
        },
        _map: map,
      },
      onChanged: {
        addListener: (fn) => { listeners.add(fn) },
        removeListener: (fn) => { listeners.delete(fn) },
        _listeners: listeners,
        _emit: (changes) => {
          for (const fn of listeners) fn(changes, 'local')
        },
      },
    },
    runtime: {
      getManifest: () => ({ version: '0.0.1-test' }),
      openOptionsPage: () => {},
    },
  }

  ;(globalThis as Record<string, unknown>).chrome = mock
  return mock
}
