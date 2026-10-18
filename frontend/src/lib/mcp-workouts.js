// The MCP boundary writes ordinary completed workouts, never a replacement profile.
import ZH_NAMES from '../exercise-names/zh.js'
import { EXIDX, canonicalExId } from './exercises.js'
import { buildCompletedWorkout } from './finish-workout.js'
import { insertChronological } from './backfill.js'
import { rebuildPrHistory } from './workout-date.js'
import { bestWeightForEntry, workoutVolume } from './history.js'
import { convertWeight, convertBodyWeight } from './units.js'
import { dbLoadFor, isBellEx } from './dumbbells.js'
import { hasCompletedWork, isSideSet, syncSideAggregate } from './workout-model.js'

export class TrainingError extends Error {
  constructor(message, code = 'invalid-input', status = 400) { super(message); this.code = code; this.status = status }
}
export const fail = message => { throw new TrainingError(message) }
export function object(value, keys, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Expected an object')
  if (Object.keys(value).some(k => !keys.includes(k))) fail('Unknown input field')
  if (required.some(k => !Object.hasOwn(value, k))) fail('Required input field missing')
  return value
}
export function text(value, max = 120, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) fail('Invalid text field')
  return value.trim()
}
export function number(value, min, max, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) fail('Number is outside the allowed range')
  return value
}
export function calendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('Date must be YYYY-MM-DD')
  const d = new Date(value + 'T12:00:00Z')
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== value) fail('Invalid calendar date')
  return value
}
export function stableJSON(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJSON).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stableJSON(value[k])).join(',') + '}'
  return JSON.stringify(value)
}
export const workoutId = w => String(w.id ?? `${w.d}|${w.start}`)
export const exerciseFor = (state, id) => (state.customEx || []).find(e => e.id === id) || (Object.hasOwn(EXIDX, id) ? EXIDX[id] : undefined)
// Upstream's helpers resolve equipment by id. Give one synchronous calculation the
// owner's index, restoring every descriptor (including any colliding built-in) on exit.
// No await or callback escapes this scope; another request never sees private customs.
function withOwnerExercises(state, calculate) {
  const saved = new Map()
  try {
    for (const ex of state.customEx || []) {
      if (!ex || typeof ex.id !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(ex.id) || ['__proto__', 'constructor', 'prototype'].includes(ex.id)) throw new TrainingError('Invalid custom exercise metadata', 'state-unreadable', 503)
      if (!saved.has(ex.id)) saved.set(ex.id, Object.getOwnPropertyDescriptor(EXIDX, ex.id))
      Object.defineProperty(EXIDX, ex.id, { value: ex, configurable: true, enumerable: true, writable: true })
    }
    return calculate()
  } finally {
    for (const [id, descriptor] of saved) {
      if (descriptor) Object.defineProperty(EXIDX, id, descriptor); else delete EXIDX[id]
    }
  }
}
export function exerciseInfo(state, exercise) {
  const custom = (state.customEx || []).some(e => e.id === exercise.id)
  return { id: exercise.id, name: exercise.n, localized_name: custom ? exercise.n : ZH_NAMES[exercise.id] || exercise.n, source: custom ? 'custom' : 'catalogue', equipment: exercise.eq || null,
    weight_basis: 'app_display', supported_load_bases: LOAD_BASES, db_load: isBellEx(exercise) ? dbLoadFor(state, { id: exercise.id }) : null }
}
// Search is candidate discovery, never an automatic exercise substitution or creation.
const SEARCH_ALIASES = {
  '推胸': 'chest press', '坐姿推胸': 'chest press', '坐姿推胸机': 'chest press',
  '哑铃弯举': 'dumbbell biceps curl', '俯卧哑铃划船': 'dumbbell lying row', 'lat pulldown': 'pulldown',
  '肩推': 'shoulder press', '固定器械肩推': 'lever shoulder press',
  '蝴蝶机夹胸': 'pec deck fly', '高位下拉': 'pulldown', '坐姿划船': 'seated row',
  '坐姿绳索划船': 'cable seated row', '绳索坐姿划船': 'cable seated row',
  '高位绳索下拉': 'cable pulldown', '绳索高位下拉': 'cable pulldown',
  '反向飞鸟': 'reverse fly', '山羊挺身': 'hyperextension', '绳索侧平举': 'cable lateral raise',
  '坐姿夹腿': 'hip adduction', '坐姿张腿': 'hip abduction', '坐姿腿屈伸': 'leg extension'
}
export function searchExercises(state, query, limit = 15, equipment) {
  const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
  const q = normalize(text(query, 100)), terms = (Object.hasOwn(SEARCH_ALIASES, q) ? SEARCH_ALIASES[q] : q).split(/\s+/)
  const customs = new Map((state.customEx || []).map(e => [e.id, e]))
  const all = [...Object.values(EXIDX).filter(e => !customs.has(e.id)), ...customs.values()]
  const exact = canonicalExId(query.trim())
  return all.filter(e => (!equipment || e.eq === equipment) && (e.id === exact || terms.every(term => normalize(`${e.n} ${customs.has(e.id) ? '' : ZH_NAMES[e.id] || ''} ${e.eq || ''}`).includes(term))))
    .sort((a, b) => Number(b.id === exact) - Number(a.id === exact) || Number(customs.has(a.id)) - Number(customs.has(b.id)) || a.n.length - b.n.length || a.id.localeCompare(b.id))
    .slice(0, limit).map(e => exerciseInfo(state, e))
}
export const unitOf = state => {
  if (state.unit != null && !['kg', 'lb'].includes(state.unit)) throw new TrainingError('Unsupported stored weight unit', 'state-unreadable', 503)
  return state.unit || 'kg'
}
export const LOAD_BASES = ['app_display', 'plates_per_side', 'unknown']
const setFields = ['weight', 'reps', 'seconds', 'minutes', 'speed', 'warmup', 'rir', 'rpe', 'done']
function setRow(input, mode, from, to, previous = null) {
  object(input, setFields)
  if (Object.values(input).some(v => v == null)) fail('Set fields cannot be null or undefined')
  const row = previous ? { ...previous } : { done: true }
  if (input.rir != null && input.rpe != null) fail('Use RIR or RPE, not both')
  const allowed = mode === 'reps' ? ['weight', 'reps'] : mode === 'time' ? ['weight', 'seconds'] : ['minutes', 'speed']
  if (['weight', 'reps', 'seconds', 'minutes', 'speed'].some(k => input[k] != null && !allowed.includes(k))) fail('Set fields do not match exercise mode')
  if (!previous) {
    const required = mode === 'reps' ? ['weight', 'reps'] : mode === 'time' ? ['seconds'] : ['minutes']
    if (required.some(k => input[k] == null)) fail('Incomplete completed set')
  }
  if (input.weight != null) row.w = convertWeight(number(input.weight, 0, 2000), from, to)
  if (input.reps != null) row.r = number(input.reps, input.done === false || (input.done == null && row.done === false) ? 0 : 1, 1000, true)
  if (input.done != null) {
    if (typeof input.done !== 'boolean') fail('done must be boolean')
    row.done = input.done
  }
  if (mode === 'reps' && row.done && !(row.r > 0)) fail('Completed sets require positive reps')
  if (input.seconds != null) row.sec = number(input.seconds, 1, 86400)
  if (input.minutes != null) row.min = number(input.minutes, 0.01, 1440)
  if (input.speed != null) row.speed = number(input.speed, 0, 1000) // speed is always km/h, as in the app
  if (input.warmup != null) {
    if (typeof input.warmup !== 'boolean') fail('warmup must be boolean')
    row.phase = input.warmup ? 'warmup' : 'work'
    delete row.warmup
    if (row.type === 'warmup') delete row.type
  }
  if (input.rir != null) { row.rir = number(input.rir, 0, 10); delete row.rpe }
  if (input.rpe != null) { row.rpe = number(input.rpe, 1, 10); delete row.rir }
  return row
}
export function newWorkout(state, input, id, now = Date.now()) {
  return withOwnerExercises(state, () => buildWorkout(state, input, id, now))
}
function buildWorkout(state, input, id, now) {
  object(input, ['name', 'date', 'started_at', 'time_zone', 'duration_minutes', 'unit', 'bodyweight', 'note', 'entries'],
    ['name', 'date', 'started_at', 'time_zone', 'duration_minutes', 'unit', 'entries'])
  const name = text(input.name), date = calendarDate(input.date), zone = text(input.time_zone, 80)
  if (!['kg', 'lb'].includes(input.unit)) fail('unit must be kg or lb')
  if (typeof input.started_at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(input.started_at)) fail('started_at needs an explicit ISO timestamp and UTC offset')
  calendarDate(input.started_at.slice(0, 10))
  const start = Date.parse(input.started_at), end = start + number(input.duration_minutes, 1, 1440) * 60000
  if (!Number.isFinite(start) || end > now) fail('Workout must have finished in the past')
  let parts
  try { parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(start)) }
  catch { fail('Invalid IANA time zone') }
  const get = type => parts.find(p => p.type === type).value
  if (`${get('year')}-${get('month')}-${get('day')}` !== date) fail('date does not match started_at in time_zone')
  const to = unitOf(state), entries = buildEntries(state, input.entries, input.unit, to)
  const active = { id, name, d: date, start, entries, routineIds: [],
    ...(input.note != null ? { note: text(input.note, 2000, true) } : {}),
    ...(input.bodyweight != null ? { bw: convertBodyWeight(number(input.bodyweight, 1, 1000), input.unit, to) } : {}) }
  // Backfilled records, like the UI's imports, do not invent historical PR badges.
  const finished = buildCompletedWorkout(active, { end, prs: [] })
  return { ...finished, vol: workoutVolume(finished), _ts: now, timeZone: zone }
}
export function appendWorkout(state, workout) {
  if ((state.workouts || []).some(w => workoutId(w) === workout.id)) throw new TrainingError('Workout id already exists', 'conflict', 409)
  return { ...state, workouts: insertChronological(state.workouts || [], workout) }
}
export function correctWorkout(state, current, patch, now = Date.now()) {
  return withOwnerExercises(state, () => applyCorrection(state, current, patch, now))
}
// A plate reading and a unilateral set are independent facts. No load is multiplied
// or inferred from the number of limbs. Native target.side describes execution only.
function entryRows(sets, target, from, to) {
  if (!Array.isArray(sets) || !sets.length || sets.length > 50) fail('Need 1–50 sets per exercise')
  return sets.map(input => {
    if (!target.side) return setRow(input, target.mode, from, to)
    if (target.mode !== 'reps') fail('Independent sides currently support reps mode only')
    object(input, ['sides', 'warmup'], ['sides'])
    object(input.sides, ['L', 'R'], ['L', 'R'])
    const sides = {}
    for (const side of ['L', 'R']) {
      object(input.sides[side], ['weight', 'reps', 'done', 'rir', 'rpe'], ['weight', 'reps'])
      sides[side] = setRow(input.sides[side], 'reps', from, to)
    }
    const row = syncSideAggregate({ sides })
    if (input.warmup != null) {
      if (typeof input.warmup !== 'boolean') fail('warmup must be boolean')
      if (input.warmup) row.phase = 'warmup'
    }
    return row
  })
}
function buildEntries(state, inputs, from, to) {
  if (!Array.isArray(inputs) || !inputs.length || inputs.length > 50) fail('Need 1–50 exercises')
  const entries = inputs.map(e => {
    object(e, ['exercise_id', 'mode', 'load_basis', 'execution', 'db_load', 'sets', 'note'], ['exercise_id', 'mode', 'load_basis', 'sets'])
    const exId = canonicalExId(text(e.exercise_id, 120)), ex = exerciseFor(state, exId)
    if (!ex) fail('Unknown exercise id; search_exercises first')
    if (!['reps', 'time', 'cardio'].includes(e.mode) || !LOAD_BASES.includes(e.load_basis)) fail('Specify a supported mode and explicit load basis')
    if (e.execution != null && !['bilateral', 'unilateral'].includes(e.execution)) fail('Invalid execution')
    if (e.mode === 'cardio' && e.load_basis !== 'app_display') fail('Cardio requires app_display load basis; speed is km/h')
    if (e.db_load != null && (!isBellEx(ex) || !['as', 'each', 'total'].includes(e.db_load))) fail('Invalid dumbbell load meaning')
    if (isBellEx(ex) && e.db_load == null) fail('Dumbbell/kettlebell exercises require explicit db_load: as, each or total')
    if (isBellEx(ex) && e.load_basis === 'plates_per_side') fail('Bell weights are not machine/barbell plate readings')
    const target = { mode: e.mode, loadBasis: e.load_basis, ...(e.execution === 'unilateral' ? { side: true } : {}), ...(e.db_load ? { dbLoad: e.db_load } : {}) }
    let note = e.note != null ? text(e.note, 2000, true) : ''
    if (e.load_basis === 'unknown' && !note) fail('Unknown load basis requires a note describing what is unresolved')
    const label = e.load_basis === 'plates_per_side' ? '负重口径：每侧杠片读数（非合计，不自动翻倍）。' : e.load_basis === 'unknown' ? '负重口径待确认：按原读数保存，未换算合计。' : ''
    if (label) note = text(`${label} ${note}`.trim(), 2000)
    const entry = { id: exId, target, sets: entryRows(e.sets, target, from, to), ...(note ? { note } : {}) }
    return entry
  })
  validateEntries(entries)
  return entries
}
function validateEntries(entries) {
  if (!entries.length || entries.length > 50 || entries.reduce((n, e) => n + e.sets.length, 0) > 500) fail('Workout exceeds 50 exercises or 500 set rows')
  for (const e of entries) {
    if (!e.sets.length || e.sets.length > 50) fail('Need 1–50 sets per exercise')
    // buildCompletedWorkout filters empty exercises. Refuse instead of silently losing input.
    if (!e.sets.some(hasCompletedWork)) fail('Every exercise must contain completed work; nothing was saved')
  }
}
function applyCorrection(state, current, patch, now) {
  object(patch, ['name', 'note', 'duration_minutes', 'unit', 'set_changes', 'append_entries', 'append_sets'])
  if (!Object.keys(patch).length) fail('Empty correction')
  const edited = structuredClone(current), affected = new Set()
  if (patch.name != null) edited.name = text(patch.name)
  if (patch.note != null) edited.note = text(patch.note, 2000, true)
  if (patch.duration_minutes != null) {
    if (!Number.isFinite(edited.start)) fail('Legacy session has no start; edit its duration in the app')
    edited.end = edited.start + number(patch.duration_minutes, 1, 1440) * 60000
    if (edited.end > now) fail('Workout must have finished in the past')
  }
  const changesSets = ['set_changes', 'append_sets', 'append_entries'].some(k => patch[k] != null)
  if (changesSets && !['kg', 'lb'].includes(patch.unit)) fail('Set writes require an explicit unit')
  if (!changesSets && patch.unit != null) fail('unit applies only to set writes')
  // Indices always refer to the pre-update workout. Apply corrections, append to old
  // entries, then append new entries. No new index can accidentally target another row.
  const originalEntries = current.entries || [], seen = new Set()
  if (patch.set_changes != null) {
    if (!Array.isArray(patch.set_changes) || !patch.set_changes.length || patch.set_changes.length > 100) fail('Need 1–100 set corrections')
    for (const change of patch.set_changes) {
      object(change, ['entry_index', 'set_index', 'side', ...setFields], ['entry_index', 'set_index'])
      const ei = number(change.entry_index, 0, 499, true), si = number(change.set_index, 0, 499, true)
      const entry = edited.entries?.[ei], row = entry?.sets?.[si]
      if (!row || !originalEntries[ei]?.sets?.[si]) fail('Set index does not exist')
      const { entry_index, set_index, side, ...values } = change
      const key = `${ei}:${si}:${side || 'row'}`
      if (seen.has(key)) fail('Duplicate set correction'); seen.add(key)
      if (!Object.keys(values).length) fail('Empty set correction')
      if (row.drops || row.clusters || (row.type && !['straight', 'warmup'].includes(row.type))) fail('Use the app to edit complex sets')
      const mode = entry.target?.mode || (row.min != null ? 'cardio' : row.sec != null ? 'time' : 'reps')
      if (isSideSet(row)) {
        if (!['L', 'R'].includes(side)) fail('Specify side L or R for a unilateral set correction')
        if (mode !== 'reps' || values.warmup != null || row.sides[side].drops || row.sides[side].clusters || row.sides[side].type) fail('Use the app to edit complex side sets')
        row.sides[side] = setRow(values, 'reps', patch.unit, unitOf(state), row.sides[side])
        entry.sets[si] = syncSideAggregate(row)

      } else {
        if (side != null || row.sides) fail('This row is not a supported unilateral set')
        entry.sets[si] = setRow(values, mode, patch.unit, unitOf(state), row)
      }
      affected.add(entry.id)
    }
  }
  if (patch.append_sets != null) {
    if (!Array.isArray(patch.append_sets) || !patch.append_sets.length || patch.append_sets.length > 50) fail('Need 1–50 append_sets items')
    const indices = new Set()
    for (const item of patch.append_sets) {
      object(item, ['entry_index', 'sets'], ['entry_index', 'sets'])
      const i = number(item.entry_index, 0, 49, true), entry = edited.entries?.[i]
      if (!originalEntries[i] || !entry || indices.has(i)) fail('Missing or duplicate append_sets entry index')
      indices.add(i)
      const mode = entry.target?.mode || (entry.sets[0]?.min != null ? 'cardio' : entry.sets[0]?.sec != null ? 'time' : 'reps')
      const side = entry.target?.side || entry.sets.some(isSideSet)
      entry.sets.push(...entryRows(item.sets, { ...entry.target, mode, side }, patch.unit, unitOf(state)))
      affected.add(entry.id)
    }
  }
  if (patch.append_entries != null) {
    const appended = buildEntries(state, patch.append_entries, patch.unit, unitOf(state))
    edited.entries.push(...appended)
    appended.forEach(e => affected.add(e.id))
  }
  if (changesSets) {
    if (patch.append_entries != null || patch.append_sets != null) validateEntries(edited.entries)
    else if (edited.entries.some(e => affected.has(e.id) && !e.sets.some(hasCompletedWork))) fail('Every edited exercise must contain completed work; nothing was saved')
    for (const entry of edited.entries) if (affected.has(entry.id)) entry.topW = bestWeightForEntry(entry) || null
    edited.vol = workoutVolume(edited)
  }
  edited.id = workoutId(current); edited._ts = now
  const list = state.workouts.map(w => w === current ? edited : w)
  return { ...state, workouts: rebuildPrHistory(list, [...affected]) }
}

// Counts explicitly distinguish rows (rounds) from independent left/right units.
export function workoutStats(workout) {
  const entries = (workout.entries || []).map((e, entry_index) => {
    let units = 0, completed = 0
    for (const row of e.sets || []) {
      const sides = isSideSet(row) ? [row.sides.L, row.sides.R] : [row]
      units += sides.length; completed += sides.filter(s => s.done === true).length
    }
    return { entry_index, exercise_id: e.id, load_basis: e.target?.loadBasis || 'app_display', execution: (e.target?.side || e.sets?.some(isSideSet)) ? 'unilateral' : 'bilateral',
      set_rows: e.sets?.length || 0, set_units: units, completed_set_units: completed }
  })
  const sum = key => entries.reduce((n, e) => n + e[key], 0)
  return { exercise_count: entries.length, set_rows: sum('set_rows'), set_units: sum('set_units'), completed_set_units: sum('completed_set_units'), entries }
}
