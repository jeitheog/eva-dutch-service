/**
 * Motor SRS de Lingua — SM-2 con grades 0-5.
 *
 *  - grade < 3 → lapse: la tarjeta se re-aprende (repetitions=0, lapses+1,
 *    ease baja, due en ~10 min).
 *  - grade >= 3 → éxito: ease se ajusta con la fórmula SM-2 y el intervalo
 *    crece por la secuencia 1d → 3d → 7d → 14d → 30d → intervalo×ease.
 *
 * Sin dependencias de red: todo es puro + SQLite inyectado (testeable).
 */

import type { DatabaseSync } from 'node:sqlite'
import {
  audit,
  bumpDailyStats,
  endOfDay,
  ensureStudentRow,
  getDailyStats,
  toDay,
  type Card,
  type DailyStats,
} from '../db'

export type { Card, DailyStats } from '../db'

export const MIN_EASE = 1.3
/** Secuencia de intervalos (días) tras éxitos consecutivos. */
export const INTERVAL_SEQUENCE = [1, 3, 7, 14, 30]
export const LAPSE_REDUE_MS = 10 * 60 * 1000

export interface SrsState {
  ease: number
  repetitions: number
  lapses: number
  interval_days: number
  status: Card['status']
}

export interface SrsUpdate extends SrsState {
  intervalDays: number
  dueAt: number
}

/** Núcleo SM-2: dado el grade y el estado actual, devuelve el nuevo estado. */
export function sm2(grade: number, card: SrsState, now = Date.now()): SrsUpdate {
  const clamped = Math.max(0, Math.min(5, Math.round(grade)))
  let ease = card.ease
  let repetitions = card.repetitions
  let lapses = card.lapses
  let intervalDays = card.interval_days

  if (clamped < 3) {
    // Falla: lapse, vuelve a aprender.
    repetitions = 0
    lapses += 1
    ease = Math.max(MIN_EASE, ease - 0.2)
    intervalDays = 0
    return { ease, intervalDays, interval_days: 0, repetitions, lapses, status: 'learning', dueAt: now + LAPSE_REDUE_MS }
  }

  // Éxito: fórmula SM-2 del ease (min 1.3).
  ease = Math.max(MIN_EASE, ease + (0.1 - (5 - clamped) * (0.08 + (5 - clamped) * 0.02)))
  repetitions += 1
  if (repetitions <= INTERVAL_SEQUENCE.length) {
    intervalDays = INTERVAL_SEQUENCE[repetitions - 1]
  } else {
    intervalDays = Math.round(intervalDays * ease * 10) / 10
    if (clamped >= 5) intervalDays = Math.round(intervalDays * 1.2 * 10) / 10
  }
  // Techo de 1 año: evita desbordar enteros de SQLite con repasos extremos.
  intervalDays = Math.min(365, intervalDays)
  const status: Card['status'] =
    intervalDays >= 30 ? 'mastered' : intervalDays >= 1 ? 'review' : 'learning'
  return { ease, intervalDays, interval_days: intervalDays, repetitions, lapses, status, dueAt: now + intervalDays * 86_400_000 }
}

// ── Operaciones con DB ─────────────────────────────────────────────────────

export function getCard(db: DatabaseSync, cardId: number): Card | undefined {
  return db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId) as Card | undefined
}

export interface CreateCardInput {
  type?: 'phrase' | 'word'
  front: string
  back: string
  nl?: string
  es?: string
  pronunciation?: string
  explanation?: string
  grammar?: string
  examples?: string[] | string
  context?: string
  category?: string
  source?: 'manual' | 'photo' | 'book' | 'conversation' | 'curriculum' | 'error'
}

/**
 * Crea una tarjeta SIN duplicados: si el front o el nl ya existen
 * (comparación sin mayúsculas ni espacios sobrantes) devuelve
 * { duplicate: true, existing_id }.
 */
export function createCard(
  db: DatabaseSync,
  input: CreateCardInput,
  now = Date.now()
): { duplicate: false; card: Card } | { duplicate: true; existing_id: number } {
  const front = input.front.trim()
  const nl = (input.nl ?? '').trim()
  if (!front) throw new Error('front es obligatorio')

  const existing = db
    .prepare(
      `SELECT id FROM cards
       WHERE lower(trim(front)) = lower(trim(?))
          OR (nl <> '' AND lower(trim(nl)) = lower(trim(?)))`
    )
    .get(front, nl) as { id: number } | undefined
  if (existing) return { duplicate: true, existing_id: existing.id }

  const examples = Array.isArray(input.examples)
    ? JSON.stringify(input.examples)
    : input.examples && input.examples.trim() ? input.examples : '[]'
  const type = input.type === 'word' ? 'word' : 'phrase'

  const result = db
    .prepare(
      `INSERT INTO cards
         (type, front, back, nl, es, pronunciation, explanation, grammar,
          examples, context, category, source, created_at, due_at,
          interval_days, ease, repetitions, lapses, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 2.5, 0, 0, 'new')`
    )
    .run(
      type,
      front,
      input.back.trim(),
      nl || front,
      (input.es ?? '').trim(),
      (input.pronunciation ?? '').trim(),
      (input.explanation ?? '').trim(),
      (input.grammar ?? '').trim(),
      examples,
      (input.context ?? '').trim(),
      (input.category ?? 'general').trim(),
      input.source ?? 'manual',
      now,
      now // las tarjetas nuevas vencen ya (entran en la primera sesión)
    )
  const id = Number(result.lastInsertRowid)
  audit(db, 'card.create', `front=${front}`, 'card', id)
  return { duplicate: false, card: getCard(db, id)! }
}

export function listCards(
  db: DatabaseSync,
  opts: { status?: string; category?: string; limit?: number } = {}
): Card[] {
  const where: string[] = []
  const params: Array<string | number> = []
  if (opts.status) {
    where.push('status = ?')
    params.push(opts.status)
  }
  if (opts.category) {
    where.push('category = ?')
    params.push(opts.category)
  }
  const limit = Math.min(500, Math.max(1, opts.limit ?? 100))
  const sql = `SELECT * FROM cards${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`
  return db.prepare(sql).all(...params, limit) as unknown as Card[]
}

/** Aplica un update SM-2 y registra el review. */
export function reviewCard(
  db: DatabaseSync,
  cardId: number,
  grade: number,
  latencyMs = 0,
  now = Date.now()
): Card {
  const card = getCard(db, cardId)
  if (!card) throw new Error(`Tarjeta ${cardId} no existe`)
  const upd = sm2(grade, card, now)
  db.prepare(
    `UPDATE cards SET due_at = ?, interval_days = ?, ease = ?, repetitions = ?, lapses = ?, status = ? WHERE id = ?`
  ).run(upd.dueAt, upd.intervalDays, upd.ease, upd.repetitions, upd.lapses, upd.status, cardId)
  db.prepare('INSERT INTO reviews_log (card_id, ts, grade, latency_ms) VALUES (?, ?, ?, ?)').run(
    cardId, now, grade, Math.max(0, Math.round(latencyMs))
  )
  // stats_daily
  const day = toDay(now)
  bumpDailyStats(db, day, {
    new_cards: card.status === 'new' ? 1 : 0,
    reviews: 1,
    correct: grade >= 3 ? 1 : 0,
    wrong: grade < 3 ? 1 : 0,
  })
  // errors_log si falla (grade < 3) — tipo olvidada por defecto.
  if (grade < 3) {
    db.prepare(
      'INSERT INTO errors_log (ts, card_id, tipo, detail, pattern) VALUES (?, ?, ?, ?, ?)'
    ).run(now, cardId, 'olvidada', `Grade ${grade} en review de "${card.front}"`, `lapse:${card.front}`)
  }
  audit(db, 'card.review', `grade=${grade}`, 'card', cardId)
  return getCard(db, cardId)!
}

/**
 * Tarjetas vencidas para una sesión, ordenadas por due_at ASC.
 * Respeta el límite diario de tarjetas nuevas (~20/día): una vez agotado,
 * las tarjetas 'new' quedan fuera de la cola hasta mañana.
 */
export function dueCards(
  db: DatabaseSync,
  now: number,
  limit = 10,
  dailyNewLimit = 20
): Card[] {
  const today = toDay(now)
  const stats = getDailyStats(db, today)
  const newUsed = stats?.new_cards ?? 0
  const newRemaining = Math.max(0, dailyNewLimit - newUsed)
  const due = db
    .prepare(
      `SELECT * FROM cards
       WHERE due_at <= ? AND status IN ('new','learning','review')
       ORDER BY due_at ASC, id ASC`
    )
    .all(now) as unknown as Card[]
  const out: Card[] = []
  let newTaken = 0
  for (const c of due) {
    if (out.length >= limit) break
    if (c.status === 'new') {
      if (newTaken >= newRemaining) continue
      newTaken += 1
    }
    out.push(c)
  }
  return out
}

export interface DueStatus {
  pendientes_hoy: number
  nuevas_disponibles: number
  dificiles: number
}

export function dueStatus(db: DatabaseSync, now = Date.now(), dailyNewLimit = 20): DueStatus {
  const today = toDay(now)
  const stats = getDailyStats(db, today)
  const newUsed = stats?.new_cards ?? 0
  const pendientes = db
    .prepare(
      `SELECT COUNT(*) AS n FROM cards
       WHERE due_at <= ? AND status IN ('new','learning','review')`
    )
    .get(endOfDay(now)) as { n: number }
  const dificiles = db
    .prepare(
      `SELECT COUNT(*) AS n FROM cards
       WHERE status IN ('learning','review') AND (lapses > 0 OR ease < 2)`
    )
    .get() as { n: number }
  return {
    pendientes_hoy: pendientes.n,
    nuevas_disponibles: Math.max(0, dailyNewLimit - newUsed),
    dificiles: dificiles.n,
  }
}

/** Racha de días con repaso (terminando hoy o ayer si hoy aún no hay). */
export function streak(db: DatabaseSync, now = Date.now()): number {
  const rows = db
    .prepare('SELECT day, reviews FROM stats_daily WHERE reviews > 0 ORDER BY day DESC')
    .all() as { day: string; reviews: number }[]
  if (rows.length === 0) return 0
  const daySet = new Set(rows.map((r) => r.day))
  let cursor = new Date(now)
  if (!daySet.has(toDay(cursor.getTime()))) {
    cursor = new Date(cursor.getTime() - 86_400_000)
  }
  let count = 0
  while (daySet.has(toDay(cursor.getTime()))) {
    count += 1
    cursor = new Date(cursor.getTime() - 86_400_000)
  }
  return count
}

export interface StatsResult {
  total: number
  nuevas: number
  aprendiendo: number
  dominadas: number
  dificiles: number
  pendientes_hoy: number
  racha: number
  aciertos_pct: number
  por_categoria: Record<string, number>
}

export function getStats(db: DatabaseSync, now = Date.now()): StatsResult {
  const byStatus = (status: string) =>
    (db.prepare('SELECT COUNT(*) AS n FROM cards WHERE status = ?').get(status) as { n: number }).n
  const dificiles = dueStatus(db, now).dificiles
  const pendientes_hoy = dueStatus(db, now).pendientes_hoy
  const totals = db
    .prepare('SELECT COUNT(*) AS n, SUM(CASE WHEN grade >= 3 THEN 1 ELSE 0 END) AS ok, SUM(CASE WHEN grade < 3 THEN 1 ELSE 0 END) AS ko FROM reviews_log')
    .get() as { n: number; ok: number | null; ko: number | null }
  const ok = totals.ok ?? 0
  const ko = totals.ko ?? 0
  const aciertos_pct = ok + ko > 0 ? Math.round((ok / (ok + ko)) * 1000) / 10 : 0
  const byCat = db
    .prepare('SELECT category, COUNT(*) AS n FROM cards GROUP BY category ORDER BY n DESC')
    .all() as { category: string; n: number }[]
  const por_categoria: Record<string, number> = {}
  for (const row of byCat) por_categoria[row.category] = row.n
  return {
    total: byStatus('new') + byStatus('learning') + byStatus('review') + byStatus('mastered') + byStatus('suspended'),
    nuevas: byStatus('new'),
    aprendiendo: byStatus('learning'),
    dominadas: byStatus('mastered'),
    dificiles,
    pendientes_hoy,
    racha: streak(db, now),
    aciertos_pct,
    por_categoria,
  }
}
