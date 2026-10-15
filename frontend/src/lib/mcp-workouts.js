// The MCP boundary writes ordinary completed workouts, never a replacement profile.
import { EXIDX, canonicalExId } from './exercises.js'
import { buildCompletedWorkout } from './finish-workout.js'
import { insertChronological } from './backfill.js'
import { rebuildPrHistory } from './workout-date.js'
import { bestWeightForEntry, workoutVolume } from './history.js'
import { convertWeight, convertBodyWeight } from './units.js'
import { dbLoadFor, isBellEx } from './dumbbells.js'

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
  return { id: exercise.id, name: exercise.n, equipment: exercise.eq || null,
    weight_basis: 'app_display', db_load: isBellEx(exercise) ? dbLoadFor(state, { id: exercise.id }) : null }
}
export const unitOf = state => {
  if (state.unit != null && !['kg', 'lb'].includes(state.unit)) throw new TrainingError('Unsupported stored weight unit', 'state-unreadable', 503)
  return state.unit || 'kg'
}
const setFields = ['weight', 'reps', 'seconds', 'minutes', 'speed', 'warmup', 'rir', 'rpe']
function setRow(input, mode, from, to, previous = null) {
  object(input, setFields)
  const row = previous ? { ...previous } : { done: true }
  if (input.rir != null && input.rpe != null) fail('Use RIR or RPE, not both')
  const allowed = mode === 'reps' ? ['weight', 'reps'] : mode === 'time' ? ['weight', 'seconds'] : ['minutes', 'speed']
  if (['weight', 'reps', 'seconds', 'minutes', 'speed'].some(k => input[k] != null && !allowed.includes(k))) fail('Set fields do not match exercise mode')
  if (!previous) {
    const required = mode === 'reps' ? ['weight', 'reps'] : mode === 'time' ? ['seconds'] : ['minutes']
    if (required.some(k => input[k] == null)) fail('Incomplete completed set')
  }
  if (input.weight != null) row.w = convertWeight(number(input.weight, 0, 2000), from, to)
  if (input.reps != null) row.r = number(input.reps, 1, 1000, true)
  if (input.seconds != null) row.sec = number(input.seconds, 1, 86400)
  if (input.minutes != null) row.min = number(input.minutes, 0.01, 1440)
  if (input.speed != null) row.speed = number(input.speed, 0, 1000) // speed is always km/h, as in the app
  if (input.warmup != null) {
    if (typeof input.warmup !== 'boolean') fail('warmup must be boolean')
    if (input.warmup) row.type = 'warmup'; else delete row.type
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
  if (!Array.isArray(input.entries) || !input.entries.length || input.entries.length > 50) fail('Need 1–50 exercises')
  let total = 0
  const to = unitOf(state)
  const entries = input.entries.map(e => {
    object(e, ['exercise_id', 'mode', 'load_basis', 'db_load', 'sets', 'note'], ['exercise_id', 'mode', 'load_basis', 'sets'])
    const exId = canonicalExId(text(e.exercise_id, 120)), ex = exerciseFor(state, exId)
    if (!ex) fail('Unknown exercise id; search_exercises first')
    if (!['reps', 'time', 'cardio'].includes(e.mode) || e.load_basis !== 'app_display') fail('Specify mode and app_display load basis')
    if (e.db_load != null && (!isBellEx(ex) || !['as', 'each', 'total'].includes(e.db_load))) fail('Invalid dumbbell load meaning')
    if (isBellEx(ex) && e.db_load == null) fail('Dumbbell/kettlebell exercises require explicit db_load: as, each or total')
    if (!Array.isArray(e.sets) || !e.sets.length || e.sets.length > 50 || (total += e.sets.length) > 500) fail('Too many or missing sets')
    const target = { mode: e.mode, ...(e.db_load ? { dbLoad: e.db_load } : {}) }
    return { id: exId, target, sets: e.sets.map(s => setRow(s, e.mode, input.unit, to)), ...(e.note != null ? { note: text(e.note, 2000, true) } : {}) }
  })
  const active = { id, name, d: date, start, entries, routineIds: [],
    ...(input.note != null ? { note: text(input.note, 2000, true) } : {}),
    ...(input.bodyweight != null ? { bw: convertBodyWeight(number(input.bodyweight, 1, 1000), input.unit, to) } : {}) }
  // Backfilled records, like the UI's imports, do not invent historical PR badges.
  return { ...buildCompletedWorkout(active, { end, prs: [] }), _ts: now, timeZone: zone }
}
export function appendWorkout(state, workout) {
  if ((state.workouts || []).some(w => workoutId(w) === workout.id)) throw new TrainingError('Workout id already exists', 'conflict', 409)
  return { ...state, workouts: insertChronological(state.workouts || [], workout) }
}
export function correctWorkout(state, current, patch, now = Date.now()) {
  return withOwnerExercises(state, () => applyCorrection(state, current, patch, now))
}
function applyCorrection(state, current, patch, now) {
  object(patch, ['name', 'note', 'duration_minutes', 'unit', 'set_changes'])
  if (!Object.keys(patch).length) fail('Empty correction')
  const edited = structuredClone(current), affected = new Set()
  if (patch.name != null) edited.name = text(patch.name)
  if (patch.note != null) edited.note = text(patch.note, 2000, true)
  if (patch.duration_minutes != null) {
    if (!Number.isFinite(edited.start)) fail('Legacy session has no start; edit its duration in the app')
    edited.end = edited.start + number(patch.duration_minutes, 1, 1440) * 60000
    if (edited.end > now) fail('Workout must have finished in the past')
  }
  if (patch.set_changes != null) {
    if (!['kg', 'lb'].includes(patch.unit)) fail('Set corrections require an explicit unit')
    if (!Array.isArray(patch.set_changes) || !patch.set_changes.length || patch.set_changes.length > 100) fail('Need 1–100 set corrections')
    const seen = new Set()
    for (const change of patch.set_changes) {
      object(change, ['entry_index', 'set_index', ...setFields], ['entry_index', 'set_index'])
      const ei = number(change.entry_index, 0, 499, true), si = number(change.set_index, 0, 499, true), key = `${ei}:${si}`
      if (seen.has(key)) fail('Duplicate set correction'); seen.add(key)
      const entry = edited.entries?.[ei], row = entry?.sets?.[si]
      if (!row || row.done !== true || row.sides || row.drops || row.clusters || (row.type && !['straight', 'warmup'].includes(row.type))) fail('Use the app to edit complex or unfinished sets')
      const { entry_index, set_index, ...values } = change
      if (!Object.keys(values).length) fail('Empty set correction')
      const mode = entry.target?.mode || (row.min != null ? 'cardio' : row.sec != null ? 'time' : 'reps')
      entry.sets[si] = setRow(values, mode, patch.unit, unitOf(state), row)
      entry.topW = bestWeightForEntry(entry) || null
      affected.add(entry.id)
    }
  } else if (patch.unit != null) fail('unit applies only to set_changes')
  edited.id = workoutId(current); edited._ts = now
  if (Number.isFinite(edited.vol)) edited.vol = workoutVolume(edited)
  const list = state.workouts.map(w => w === current ? edited : w)
  return { ...state, workouts: rebuildPrHistory(list, [...affected]) }
}
