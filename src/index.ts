import express from 'express'
import { config, requireApiKey } from './config'
import { openDb } from './db'
import { dutchRouter } from './api/dutch'
import { audioRouter } from './api/audio'

const db = openDb(config.dbPath)

const app = express()
app.use(express.json({ limit: '1mb' }))

app.get('/health', (_req, res) => res.json({ ok: true, service: 'eva-dutch-service' }))

app.use('/api/v1', requireApiKey)
app.use('/api/v1/dutch', dutchRouter(db))
app.use('/api/v1/dutch', audioRouter(db))

app.listen(config.port, '127.0.0.1', () => {
  console.log(`eva-dutch-service escuchando en http://127.0.0.1:${config.port} (db: ${config.dbPath})`)
})
