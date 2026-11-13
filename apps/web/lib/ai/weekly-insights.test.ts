import assert from 'node:assert/strict'
import test from 'node:test'
import { buildInsightsPrompt } from './weekly-insights'

test('buildInsightsPrompt summarizes weekly metrics', () => {
  const prompt = buildInsightsPrompt({
    avgDeepWorkMin: 180, totalDissociation: 12, peakDistractionHour: 22, dismissRate: 0.4,
  })
  assert.match(prompt, /180/)
  assert.match(prompt, /22/)
})

test('buildInsightsPrompt requests natural-language insight', () => {
  const prompt = buildInsightsPrompt({ avgDeepWorkMin: 0, totalDissociation: 0, peakDistractionHour: null, dismissRate: 0 })
  assert.match(prompt, /洞察|总结|建议/)
})
