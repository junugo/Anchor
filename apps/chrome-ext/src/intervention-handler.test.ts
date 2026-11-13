import { describe, expect, it, vi } from 'vitest'
import { createInterventionHandler } from './intervention-handler'

describe('createInterventionHandler', () => {
  function createDeps() {
    return {
      broadcastToTabs: vi.fn(async () => {}),
      collapseExcessTabs: vi.fn(async () => {}),
      wsClient: { ready: true, connect: vi.fn(), send: vi.fn(() => true) },
    }
  }

  it('broadcasts grayscale action', async () => {
    const deps = createDeps()
    const handler = createInterventionHandler(deps)
    await handler.handleIntervention({
      type: 'intervention',
      level: 'soft',
      message: '',
      action: 'chrome:grayscale',
      intervention_id: 'i1',
    })
    expect(deps.broadcastToTabs).toHaveBeenCalledWith(expect.objectContaining({
      type: 'sunset:grayscale',
      intervention_id: 'i1',
      action: 'chrome:grayscale',
    }))
  })

  it('broadcasts friction banner action', async () => {
    const deps = createDeps()
    const handler = createInterventionHandler(deps)
    await handler.handleIntervention({
      type: 'intervention',
      level: 'soft',
      message: '休息一下',
      action: 'chrome:friction_banner',
      intervention_id: 'i2',
    })
    expect(deps.broadcastToTabs).toHaveBeenCalledWith(expect.objectContaining({
      type: 'sunset:friction',
      message: '休息一下',
      intervention_id: 'i2',
      action: 'chrome:friction_banner',
    }))
  })

  it('collapses tabs for tab_collapse action', async () => {
    const deps = createDeps()
    const handler = createInterventionHandler(deps)
    await handler.handleIntervention({
      type: 'intervention',
      level: 'hard',
      message: '',
      action: 'chrome:tab_collapse',
      intervention_id: 'i3',
    })
    expect(deps.collapseExcessTabs).toHaveBeenCalled()
  })

  it('sends intervention_result via ws client', async () => {
    const deps = createDeps()
    const handler = createInterventionHandler(deps)
    await handler.sendInterventionResult('i1', 'chrome:hard_block', 'dismissed', true, 1234)
    expect(deps.wsClient.send).toHaveBeenCalledWith({
      type: 'intervention_result',
      source: 'chrome',
      intervention_id: 'i1',
      action: 'chrome:hard_block',
      result: 'dismissed',
      dismissed_by_user: true,
      dismissed_after_ms: 1234,
    })
  })
})
