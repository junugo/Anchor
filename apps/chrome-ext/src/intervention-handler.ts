import type { InterventionAction, WsClientMessage, WsServerMessage } from '@anchor/types'
import type { WsClient } from './ws-client'

export interface InterventionHandlerDeps {
  broadcastToTabs: (message: Record<string, unknown>) => Promise<void>
  collapseExcessTabs: () => Promise<void>
  wsClient: WsClient
}

type InterventionServerMsg = Extract<WsServerMessage, { type: 'intervention' }>

export function createInterventionHandler(deps: InterventionHandlerDeps) {
  const activeInterventions = new Map<string, { action: InterventionAction; shownAt: number }>()

  async function handleIntervention(msg: InterventionServerMsg) {
    const { intervention_id, action, message } = msg
    if (intervention_id && action) {
      activeInterventions.set(intervention_id, { action, shownAt: Date.now() })
    }
    switch (action) {
      case 'chrome:grayscale':
        await deps.broadcastToTabs({ type: 'sunset:grayscale', intervention_id, action })
        break
      case 'chrome:friction_banner':
        await deps.broadcastToTabs({ type: 'sunset:friction', message, intervention_id, action })
        break
      case 'chrome:tab_collapse':
        await deps.collapseExcessTabs()
        break
      case 'chrome:hard_block':
        await deps.broadcastToTabs({ type: 'hard:block', message: message ?? '宵禁时间，该休息了', intervention_id, action })
        break
    }
  }

  async function sendInterventionResult(
    intervention_id: string,
    action: InterventionAction,
    result: 'executed' | 'dismissed' | 'expired',
    dismissed_by_user: boolean,
    dismissed_after_ms?: number,
  ) {
    activeInterventions.delete(intervention_id)
    const sent = deps.wsClient.send({
      type: 'intervention_result',
      source: 'chrome',
      intervention_id,
      action,
      result,
      dismissed_by_user,
      dismissed_after_ms,
    } satisfies WsClientMessage)
    return sent
  }

  function removeActiveIntervention(id: string) {
    activeInterventions.delete(id)
  }

  return {
    handleIntervention,
    sendInterventionResult,
    removeActiveIntervention,
  }
}
