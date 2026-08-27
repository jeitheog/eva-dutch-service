/**
 * Pre-genera los audios de pronunciación de TODAS las tarjetas de Lingua.
 *
 * Para cada tarjeta sin data/audio/<id>.ogg llama a
 * GET /api/v1/dutch/audio/:cardId (que lo sintetiza con edge-tts y lo
 * guarda en disco) — el audio queda listo y el repaso no espera.
 *
 * Uso: node scripts/generate-audio.mjs   (desde la raíz del repo; lee .env)
 */

import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const audioDir = path.join(repoRoot, 'data', 'audio')
fs.mkdirSync(audioDir, { recursive: true, mode: 0o700 })

const baseUrl = process.env.DUTCH_SERVICE_URL ?? 'http://127.0.0.1:3022'
const apiKey = process.env.DUTCH_SERVICE_API_KEY
if (!apiKey) {
  console.error('✗ Falta DUTCH_SERVICE_API_KEY en .env')
  process.exit(1)
}
const headers = { 'x-dutch-service-api-key': apiKey }

async function main() {
  const res = await fetch(`${baseUrl}/api/v1/dutch/cards?limit=500`, { headers })
  if (!res.ok) throw new Error(`GET /cards → HTTP ${res.status}`)
  const { cards } = await res.json()
  console.log(`Tarjetas en BD: ${cards.length}`)

  let generated = 0
  let skipped = 0
  let failed = 0
  for (const card of cards) {
    const file = path.join(audioDir, `${card.id}.ogg`)
    if (fs.existsSync(file)) {
      skipped += 1
      continue
    }
    const r = await fetch(`${baseUrl}/api/v1/dutch/audio/${card.id}`, { headers })
    if (!r.ok) {
      failed += 1
      console.error(`  ✗ card ${card.id} ("${card.nl}") → HTTP ${r.status}`)
      continue
    }
    const bytes = await r.arrayBuffer()
    fs.writeFileSync(file, Buffer.from(bytes))
    generated += 1
    if (generated % 25 === 0 || generated === 1) {
      console.log(`  … ${generated} generados`)
    }
  }

  const totalBytes = fs
    .readdirSync(audioDir)
    .filter((f) => f.endsWith('.ogg'))
    .reduce((acc, f) => acc + fs.statSync(path.join(audioDir, f)).size, 0)
  const count = fs.readdirSync(audioDir).filter((f) => f.endsWith('.ogg')).length
  console.log(`\n✅ generados: ${generated} | ya existían: ${skipped} | fallos: ${failed}`)
  console.log(`📦 data/audio: ${count} archivos, ${(totalBytes / 1024 / 1024).toFixed(2)} MB`)
  if (failed > 0) process.exitCode = 1
}

main().catch((e) => {
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
