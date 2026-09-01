/**
 * Carga el material inicial de INGLÉS (ES→EN) en eva-dutch-service vía
 * POST /cards con language='en'. Sin dependencia del LLM: frases escritas
 * a mano (quality over quantity). El service deduplica por idioma.
 *
 * Uso: node --env-file=.env scripts/load-english.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const base = process.env.DUTCH_SERVICE_URL ?? 'http://127.0.0.1:3022'
const key = process.env.DUTCH_SERVICE_API_KEY
if (!key) {
  console.error('Falta DUTCH_SERVICE_API_KEY (usa --env-file=.env)')
  process.exit(1)
}

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'english-150.json')
const phrases = JSON.parse(fs.readFileSync(file, 'utf-8'))

let created = 0
let duplicates = 0
let errors = 0
for (const p of phrases) {
  const body = {
    type: 'phrase',
    language: 'en',
    front: p.en,
    back: p.es,
    nl: '',
    es: p.es,
    pronunciation: p.pronunciation ?? '',
    explanation: '',
    examples: [],
    category: p.category ?? 'general',
    source: 'manual',
  }
  try {
    const res = await fetch(`${base}/api/v1/dutch/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-dutch-service-api-key': key },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    if (data.duplicate) duplicates += 1
    else if (res.ok) created += 1
    else {
      errors += 1
      console.error(`  error ${res.status} en "${p.en}": ${JSON.stringify(data).slice(0, 120)}`)
    }
  } catch (e) {
    errors += 1
    console.error(`  fetch falló en "${p.en}": ${String(e)}`)
  }
}

console.log(JSON.stringify({ total: phrases.length, created, duplicates, errors }))
