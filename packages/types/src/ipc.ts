export interface IpcChannels {
  'fs:read':     { req: { path: string }; res: string }
  'fs:write':    { req: { path: string; content: string }; res: void }
  'tray:notify': { req: { title: string; body: string }; res: void }

  // Offline sync queue — renderer enqueues failed mutations; main drains on reconnect
  'cache:enqueue': {
    req: { endpoint: string; method: string; body: unknown }
    res: void
  }
  'cache:status': {
    req: Record<string, never>
    res: { queueLength: number }
  }
}