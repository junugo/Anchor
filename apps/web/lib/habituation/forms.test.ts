import assert from 'node:assert/strict'
import test from 'node:test'
import { selectFrictionForm } from './forms'

test('selects first form when none habituated', () => {
  const form = selectFrictionForm('entertainment_app_launch', () => false)
  assert.ok(form)
  assert.equal(form.category, 'entertainment_app_launch')
})
