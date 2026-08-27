/**
 * Tests del motor SRS (SM-2) de Lingua — node:test, sin red.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../db'
import { createCard, dueCards, dueStatus, getStats, reviewCard, sm2, streak, type Card, type SrsState } from '../services/srs'

function freshDb() {
  return openDb(':memory:')
}

function baseCard(): SrsState {
  return { ease: 2.5, repetitions: 0, lapses: 0, interval_days: 0, status: 'new' }
}

function cardOf(r: { duplicate: false; card: Card } | { duplicate: true; existing_id: number }): Card {
  if (r.duplicate) throw new Error('duplicate inesperado en test')
  return r.card
}

test('SRS: grade 5 → intervalo crece (1d → 3d → 7d → 14d → 30d)', () => {
  const now = Date.UTC(2026, 7, 27, 10, 0, 0)
  const c = baseCard()
  const r1 = sm2(5, c, now)
  assert.equal(r1.repetitions, 1)
  assert.equal(r1.intervalDays, 1)
  assert.equal(r1.status, 'review')
  assert.equal(r1.dueAt, now + 86_400_000)

  const r2 = sm2(5, r1, now)
  assert.equal(r2.intervalDays, 3)
  const r3 = sm2(5, r2, now)
  assert.equal(r3.intervalDays, 7)
  const r4 = sm2(5, r3, now)
  assert.equal(r4.intervalDays, 14)
  const r5 = sm2(5, r4, now)
  assert.equal(r5.intervalDays, 30)
  assert.equal(r5.status, 'mastered')
  // Más allá de la secuencia: intervalo × ease (ease sube con grade 5)
  const r6 = sm2(5, r5, now)
  assert.ok(r6.intervalDays > 30, `intervalo ${r6.intervalDays} > 30`)
  assert.ok(r6.ease > 2.5, 'ease sube con grade 5')
})

test('SRS: grade 0 → lapse (repetitions=0, lapses+1, ease baja, due pronto)', () => {
  const now = Date.UTC(2026, 7, 27, 10, 0, 0)
  const after = sm2(5, baseCard(), now) // 1d, review
  const failed = sm2(0, after, now)
  assert.equal(failed.repetitions, 0)
  assert.equal(failed.lapses, 1)
  assert.ok(failed.ease < after.ease)
  assert.equal(failed.status, 'learning')
  assert.ok(failed.dueAt < now + 60 * 60 * 1000, 'due en minutos, no días')
  assert.equal(failed.intervalDays, 0)
})

test('SRS: grade 3 también es éxito (normal → intervalo 1d)', () => {
  const now = Date.now()
  const r = sm2(3, baseCard(), now)
  assert.equal(r.repetitions, 1)
  assert.equal(r.intervalDays, 1)
  assert.ok(r.ease <= 2.5, 'grade 3 baja ligeramente el ease (2.5 → 2.36)')
})

test('SRS: reviewCard persiste en SQLite y actualiza stats_daily + errors_log', () => {
  const db = freshDb()
  const rNew = createCard(db, { front: 'Geef me de halter even', back: 'Dame la mancuerna un momento', nl: 'Geef me de halter even', es: 'Dame la mancuerna un momento' })
  const card = cardOf(rNew)
  const now = Date.UTC(2026, 7, 27, 12, 0, 0)
  const updated = reviewCard(db, card.id, 3, 5000, now)
  assert.equal(updated.status, 'review')
  assert.equal(updated.due_at, now + 86_400_000)
  // stats_daily
  const day = '2026-08-27'
  const stats = db.prepare('SELECT * FROM stats_daily WHERE day = ?').get(day) as { reviews: number; correct: number; wrong: number; new_cards: number }
  assert.equal(stats.reviews, 1)
  assert.equal(stats.correct, 1)
  assert.equal(stats.wrong, 0)
  assert.equal(stats.new_cards, 1)
  // errors_log NO debe tener entradas con grade 3
  const errors = db.prepare('SELECT COUNT(*) AS n FROM errors_log').get() as { n: number }
  assert.equal(errors.n, 0)

  // Fallo → errors_log
  reviewCard(db, card.id, 0, 3000, now + 1000)
  const errors2 = db.prepare('SELECT * FROM errors_log').all() as Array<{ tipo: string; card_id: number }>
  assert.equal(errors2.length, 1)
  assert.equal(errors2[0].tipo, 'olvidada')
})

test('SRS: dueCards devuelve vencidas ordenadas por due_at y respeta límite diario de nuevas', () => {
  const db = freshDb()
  const now = Date.UTC(2026, 7, 27, 12, 0, 0)
  const a = cardOf(createCard(db, { front: 'A', back: 'a' }, now))
  const b = cardOf(createCard(db, { front: 'B', back: 'b' }, now))
  // a vence antes (created first), ambas due ya
  const due = dueCards(db, now, 10)
  assert.equal(due.length, 2)
  assert.equal(due[0].id, a.id)

  // Agotamos el cupo de nuevas del día (20) → las 'new' salen de la cola
  for (let i = 0; i < 20; i++) {
    const nc = cardOf(createCard(db, { front: `N${i}`, back: 'n' }, now))
    reviewCard(db, nc.id, 5, 0, now + i)
  }
  // Forzamos otra tarjeta nueva vencida
  const c = cardOf(createCard(db, { front: 'C', back: 'c' }, now))
  const due2 = dueCards(db, now, 10, 20)
  assert.ok(!due2.some((x) => x.id === c.id), 'nueva excluida al agotar cupo diario')
  const status = dueStatus(db, now, 20)
  assert.equal(status.nuevas_disponibles, 0)
})

test('SRS: racha cuenta días consecutivos con repaso', () => {
  const db = freshDb()
  const now = Date.UTC(2026, 7, 27, 12, 0, 0)
  const card = cardOf(createCard(db, { front: 'X', back: 'x' }, now))
  reviewCard(db, card.id, 5, 0, now - 2 * 86_400_000) // 25 ago
  reviewCard(db, card.id, 5, 0, now - 1 * 86_400_000) // 26 ago
  assert.equal(streak(db, now), 2) // 25+26 consecutivos (hoy aún no hay repaso)
  reviewCard(db, card.id, 5, 0, now) // 27 ago
  assert.equal(streak(db, now), 3)
})

test('SRS: getStats resume todo (aciertos, por_categoria, dificiles)', () => {
  const db = freshDb()
  createCard(db, { front: 'Hallo', back: 'Hola', category: 'saludos' })
  createCard(db, { front: 'Dank je', back: 'Gracias', category: 'saludos' })
  const card = cardOf(createCard(db, { front: 'Fiets', back: 'Bici', category: 'transporte' }))
  reviewCard(db, card.id, 5, 0, Date.now())
  const s = getStats(db)
  assert.equal(s.total, 3)
  assert.equal(s.nuevas, 2)
  assert.equal(s.dominadas, 0)
  assert.equal(s.por_categoria['saludos'], 2)
  assert.equal(s.por_categoria['transporte'], 1)
  assert.equal(s.aciertos_pct, 100)
})
