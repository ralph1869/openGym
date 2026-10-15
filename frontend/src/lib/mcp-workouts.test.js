import { describe, it, expect } from 'vitest'
import { newWorkout, correctWorkout, appendWorkout, calendarDate } from './mcp-workouts.js'
import { workoutVolume, setsDone } from './history.js'
import { convertWeight, convertBodyWeight } from './units.js'
import { EXIDX } from './exercises.js'
const now = Date.parse('2026-10-15T20:00:00Z')
const input = () => ({ name: 'Synthetic training', date: '2026-10-14', started_at: '2026-10-14T23:30:00-04:00', time_zone: 'America/New_York', duration_minutes: 45, unit: 'kg',
  entries: [{ exercise_id: '0025', mode: 'reps', load_basis: 'app_display', sets: [{ weight: 60, reps: 8 }, { weight: 60, reps: 8, rir: 0 }] }] })
const state = () => ({ unit: 'kg', workouts: [], routines: [], customEx: [] })
describe('MCP writes the app completed-workout model', () => {
  it('keeps the IANA calendar day across UTC midnight and has real sets/volume', () => {
    const w = newWorkout(state(), input(), 'fixture', now)
    expect(w.d).toBe('2026-10-14'); expect(new Date(w.start).toISOString()).toBe('2026-10-15T03:30:00.000Z')
    expect(w.end - w.start).toBe(45 * 60000); expect(setsDone(w)).toBe(2); expect(workoutVolume(w)).toBe(960)
    expect(w.entries[0].topW).toBe(60); expect(w.prs).toEqual([])
  })
  it('distinguishes both DST fallback instants, never guesses a local offset', () => {
    const x = input(); x.date = '2025-11-02'; x.started_at = '2025-11-02T01:30:00-04:00'
    const first = newWorkout(state(), x, 'a', now)
    x.started_at = '2025-11-02T01:30:00-05:00'; const second = newWorkout(state(), x, 'b', now)
    expect(second.start - first.start).toBe(3600000); expect(first.d).toBe(second.d)
  })
  it('rejects invalid calendar dates, nonexistent zones, mismatched dates, offsetless and future timestamps', () => {
    expect(() => calendarDate('2026-02-30')).toThrow()
    for (const patch of [{ date: '2026-10-15' }, { time_zone: 'not/a-zone' }, { started_at: '2026-10-14T23:30:00' }, { date: '2027-10-14', started_at: '2027-10-14T23:30:00-04:00' }]) expect(() => newWorkout(state(), { ...input(), ...patch }, 'fixture', now)).toThrow()
  })
  it('uses the same kg/lb plate rounding and bodyweight conversion as the UI', () => {
    const x = input(); x.unit = 'lb'; x.bodyweight = 180; x.entries[0].sets = [{ weight: 135, reps: 5 }]
    const w = newWorkout(state(), x, 'fixture', now)
    expect(w.entries[0].sets[0].w).toBe(convertWeight(135, 'lb', 'kg')); expect(w.bw).toBe(convertBodyWeight(180, 'lb', 'kg'))
    expect(state().unit).toBe('kg')
  })
  it('requires explicit dumbbell meaning and uses the same volume multiplier', () => {
    const s = state(); s.customEx = [{ id: 'fixture-bells', n: 'Fixture bells', eq: 'dumbbell' }]
    const x = input(); x.entries = [{ exercise_id: 'fixture-bells', mode: 'reps', load_basis: 'app_display', sets: [{ weight: 20, reps: 10 }] }]
    expect(() => newWorkout(s, x, 'fixture', now)).toThrow(/db_load/)
    x.entries[0].db_load = 'each'; const w = newWorkout(s, x, 'fixture', now)
    expect(w.entries[0].target.dbLoad).toBe('each'); expect(workoutVolume(w)).toBe(400)
  })
  it('logs timed/cardio rows in native fields, and rejects mixed modes and guessed IDs', () => {
    const x = input(); x.entries = [{ exercise_id: '0025', mode: 'time', load_basis: 'app_display', sets: [{ seconds: 45, weight: 0 }] }, { exercise_id: '0025', mode: 'cardio', load_basis: 'app_display', sets: [{ minutes: 20, speed: 8 }] }]
    const w = newWorkout(state(), x, 'fixture', now)
    expect(w.entries[0].sets[0].sec).toBe(45); expect(w.entries[1].sets[0].speed).toBe(8)
    x.entries[0].sets[0].reps = 10; expect(() => newWorkout(state(), x, 'fixture', now)).toThrow()
    const wrong = input(); wrong.entries[0].exercise_id = 'invented'; expect(() => newWorkout(state(), wrong, 'fixture', now)).toThrow(/Unknown exercise/)
  })
  it('files backfills chronologically without changing unrelated settings or existing records', () => {
    const s = state(); s.unknown = { keep: 1 }; s.workouts = [{ id: 'future', d: '2026-10-15', start: now - 1000 }]
    const before = structuredClone(s), w = newWorkout(s, input(), 'fixture', now), next = appendWorkout(s, w)
    expect(next.workouts.map(w => w.id)).toEqual(['fixture', 'future']); expect(s).toEqual(before); expect(next.unknown).toEqual(s.unknown)
    expect(() => appendWorkout(next, w)).toThrow(/already exists/)
  })
  it('rejects extra fields, string numbers, excessive sets and simultaneous RIR/RPE', () => {
    for (const patch of [{ unit: 'stone' }, { user_id: 'someone-else' }, { duration_minutes: 999999 }]) expect(() => newWorkout(state(), { ...input(), ...patch }, 'fixture', now)).toThrow()
    for (const set of [{ weight: '60', reps: 8 }, { weight: -1, reps: 8 }, { weight: 60, reps: 8, rir: 2, rpe: 8 }, { weight: 60, reps: 0 }]) {
      const x = input(); x.entries[0].sets = [set]; expect(() => newWorkout(state(), x, 'fixture', now)).toThrow()
    }
  })
  it('corrects one set and preserves photos, session date, other sets and unrelated workouts', () => {
    const s = state(), w = newWorkout(s, input(), 'fixture', now - 1000); w.media = [{ id: 'photo' }]; w.note = 'keep'; s.workouts = [w]
    const next = correctWorkout(s, w, { unit: 'kg', set_changes: [{ entry_index: 0, set_index: 0, weight: 62.5 }] }, now)
    expect(next.workouts[0].entries[0].sets[0].w).toBe(62.5); expect(next.workouts[0].entries[0].sets[1].w).toBe(60)
    expect(next.workouts[0].media).toEqual(w.media); expect(next.workouts[0].d).toBe(w.d); expect(w.entries[0].sets[0].w).toBe(60)
  })
  it('refuses complex set edits and unsupported destructive patches', () => {
    const s = state(), w = newWorkout(s, input(), 'fixture', now); s.workouts = [w]; w.entries[0].sets[0].drops = [{ w: 20, r: 5 }]
    expect(() => correctWorkout(s, w, { unit: 'kg', set_changes: [{ entry_index: 0, set_index: 0, weight: 50 }] }, now)).toThrow(/complex/)
    for (const p of [{ entries: [] }, { delete: true }, { date: '2026-01-01' }]) expect(() => correctWorkout(s, w, p, now)).toThrow()
  })
  it('restores the global catalogue after private custom exercise calculations, even on failure', () => {
    const original = EXIDX['0025'], s = state(); s.customEx = [{ id: '0025', n: 'Private custom name', eq: 'barbell' }]
    newWorkout(s, input(), 'fixture', now)
    expect(EXIDX['0025']).toBe(original)
    const bad = input(); bad.entries[0].sets[0].weight = -1
    expect(() => newWorkout(s, bad, 'fixture', now)).toThrow(); expect(EXIDX['0025']).toBe(original)
    expect(() => newWorkout(state(), { ...input(), entries: [{ ...input().entries[0], exercise_id: '__proto__' }] }, 'fixture', now)).toThrow(/Unknown/)
  })
})
