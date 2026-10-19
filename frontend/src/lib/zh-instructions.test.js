import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import zh from '../instr/zh.js'
import names from '../exercise-names/zh.js'
import descriptions from '../exercise-desc/zh.js'
import EN from '../instr/en.js'
import enDescriptions from '../exercise-desc/en.js'
import source from '../../../catalogue/i18n/zh.json' with { type: 'json' }
import provenance from '../../../catalogue/sources/exercises-dataset-zh-cn/source.json' with { type: 'json' }
import V13_IDS from './catalogue-v13-ids.json' with { type: 'json' }
import { EXDB } from './exercises-data.js'
import { _setDetails, _setLangState, descFor, exerciseNameFor, instrFor, instrTranslated } from './i18n-core.js'

const planIds = ['0178', '0198', '0294', '0489', '0585', '0597', '0598', '0602', '0861', '1030', '3593']
const exercises = new Map(EXDB.map(ex => [ex.id, ex]))
const reset = () => {
  _setLangState('en', {}, null, null)
  _setDetails(EN, enDescriptions, null, 'en')
}
const chinese = () => {
  _setLangState('zh', {}, zh, names)
  _setDetails(EN, enDescriptions, descriptions, 'zh')
}
beforeEach(reset)
afterEach(reset)

describe('Simplified Chinese catalogue text', () => {
  it('retains the pinned community instructions by exact v1.3 ID with explicit reviewed overrides', () => {
    const originals = Object.fromEntries(V13_IDS.map(id => [id, [...zh[id]]]))
    for (const { id, step, source, translation } of provenance.reviewedInstructionOverrides) {
      expect(originals[id][step - 1], `${id} step ${step}`).toBe(translation)
      expect(translation).not.toBe(source)
      originals[id][step - 1] = source
    }
    const pairs = [...V13_IDS].sort().map(id => [id, originals[id]])
    expect(pairs).toHaveLength(provenance.importedExercises)
    expect(pairs.reduce((n, [, steps]) => n + steps.length, 0)).toBe(provenance.importedSteps)
    expect(createHash('sha256').update(JSON.stringify(pairs)).digest('hex')).toBe(provenance.instructionsSha256)
  })

  it('generates every translated source step and name without adding unknown IDs', () => {
    expect(names).toEqual(Object.fromEntries(Object.entries(source).map(([id, row]) => [id, row.name])))
    expect(zh).toEqual(Object.fromEntries(Object.entries(source).filter(([, row]) => row.instructions).map(([id, row]) => [id, row.instructions])))
    expect(Object.keys(zh).sort()).toEqual([...V13_IDS, ...provenance.localInstructionIds].sort())
    for (const [id, steps] of Object.entries(zh)) {
      expect(exercises.has(id), id).toBe(true)
      expect(steps.length, id).toBeGreaterThan(0)
      for (const step of steps) expect(step, id).toMatch(/[\u4e00-\u9fff]/)
    }
  })

  it('covers each confirmed plan exercise with Chinese steps and a paired description', () => {
    chinese()
    expect(Object.keys(descriptions).sort()).toEqual(planIds)
    expect(provenance.bilingualDescriptionIds).toEqual(planIds)
    for (const id of planIds) {
      const ex = exercises.get(id)
      expect(instrTranslated(ex), id).toBe(true)
      expect(instrFor(ex), id).toEqual(zh[id])
      const [cn, en] = descFor(ex).split('\n\n')
      expect(cn, id).toMatch(/^中文：.*[\u4e00-\u9fff]/)
      expect(en, id).toBe(`English: ${enDescriptions[id]}`)
      expect(descriptions[id], id).toBe(source[id].description)
    }
  })

  it('returns unchanged English details when switching from Chinese to English', () => {
    chinese()
    _setLangState('en', {}, null, null)
    for (const id of planIds) {
      const ex = exercises.get(id)
      expect(instrFor(ex), id).toEqual(EN[id])
      expect(descFor(ex), id).toBe(enDescriptions[id])
      expect(instrTranslated(ex), id).toBe(false)
    }
  })

  it('keeps per-exercise English fallback for uncovered catalogue text', () => {
    chinese()
    const ex = EXDB.find(ex => !zh[ex.id] && !descriptions[ex.id] && EN[ex.id] && enDescriptions[ex.id])
    expect(ex).toBeDefined()
    expect(instrFor(ex)).toEqual(EN[ex.id])
    expect(instrTranslated(ex)).toBe(false)
    expect(descFor(ex)).toBe(enDescriptions[ex.id])
  })

  it('preserves a custom exercise name and its own text without guessing a catalogue match', () => {
    chinese()
    const custom = { id: 'custom-unconfirmed-press', n: '低角度卧推类器械', st: ['待确认具体角度。'], desc: '保留用户原记录。' }
    expect(exerciseNameFor(custom)).toBe(custom.n)
    expect(instrFor(custom)).toEqual(custom.st)
    expect(descFor(custom)).toBe(custom.desc)
    expect(instrTranslated(custom)).toBe(false)
    expect(instrFor({ id: 'custom-unconfirmed-row', n: '俯卧哑铃划船' })).toEqual([])
    expect(descFor({ id: 'custom-unconfirmed-row', n: '俯卧哑铃划船' })).toBe('')
  })
})
