import { describe, it, expect } from 'vitest'
import { inferTerminalCategory } from '../terminal'

describe('inferTerminalCategory', () => {
  it('classifies git terminals', () => {
    expect(inferTerminalCategory('Git Bash')).toBe('git')
    expect(inferTerminalCategory('git')).toBe('git')
  })

  it('classifies node/npm/pnpm terminals', () => {
    expect(inferTerminalCategory('Node')).toBe('node')
    expect(inferTerminalCategory('npm run dev')).toBe('node')
    expect(inferTerminalCategory('pnpm')).toBe('node')
  })

  it('classifies python terminals', () => {
    expect(inferTerminalCategory('Python')).toBe('python')
    expect(inferTerminalCategory('py script.py')).toBe('python')
  })

  it('falls back to other', () => {
    expect(inferTerminalCategory('bash')).toBe('other')
    expect(inferTerminalCategory('zsh')).toBe('other')
    expect(inferTerminalCategory('')).toBe('other')
  })
})
