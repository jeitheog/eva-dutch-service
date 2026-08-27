/**
 * Tests de la capa de datos + duplicados + API de Lingua — node:test, sin red.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../db'
import { createCard, listCards, reviewCard, type Card } from '../services/srs'
import { fallbackTranslate, looksDutch } from '../services/llm'

test('Duplicados: mismo front o mismo nl → duplicate:true con existing_id', () => {
  const db = openDb(':memory:')
  const r1 = createCard(db, { front: 'Goedemorgen', back: 'Buenos días', nl: 'Goedemorgen', es: 'Buenos días' })
  assert.equal(r1.duplicate, false)

  // Mismo front (con mayúsculas/espacios distintos)
  const r2 = createCard(db, { front: '  goedemorgen ', back: 'otra', nl: 'X', es: 'Y' })
  assert.equal(r2.duplicate, true)
  assert.equal(r2.existing_id, (r1 as { card: { id: number } }).card.id)

  // Mismo nl con front distinto
  const r3 = createCard(db, { front: 'Otro front', back: 'Buenos días', nl: 'Goedemorgen', es: 'Buenos días' })
  assert.equal(r3.duplicate, true)
  assert.equal(r3.existing_id, (r1 as { card: { id: number } }).card.id)

  // Un front distinto y nl distinto → se crea
  const r4 = createCard(db, { front: 'Tot ziens', back: 'Hasta luego', nl: 'Tot ziens', es: 'Hasta luego' })
  assert.equal(r4.duplicate, false)
})

test('createCard: valores por defecto correctos (ease 2.5, status new, due ya)', () => {
  const db = openDb(':memory:')
  const r = createCard(db, { front: 'Hoi', back: 'Hola', nl: 'Hoi', es: 'Hola', examples: ['Hoi, hoe gaat het?'] })
  assert.equal(r.duplicate, false)
  const card = (r as { duplicate: false; card: Card }).card
  assert.equal(card.ease, 2.5)
  assert.equal(card.status, 'new')
  assert.equal(card.repetitions, 0)
  assert.ok(card.due_at <= Date.now())
  assert.equal(card.source, 'manual')
  assert.equal(JSON.parse(card.examples).length, 1)
  const audit = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'card.create'").get() as { n: number }
  assert.equal(audit.n, 1, 'audit de creación registrado')
})

test('listCards filtra por status y category', () => {
  const db = openDb(':memory:')
  createCard(db, { front: 'A', back: 'a', category: 'saludos' })
  const b = createCard(db, { front: 'B', back: 'b', category: 'casa' })
  reviewCard(db, (b as { card: { id: number } }).card.id, 5, 0)
  assert.equal(listCards(db, { status: 'new' }).length, 1)
  assert.equal(listCards(db, { category: 'casa' }).length, 1)
  assert.equal(listCards(db, { status: 'review' }).length, 1)
})

test('fallbackTranslate: diccionario básico + literal, nunca explota', () => {
  assert.equal(looksDutch('Geef me de halter even'), true)
  assert.equal(looksDutch('Me gusta el café'), false)
  const r = fallbackTranslate('Geef me de halter even')
  assert.equal(r.es, 'dame la mancuerna un momento')
  assert.equal(r.used_llm, false)
  const r2 = fallbackTranslate('hola', 'es2nl')
  assert.equal(r2.nl, 'hola') // literal (no está en el diccionario)
})
