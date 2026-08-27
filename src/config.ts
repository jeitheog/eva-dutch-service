import 'dotenv/config'
import { config as loadDotenv } from 'dotenv'
import { existsSync } from 'node:fs'
import path from 'node:path'

// Carga el .env global del VPS (/opt/data/.env) para API_SERVER_KEY (LLM
// interno vía api_server 8642). Silencioso si no existe (instalaciones locales).
if (existsSync('/opt/data/.env')) {
  loadDotenv({ path: '/opt/data/.env', quiet: true })
}

/** Raíz del repo: dist/config.js → un nivel arriba. */
export const APP_DIR = path.resolve(__dirname, '..')

export const config = {
  port: Number(process.env.DUTCH_SERVICE_PORT ?? 3022),
  apiKey: process.env.DUTCH_SERVICE_API_KEY ?? '',
  dbPath: process.env.DUTCH_DB_PATH ?? 'data/dutch.sqlite',
  /** api_server interno del VPS (model hermes, key API_SERVER_KEY del .env global). */
  llmBaseUrl: process.env.DUTCH_LLM_BASE_URL ?? 'http://127.0.0.1:8642',
  llmApiKey: process.env.API_SERVER_KEY ?? '',
  llmModel: process.env.DUTCH_LLM_MODEL ?? 'hermes',
  /** Límite diario de tarjetas nuevas que entran en sesiones de repaso. */
  dailyNewLimit: Number(process.env.DUTCH_DAILY_NEW_LIMIT ?? 20),
}

/** Auth service-to-service: header x-dutch-service-api-key. */
export function requireApiKey(
  req: { header(name: string): string | undefined },
  res: { status(code: number): { json(body: unknown): unknown } },
  next: () => void
): void {
  const key = req.header('x-dutch-service-api-key')
  if (!config.apiKey || key !== config.apiKey) {
    res.status(401).json({ error: 'No autorizado' })
    return
  }
  next()
}
