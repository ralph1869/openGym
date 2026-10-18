import { describe, it, expect } from 'vitest'
import { newWorkout, correctWorkout, appendWorkout, calendarDate, workoutStats, searchExercises } from './mcp-workouts.js'
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

describe('MCP load basis, independent sides and non-destructive appends', () => {
  const sides = () => ({ L: { weight: 15, reps: 10 }, R: { weight: 12.5, reps: 8, done: false } })
  const unilateral = () => ({ exercise_id: '0025', mode: 'reps', load_basis: 'app_display', execution: 'unilateral', sets: [{ sides: sides() }] })
  it('keeps plates-per-side separate from unilateral execution without doubling any reading', () => {
    const x = input(); x.entries[0].load_basis = 'plates_per_side'; x.entries[0].sets = [{ weight: 20, reps: 10 }]
    const w = newWorkout(state(), x, 'fixture', now), e = w.entries[0]
    expect(e.target.loadBasis).toBe('plates_per_side'); expect(e.target.side).toBeUndefined()
    expect(e.sets[0]).toMatchObject({ w: 20, r: 10, done: true }); expect(e.note).toContain('每侧')
    expect(w.vol).toBe(200); expect(workoutStats(w)).toMatchObject({ set_rows: 1, set_units: 1 })
    x.entries[0].load_basis = 'unknown'; expect(() => newWorkout(state(), x, 'x', now)).toThrow(/note/)
    x.entries[0].note = 'Original 20; angle and total/per-side meaning unresolved'
    expect(newWorkout(state(), x, 'x', now).entries[0]).toMatchObject({ target: { loadBasis: 'unknown' }, sets: [{ w: 20 }] })
  })
  it('roundtrips asymmetric sides, completion and aggregate using the native UI model', () => {
    const x = input(); x.entries = [unilateral()]
    const s = state(), w = newWorkout(s, x, 'sides', now); s.workouts = [w]
    expect(w.entries[0].target.side).toBe(true)
    expect(w.entries[0].sets[0]).toMatchObject({ w: 15, r: 18, done: false, sides: { L: { w: 15, r: 10, done: true }, R: { w: 12.5, r: 8, done: false } } })
    expect(w.vol).toBe(150); expect(setsDone(w)).toBe(1)
    const changed = correctWorkout(s, w, { unit: 'kg', set_changes: [{ entry_index: 0, set_index: 0, side: 'R', weight: 17.5, reps: 9, done: true, rir: 2 }] }, now).workouts[0]
    expect(changed.entries[0].sets[0]).toMatchObject({ w: 17.5, r: 19, done: true, sides: { L: { w: 15, r: 10 }, R: { w: 17.5, r: 9, rir: 2 } } })
    expect(changed.vol).toBe(307.5); expect(w.entries[0].sets[0].sides.R.done).toBe(false)
    expect(workoutStats(changed)).toMatchObject({ exercise_count: 1, set_rows: 1, set_units: 2, completed_set_units: 2 })
  })
  it('writes native warm-up phases for ordinary rows and can turn a warm-up into work explicitly', () => {
    const x = input(); x.entries[0].sets = [{ weight: 20, reps: 10, warmup: true }, { weight: 60, reps: 8 }]
    const s = state(), w = newWorkout(s, x, 'fixture', now); s.workouts = [w]
    expect(w.entries[0].sets[0].phase).toBe('warmup'); expect(w.vol).toBe(480)
    const changed = correctWorkout(s, w, { unit: 'kg', set_changes: [{ entry_index: 0, set_index: 0, warmup: false }] }, now).workouts[0]
    expect(changed.entries[0].sets[0].phase).toBe('work'); expect(changed.vol).toBe(680)
  })
  it('preserves unilateral warm-ups when correcting either side and excludes their volume', () => {
    const x = input(); x.entries = [{ ...unilateral(), sets: [{ sides: sides(), warmup: true }, { sides: sides() }] }]
    const s = state(), w = newWorkout(s, x, 'fixture', now); s.workouts = [w]
    const changed = correctWorkout(s, w, { unit: 'kg', set_changes: [{ entry_index: 0, set_index: 0, side: 'R', weight: 20, reps: 10, done: true }] }, now).workouts[0]
    expect(changed.entries[0].sets[0]).toMatchObject({ phase: 'warmup', w: 20, r: 20, done: true })
    expect(changed.vol).toBe(150); expect(workoutVolume(changed)).toBe(150)
  })
  it('appends sets and exercises atomically, preserving original indices, identity, media and unrelated state', () => {
    const s = state(), w = newWorkout(s, input(), 'fixture', now); w.media = [{ id: 'keep' }]; s.workouts = [w]; s.week = { 1: ['keep'] }
    const before = structuredClone(s)
    const next = correctWorkout(s, w, { unit: 'kg', set_changes: [{ entry_index: 0, set_index: 1, weight: 65 }], append_sets: [{ entry_index: 0, sets: [{ weight: 62.5, reps: 8 }] }], append_entries: [unilateral()] }, now)
    const edited = next.workouts[0]
    expect(workoutStats(edited)).toMatchObject({ exercise_count: 2, set_rows: 4, set_units: 5, completed_set_units: 4 })
    expect(edited.entries[0].sets.map(s => s.w)).toEqual([60, 65, 62.5]); expect(edited.media).toEqual(w.media); expect(edited.id).toBe(w.id); expect(next.week).toEqual(s.week); expect(s).toEqual(before)
  })
  it('converts side units once and never applies a second dumbbell pair multiplier', () => {
    const s = state(); s.customEx = [{ id: 'fixture-bell', n: 'Synthetic dumbbell row', eq: 'dumbbell' }]
    const x = input(); x.unit = 'lb'; x.entries = [{ ...unilateral(), exercise_id: 'fixture-bell', db_load: 'each' }]
    const w = newWorkout(s, x, 'fixture', now)
    const left = convertWeight(15, 'lb', 'kg')
    expect(w.entries[0].sets[0].sides.L.w).toBe(left); expect(w.vol).toBe(left * 10)
  })
  it('refuses malformed, mixed, unsupported or entirely unfinished input instead of dropping an entry', () => {
    const badRows = [{ sides: { L: { weight: 15, reps: 10 } } }, { sides: sides(), weight: 30 }, { sides: { L: { weight: 0, reps: 0, done: false }, R: { weight: 0, reps: 0, done: false } } }]
    for (const row of badRows) {
      const x = input(); x.entries.push({ ...unilateral(), sets: [row] }); expect(() => newWorkout(state(), x, 'bad', now)).toThrow()
    }
    const x = input(); x.entries = [{ ...unilateral(), mode: 'time' }]; expect(() => newWorkout(state(), x, 'bad', now)).toThrow(/reps/)
    const s = state(), w = newWorkout(s, { ...input(), entries: [unilateral()] }, 'fixture', now); s.workouts = [w]
    for (const change of [{ weight: 40 }, { side: 'X', weight: 40 }, { side: 'L', warmup: true }]) expect(() => correctWorkout(s, w, { unit: 'kg', set_changes: [{ entry_index: 0, set_index: 0, ...change }] }, now)).toThrow()
    expect(() => correctWorkout(s, w, { unit: 'kg', set_changes: [{ entry_index: 0, set_index: 0, side: 'L', done: false }] }, now)).toThrow(/completed work/)
  })
  it('enforces post-append bounds, duplicate corrections, original indices and explicit units without mutating input', () => {
    const s = state(), w = newWorkout(s, input(), 'fixture', now); s.workouts = [w]; const before = structuredClone(s)
    const change = { entry_index: 0, set_index: 0, weight: 65 }
    for (const patch of [
      { append_entries: [unilateral()] },
      { unit: 'kg', append_sets: [{ entry_index: 1, sets: [{ weight: 1, reps: 1 }] }], append_entries: [unilateral()] },
      { unit: 'kg', set_changes: [change, change] },
      { unit: 'kg', append_sets: [{ entry_index: 0, sets: Array.from({ length: 50 }, () => ({ weight: 1, reps: 1 })) }] },
      { unit: 'kg', append_entries: [{ ...unilateral(), exercise_id: 'missing-id' }] }
    ]) expect(() => correctWorkout(s, w, patch, now)).toThrow()
    expect(s).toEqual(before)
  })
  it('keeps legacy correction indices compatible and enforces total limits only on new appends', () => {
    const s = state(), w = newWorkout(s, input(), 'fixture', now)
    w.entries[0].sets = Array.from({ length: 51 }, () => ({ w: 10, r: 10, done: true })); s.workouts = [w]
    const next = correctWorkout(s, w, { unit: 'kg', set_changes: [{ entry_index: 0, set_index: 50, weight: 12 }] }, now)
    expect(next.workouts[0].entries[0].sets[50].w).toBe(12)
    const x = input(); x.entries = Array.from({ length: 10 }, () => ({ ...input().entries[0], sets: Array.from({ length: 50 }, () => ({ weight: 10, reps: 10 })) }))
    const large = newWorkout(s, x, 'large', now); s.workouts = [large]
    expect(() => correctWorkout(s, large, { unit: 'kg', append_entries: [unilateral()] }, now)).toThrow(/500/)
    x.entries = Array.from({ length: 50 }, () => input().entries[0]); const many = newWorkout(s, x, 'many', now); s.workouts = [many]
    expect(() => correctWorkout(s, many, { unit: 'kg', append_entries: [unilateral()] }, now)).toThrow(/50 exercises/)
  })
  it('matches common full Chinese cable names in either word order with the plugin limit of three', () => {
    const s = state(), before = structuredClone(s)
    for (const [query, id] of [['坐姿绳索划船', '0861'], ['绳索坐姿划船', '0861'], ['高位绳索下拉', '0198'], ['绳索高位下拉', '0198']]) {
      const found = searchExercises(s, query, 3)
      expect(found.length).toBeLessThanOrEqual(3)
      expect(found[0]).toMatchObject({ id, source: 'catalogue', equipment: 'cable' })
    }
    expect(s).toEqual(before)
  })
  it('finds existing English/Chinese catalogue candidates and distinguishes equipment without creating anything', () => {
    const s = state(), before = structuredClone(s)
    for (const query of ['坐姿划船', 'seated row', '高位下拉', '山羊挺身', '蝴蝶机夹胸', '哑铃弯举']) expect(searchExercises(s, query, 30).some(e => e.source === 'catalogue')).toBe(true)
    const cable = searchExercises(s, '坐姿划船', 30, 'cable')
    expect(cable.length).toBeGreaterThan(0); expect(cable.every(e => e.equipment === 'cable')).toBe(true)
    expect(searchExercises(s, 'constructor')).toEqual([]); expect(searchExercises(s, '__proto__')).toEqual([])
    expect(searchExercises(s, 'nonexistent original machine')).toEqual([]); expect(s).toEqual(before)
  })
})
