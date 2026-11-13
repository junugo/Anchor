/**
 * 注意力残留清除仪式：工作 → 娱乐/休息/切换状态时触发。
 * 广播 env:switch 到过渡区，并检查 FocusLayer 活跃任务以生成 AI 提醒。
 */
export async function triggerAttentionResidueRitual(): Promise<void> {
  const { broadcast } = await import('../ws/server')
  // Brief env:switch to transition zone — signals context boundary to all clients
  broadcast({ type: 'env:switch', zone: 'transition', screen_color_temp: 4000 })

  // 触发认知闭合提示（三层降级的第一层：用户输入）——跨端联动，任一端响应即全端关闭
  const { openContextSwitchPrompt } = await import('./context-switch')
  openContextSwitchPrompt('上一件事停在哪里？')

  // Check FocusLayer for active issue breakpoint
  const { focusLayerClient } = await import('../focuslayer/client')
  if (focusLayerClient.isEnabled()) {
    const status = await focusLayerClient.queryStatus()
    if (status?.focus_context.active_issue) {
      const { broadcast: bc } = await import('../ws/server')
      bc({
        type: 'notify:ai',
        message: `注意力残留清除：你刚离开「${status.focus_context.active_issue.title}」，3 分钟后可以回来继续。`,
        actions: [{ label: '我记住了', id: 'residue:ack' }],
      })
    }
  }
}
