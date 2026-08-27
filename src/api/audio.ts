/**
 * Audio de pronunciación de Lingua: GET /api/v1/dutch/audio/:cardId.
 * Si data/audio/<cardId>.ogg existe lo devuelve; si no, lo genera con
 * edge-tts (voz nl-NL-MaartenNeural, texto = campo nl de la tarjeta) y
 * lo guarda para la próxima vez. 404 si la tarjeta no existe.
 */

import { Router } from 'express'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { config, APP_DIR } from '../config'
import { getCard } from '../services/srs'

/** data/audio bajo la raíz del repo (ignorado por git). */
export const AUDIO_DIR = path.join(APP_DIR, 'data', 'audio')
/** Voz neerlandesa de Microsoft (edge-tts, gratuito, sin API key). */
export const TTS_VOICE = process.env.DUTCH_TTS_VOICE ?? 'nl-NL-MaartenNeural'
export const EDGE_TTS_BIN = process.env.DUTCH_TTS_BIN ?? path.join(APP_DIR, 'tts-venv', 'bin', 'edge-tts')

/**
 * Sintetiza text → outFile con edge-tts + conversión a OGG/Opus.
 * edge-tts 7.x emite MP3 fijo (audio-24khz-48kbitrate-mono-mp3) y Telegram
 * exige OGG/Opus en sendVoice → se convierte con ffmpeg (libopus).
 */
export function synthOgg(text: string, outFile: string, timeoutMs = 60_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const tmpMp3 = `${outFile}.mp3.tmp`
    execFile(
      EDGE_TTS_BIN,
      ['--voice', TTS_VOICE, '--text', text, '--write-media', tmpMp3],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err) => {
        if (err) return reject(err)
        execFile(
          'ffmpeg',
          ['-y', '-loglevel', 'error', '-i', tmpMp3, '-ac', '1', '-ar', '24000', '-c:a', 'libopus', '-b:a', '48k', '-application', 'voip', outFile],
          { timeout: timeoutMs },
          (ffErr) => {
            fs.rmSync(tmpMp3, { force: true })
            if (ffErr) return reject(ffErr)
            resolve()
          }
        )
      }
    )
  })
}

/** Devuelve (y si hace falta genera) el audio ogg de una tarjeta. */
export async function ensureCardAudio(cardId: number, text: string): Promise<string> {
  fs.mkdirSync(AUDIO_DIR, { recursive: true, mode: 0o700 })
  const file = path.join(AUDIO_DIR, `${cardId}.ogg`)
  if (!fs.existsSync(file)) {
    await synthOgg(text, file)
    if (!fs.existsSync(file)) throw new Error('edge-tts no produjo el archivo de audio')
  }
  return file
}

export function audioRouter(db: DatabaseSync): Router {
  const router = Router()

  router.get('/audio/:cardId', async (req, res) => {
    const cardId = Number(req.params.cardId)
    if (!Number.isInteger(cardId) || cardId <= 0) {
      return res.status(400).json({ error: 'cardId inválido' })
    }
    const card = getCard(db, cardId)
    if (!card) {
      return res.status(404).json({ error: `Tarjeta ${cardId} no existe` })
    }
    const text = (card.nl || card.front || '').trim()
    if (!text) {
      return res.status(422).json({ error: 'La tarjeta no tiene texto para sintetizar' })
    }
    try {
      const file = await ensureCardAudio(cardId, text)
      res.setHeader('Content-Type', 'audio/ogg')
      res.sendFile(file)
    } catch (e) {
      res.status(500).json({ error: `No pude generar el audio: ${(e as Error).message}` })
    }
  })

  return router
}
