/**
 * Tests del audio de Lingua: la voz edge-tts depende del idioma de la
 * tarjeta ('en' → en-US-ChristopherNeural, 'nl' → nl-NL-MaartenNeural).
 * execFile mockeado (mismo objeto require que src/api/audio.js): sin red,
 * sin edge-tts real.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// Referencia DIRECTA al objeto del módulo (CommonJS): el mock parchea el
// mismo objeto que require('node:child_process') en audio.js.
import cp = require('node:child_process')
import {
  TTS_VOICE_EN,
  TTS_VOICE_NL,
  synthOgg,
  voiceForLanguage,
} from '../api/audio'

test('voiceForLanguage: nl → voz neerlandesa, en → voz inglesa, default nl', () => {
  assert.equal(voiceForLanguage('nl'), TTS_VOICE_NL)
  assert.equal(voiceForLanguage('en'), TTS_VOICE_EN)
  assert.equal(voiceForLanguage(undefined), TTS_VOICE_NL)
  assert.equal(voiceForLanguage(''), TTS_VOICE_NL)
  assert.ok(TTS_VOICE_NL.startsWith('nl-'), 'voz neerlandesa de edge-tts')
  assert.ok(TTS_VOICE_EN.startsWith('en-'), 'voz inglesa de edge-tts')
})

test('synthOgg usa la voz pasada (mock): nl → Maarten, en → Christopher, y convierte a OGG', async (t) => {
  const calls: Array<{ bin: string; args: string[] }> = []
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingua-audio-test-'))

  t.mock.method(cp, 'execFile', ((_bin: string, args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
    calls.push({ bin: _bin, args: args as string[] })
    // edge-tts → escribe el mp3 temporal; ffmpeg → escribe el ogg final.
    const out = (args as string[])[(args as string[]).length - 1]
    fs.writeFileSync(out, 'stub')
    cb(null)
  }) as typeof cp.execFile)

  try {
    const nlOut = path.join(tmpDir, 'nl.ogg')
    await synthOgg('Goedemorgen', nlOut, TTS_VOICE_NL)
    assert.equal(calls[0].bin.includes('edge-tts'), true)
    assert.equal(calls[0].args.includes('--voice'), true)
    assert.equal(calls[0].args[calls[0].args.indexOf('--voice') + 1], TTS_VOICE_NL)
    assert.equal(calls[0].args[calls[0].args.indexOf('--text') + 1], 'Goedemorgen')
    assert.equal(calls[1].bin, 'ffmpeg', 'convierte mp3 → ogg')
    assert.ok(fs.existsSync(nlOut))

    const enOut = path.join(tmpDir, 'en.ogg')
    await synthOgg('Good morning', enOut, TTS_VOICE_EN)
    const enCall = calls[2]
    assert.equal(enCall.args[enCall.args.indexOf('--voice') + 1], TTS_VOICE_EN, 'voz inglesa para tarjetas en')
    assert.equal(enCall.args[enCall.args.indexOf('--text') + 1], 'Good morning')
    assert.ok(fs.existsSync(enOut))
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})
