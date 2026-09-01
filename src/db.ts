/**
 * Capa de datos de Lingua (eva-dutch-service): SQLite vía node:sqlite.
 * Esquema: cards (tarjetas NL↔ES), reviews_log (historial SM-2), student
 * (memoria del alumno), errors_log (errores detectados), stats_daily
 * (estadísticas por día) y audit_log (traza de acciones).
 */

import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'

export interface Card {
  id: number
  type: 'phrase' | 'word'
  /** Idioma objetivo de la tarjeta: 'nl' (holandés) | 'en' (inglés). */
  language: 'nl' | 'en'
  front: string
  back: string
  nl: string
  es: string
  pronunciation: string
  explanation: string
  grammar: string
  examples: string
  context: string
  category: string
  source: string
  created_at: number
  due_at: number
  interval_days: number
  ease: number
  repetitions: number
  lapses: number
  status: 'new' | 'learning' | 'review' | 'mastered' | 'suspended'
}

export type CardStatus = Card['status']

export function openDb(dbPath: string): DatabaseSync {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 })
  }
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  return db
}

export function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL DEFAULT 'phrase' CHECK (type IN ('phrase','word')),
      language TEXT NOT NULL DEFAULT 'nl' CHECK (language IN ('nl','en')),
      front TEXT NOT NULL,
      back TEXT NOT NULL,
      nl TEXT NOT NULL DEFAULT '',
      es TEXT NOT NULL DEFAULT '',
      pronunciation TEXT NOT NULL DEFAULT '',
      explanation TEXT NOT NULL DEFAULT '',
      grammar TEXT NOT NULL DEFAULT '',
      examples TEXT NOT NULL DEFAULT '[]',
      context TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'general',
      source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','photo','book','conversation','curriculum','error')),
      created_at INTEGER NOT NULL,
      due_at INTEGER NOT NULL,
      interval_days REAL NOT NULL DEFAULT 0,
      ease REAL NOT NULL DEFAULT 2.5,
      repetitions INTEGER NOT NULL DEFAULT 0,
      lapses INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','learning','review','mastered','suspended'))
    );
    CREATE INDEX IF NOT EXISTS idx_cards_due ON cards (due_at);
    CREATE INDEX IF NOT EXISTS idx_cards_status ON cards (status);
  `)

  // Migración: tarjetas existentes (sin columna) → language 'nl'. El índice
  // de language se crea DESPUÉS del ALTER (sobre la columna ya existente).
  const cardCols = db.prepare('PRAGMA table_info(cards)').all() as { name: string }[]
  if (!cardCols.some((c) => c.name === 'language')) {
    db.exec(`ALTER TABLE cards ADD COLUMN language TEXT NOT NULL DEFAULT 'nl'`)
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_cards_language ON cards (language)')

  db.exec(`
    CREATE TABLE IF NOT EXISTS reviews_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      ts INTEGER NOT NULL,
      grade INTEGER NOT NULL CHECK (grade BETWEEN 0 AND 5),
      latency_ms INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_reviews_card ON reviews_log (card_id);
    CREATE INDEX IF NOT EXISTS idx_reviews_ts ON reviews_log (ts);

    CREATE TABLE IF NOT EXISTS student (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      nombre TEXT NOT NULL DEFAULT '',
      nivel TEXT NOT NULL DEFAULT 'beginner' CHECK (nivel IN ('beginner','intermediate','advanced')),
      profesion TEXT NOT NULL DEFAULT '',
      hobbies TEXT NOT NULL DEFAULT '[]',
      objetivos TEXT NOT NULL DEFAULT '',
      situaciones TEXT NOT NULL DEFAULT '[]',
      dificultades TEXT NOT NULL DEFAULT '[]',
      preferencia_metodo TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS errors_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      card_id INTEGER REFERENCES cards(id) ON DELETE SET NULL,
      tipo TEXT NOT NULL CHECK (tipo IN ('olvidada','gramatica','articulo','orden','verbo','vocabulario')),
      detail TEXT NOT NULL DEFAULT '',
      pattern TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_errors_tipo ON errors_log (tipo);

    CREATE TABLE IF NOT EXISTS stats_daily (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day TEXT NOT NULL UNIQUE,
      new_cards INTEGER NOT NULL DEFAULT 0,
      reviews INTEGER NOT NULL DEFAULT 0,
      correct INTEGER NOT NULL DEFAULT 0,
      wrong INTEGER NOT NULL DEFAULT 0,
      minutes INTEGER NOT NULL DEFAULT 0,
      streak INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      action TEXT NOT NULL,
      entity TEXT NOT NULL DEFAULT '',
      entity_id INTEGER,
      detail TEXT NOT NULL DEFAULT ''
    );
  `)
}

/** Fila de stats_daily como objeto. */
export interface DailyStats {
  day: string
  new_cards: number
  reviews: number
  correct: number
  wrong: number
  minutes: number
  streak: number
}

export const DAY_MS = 86_400_000

export function toDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10)
}

/** Fin del día (23:59:59.999 UTC) para el día que contiene ts. */
export function endOfDay(ts: number): number {
  const d = new Date(ts)
  d.setUTCHours(23, 59, 59, 999)
  return d.getTime()
}

export function ensureStudentRow(db: DatabaseSync, now = Date.now()): void {
  db.prepare(
    `INSERT OR IGNORE INTO student (id, nivel, created_at, updated_at)
     VALUES (1, 'beginner', ?, ?)`
  ).run(now, now)
}

/** Suma contadores a stats_daily (UPSERT) y devuelve la fila resultante. */
export function bumpDailyStats(
  db: DatabaseSync,
  day: string,
  delta: Partial<DailyStats>
): void {
  db.prepare(
    `INSERT INTO stats_daily (day, new_cards, reviews, correct, wrong, minutes, streak)
     VALUES (?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(day) DO UPDATE SET
       new_cards = new_cards + excluded.new_cards,
       reviews = reviews + excluded.reviews,
       correct = correct + excluded.correct,
       wrong = wrong + excluded.wrong,
       minutes = minutes + excluded.minutes`
  ).run(
    day,
    delta.new_cards ?? 0,
    delta.reviews ?? 0,
    delta.correct ?? 0,
    delta.wrong ?? 0,
    delta.minutes ?? 0
  )
}

export function getDailyStats(db: DatabaseSync, day: string): DailyStats | undefined {
  return db
    .prepare('SELECT * FROM stats_daily WHERE day = ?')
    .get(day) as DailyStats | undefined
}

export function audit(db: DatabaseSync, action: string, detail: string, entity = '', entityId: number | null = null): void {
  db.prepare(
    'INSERT INTO audit_log (ts, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?)'
  ).run(Date.now(), action, entity, entityId, detail)
}
