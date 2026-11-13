import { describe, expect, it, vi } from 'vitest'
import { createBadgeController, resolveBadge } from './badge'

describe('resolveBadge', () => {
  it('disconnected shows gray exclamation', () => {
    const b = resolveBadge({ connected: false, phase: 'off' })
    expect(b.text).toBe('!')
    expect(b.color).toBe('#9e978e')
    expect(b.title).toContain('未连接')
  })

  it('T0 shows red', () => {
    const b = resolveBadge({ connected: true, phase: 'T0' })
    expect(b.text).toBe('T0')
    expect(b.color).toBe('#cf222e')
  })

  it('T30 shows orange', () => {
    const b = resolveBadge({ connected: true, phase: 'T30' })
    expect(b.text).toBe('T30')
    expect(b.color).toBe('#c0622a')
  })

  it('T15 shows orange', () => {
    const b = resolveBadge({ connected: true, phase: 'T15' })
    expect(b.text).toBe('T15')
    expect(b.color).toBe('#c0622a')
    expect(b.title).toBe('Anchor · 宵禁 T15')
  })

  it('T60 shows yellow', () => {
    const b = resolveBadge({ connected: true, phase: 'T60' })
    expect(b.text).toBe('T60')
    expect(b.color).toBe('#b08800')
  })

  it('off and connected is silent', () => {
    const b = resolveBadge({ connected: true, phase: 'off' })
    expect(b.text).toBe('')
    expect(b.title).toBe('Anchor')
  })
})

describe('createBadgeController', () => {
  function makeAction() {
    return {
      setBadgeText: vi.fn(async () => {}),
      setBadgeBackgroundColor: vi.fn(async () => {}),
      setTitle: vi.fn(async () => {}),
    }
  }

  it('renders badge on update', async () => {
    const action = makeAction()
    const c = createBadgeController(action)
    await c.update({ connected: true, phase: 'T30' })
    expect(action.setBadgeText).toHaveBeenCalledWith({ text: 'T30' })
    expect(action.setBadgeBackgroundColor).toHaveBeenCalledWith({ color: '#c0622a' })
    expect(action.setTitle).toHaveBeenCalledWith({ title: 'Anchor · 宵禁 T30' })
  })

  it('clears badge when phase off', async () => {
    const action = makeAction()
    const c = createBadgeController(action)
    await c.update({ connected: true, phase: 'off' })
    expect(action.setBadgeText).toHaveBeenCalledWith({ text: '' })
  })

  it('merges partial updates', async () => {
    const action = makeAction()
    const c = createBadgeController(action)
    await c.update({ connected: true })
    await c.update({ phase: 'T0' })
    expect(c.getState()).toEqual({ connected: true, phase: 'T0' })
    expect(action.setBadgeText).toHaveBeenLastCalledWith({ text: 'T0' })
  })
})
