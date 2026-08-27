/**
 * API REST de Lingua (eva-dutch-service) — todo bajo /api/v1/dutch,
 * auth x-dutch-service-api-key.
 */

import { Router } from 'express'
import { z } from 'zod'
import type { DatabaseSync } from 'node:sqlite'
import { audit, ensureStudentRow } from '../db'
import { createCard, dueCards, dueStatus, getCard, getStats, listCards, reviewCard } from '../services/srs'
import { createTranslator, fallbackTranslate } from '../services/llm'

const cardSchema = z.object({
  type: z.enum(['phrase', 'word']).optional(),
  front: z.string().min(1),
  back: z.string().min(1),
  nl: z.string().optional(),
  es: z.string().optional(),
  pronunciation: z.string().optional(),
  explanation: z.string().optional(),
  grammar: z.string().optional(),
  examples: z.union([z.array(z.string()), z.string()]).optional(),
  context: z.string().optional(),
  category: z.string().optional(),
  source: z.enum(['manual', 'photo', 'book', 'conversation', 'curriculum', 'error']).optional(),
})

const reviewSchema = z.object({
  card_id: z.number().int().positive(),
  grade: z.number().int().min(0).max(5),
  latency_ms: z.number().int().min(0).optional(),
})

const studentSchema = z.object({
  nombre: z.string().optional(),
  nivel: z.enum(['beginner', 'intermediate', 'advanced']).optional(),
  profesion: z.string().optional(),
  hobbies: z.union([z.array(z.string()), z.string()]).optional(),
  objetivos: z.string().optional(),
  situaciones: z.union([z.array(z.string()), z.string()]).optional(),
  dificultades: z.union([z.array(z.string()), z.string()]).optional(),
  preferencia_metodo: z.string().optional(),
})

const errorSchema = z.object({
  card_id: z.number().int().positive().optional(),
  tipo: z.enum(['olvidada', 'gramatica', 'articulo', 'orden', 'verbo', 'vocabulario']).default('olvidada'),
  detail: z.string().optional(),
  pattern: z.string().optional(),
})

const translateSchema = z.object({
  text: z.string().min(1),
  direction: z.enum(['es2nl', 'nl2es', 'auto']).optional(),
  add_card: z.boolean().optional(),
  type: z.enum(['phrase', 'word']).optional(),
  category: z.string().optional(),
})

function toJsonArray(v: string[] | string | undefined): string {
  if (v === undefined) return '[]'
  if (Array.isArray(v)) return JSON.stringify(v)
  return v
}

export function dutchRouter(db: DatabaseSync): Router {
  const router = Router()
  const translator = createTranslator()

  // ── Tarjetas ──────────────────────────────────────────────────────────────
  router.post('/cards', (req, res) => {
    const parsed = cardSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ error: 'Datos inválidos', issues: parsed.error.issues })
    }
    const b = parsed.data
    try {
      const result = createCard(db, {
        type: b.type,
        front: b.front,
        back: b.back,
        nl: b.nl,
        es: b.es,
        pronunciation: b.pronunciation,
        explanation: b.explanation,
        grammar: b.grammar,
        examples: toJsonArray(b.examples),
        context: b.context,
        category: b.category,
        source: b.source,
      })
      if (result.duplicate) return res.json({ duplicate: true, existing_id: result.existing_id })
      return res.status(201).json({ duplicate: false, card: result.card })
    } catch (e) {
      return res.status(500).json({ error: (e as Error).message })
    }
  })

  router.get('/cards', (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined
    const category = typeof req.query.category === 'string' ? req.query.category : undefined
    const limit = Number(req.query.limit ?? 100)
    res.json({ cards: listCards(db, { status, category, limit }) })
  })

  // ── Repaso (SRS) ──────────────────────────────────────────────────────────
  router.get('/review/queue', (req, res) => {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 10)))
    res.json({ cards: dueCards(db, Date.now(), limit) })
  })

  router.post('/review', (req, res) => {
    const parsed = reviewSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ error: 'Datos inválidos', issues: parsed.error.issues })
    }
    try {
      const card = reviewCard(db, parsed.data.card_id, parsed.data.grade, parsed.data.latency_ms ?? 0)
      res.json({ ok: true, card })
    } catch (e) {
      res.status(404).json({ error: (e as Error).message })
    }
  })

  // ── Stats / due ───────────────────────────────────────────────────────────
  router.get('/stats', (_req, res) => {
    res.json(getStats(db))
  })

  router.get('/due/status', (_req, res) => {
    res.json(dueStatus(db))
  })

  // ── Memoria del alumno ────────────────────────────────────────────────────
  router.get('/student', (_req, res) => {
    ensureStudentRow(db)
    res.json(db.prepare('SELECT * FROM student WHERE id = 1').get())
  })

  router.post('/student', (req, res) => {
    const parsed = studentSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ error: 'Datos inválidos', issues: parsed.error.issues })
    }
    ensureStudentRow(db)
    const now = Date.now()
    const sets: string[] = []
    const params: Array<string | number> = []
    const fields: Record<string, string | string[] | undefined> = parsed.data as Record<string, string | string[] | undefined>
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue
      if (key === 'hobbies' || key === 'situaciones' || key === 'dificultades') {
        sets.push(`${key} = ?`)
        params.push(toJsonArray(value as string[] | string))
      } else {
        sets.push(`${key} = ?`)
        params.push(String(value))
      }
    }
    if (sets.length === 0) return res.json(db.prepare('SELECT * FROM student WHERE id = 1').get())
    sets.push('updated_at = ?')
    params.push(now)
    db.prepare(`UPDATE student SET ${sets.join(', ')} WHERE id = 1`).run(...params)
    audit(db, 'student.update', sets.join(','), 'student', 1)
    res.json(db.prepare('SELECT * FROM student WHERE id = 1').get())
  })

  // ── Errores ───────────────────────────────────────────────────────────────
  router.post('/errors', (req, res) => {
    const parsed = errorSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ error: 'Datos inválidos', issues: parsed.error.issues })
    }
    const b = parsed.data
    const result = db
      .prepare('INSERT INTO errors_log (ts, card_id, tipo, detail, pattern) VALUES (?, ?, ?, ?, ?)')
      .run(Date.now(), b.card_id ?? null, b.tipo, b.detail ?? '', b.pattern ?? '')
    res.status(201).json({ ok: true, id: Number(result.lastInsertRowid) })
  })

  router.get('/errors', (req, res) => {
    const tipo = typeof req.query.tipo === 'string' ? req.query.tipo : undefined
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50)))
    const where = tipo ? 'WHERE tipo = ?' : ''
    const params: Array<string | number> = tipo ? [tipo, limit] : [limit]
    const rows = db
      .prepare(`SELECT * FROM errors_log ${where} ORDER BY ts DESC LIMIT ?`)
      .all(...params) as unknown[]
    const patterns = db
      .prepare(
        `SELECT pattern, COUNT(*) AS n FROM errors_log
         WHERE pattern <> '' GROUP BY pattern ORDER BY n DESC LIMIT 10`
      )
      .all()
    res.json({ errors: rows, patterns })
  })

  // ── Traducción (LLM + tarjeta opcional) ───────────────────────────────────
  router.post('/translate', async (req, res) => {
    const parsed = translateSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ error: 'Datos inválidos', issues: parsed.error.issues })
    }
    const { text, direction, add_card, type, category } = parsed.data
    let t
    try {
      t = await translator.translate(text, direction ?? 'auto')
    } catch {
      t = fallbackTranslate(text, direction)
    }
    if (!add_card) return res.json(t)

    const front = t.nl || text
    const back = t.es || text
    const result = createCard(db, {
      type,
      front,
      back,
      nl: t.nl || text,
      es: t.es || text,
      pronunciation: t.pronunciation,
      explanation: t.explanation,
      examples: t.examples,
      category: category ?? 'general',
      source: 'manual',
    })
    if (result.duplicate) {
      const existing = getCard(db, result.existing_id)
      return res.json({ duplicate: true, existing_id: result.existing_id, card: existing, ...t })
    }
    res.status(201).json({ duplicate: false, card: result.card, ...t })
  })

  return router
}
