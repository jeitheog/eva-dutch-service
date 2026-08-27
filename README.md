# eva-dutch-service — Lingua 🎓 (el cerebro)

Profesor de holandés por Telegram. Este servicio es el **cerebro**: tarjetas
NL↔ES, motor SRS SM-2 (grades 0-5), memoria del alumno, registro de errores y
estadísticas. El bot de Telegram (eva-dutch-bot, puerto 3023) consume esta API.

## Stack

- Node 22+ (usa `node:sqlite`, sin dependencias de DB)
- Express + TypeScript, patrón eva-* (config.ts, api/, services/, tests/)
- SQLite en `data/dutch.sqlite` (tablas: cards, reviews_log, student,
  errors_log, stats_daily, audit_log)

## API (auth `x-dutch-service-api-key`)

| Endpoint | Descripción |
|---|---|
| `POST /api/v1/dutch/cards` | Crea tarjeta (sin duplicados → `{duplicate:true, existing_id}`) |
| `GET /api/v1/dutch/cards` | Lista `?status=&category=&limit=` |
| `GET /api/v1/dutch/review/queue?limit=10` | Vencidas para una sesión |
| `POST /api/v1/dutch/review` | `{card_id, grade 0-5, latency_ms}` → SRS + stats |
| `GET /api/v1/dutch/stats` | Resumen completo |
| `GET /api/v1/dutch/due/status` | `{pendientes_hoy, nuevas_disponibles, dificiles}` |
| `GET/POST /api/v1/dutch/student` | Memoria del alumno |
| `GET/POST /api/v1/dutch/errors` | Errores + patrones |
| `POST /api/v1/dutch/translate` | `{text, direction, add_card}` → LLM (api_server 8642) + tarjeta |

## SRS (SM-2)

- grade < 3 → lapse: `repetitions=0`, `lapses+1`, ease −0.2 (mín 1.3), due en 10 min
- grade ≥ 3 → éxito: ease con fórmula SM-2; intervalo 1d → 3d → 7d → 14d → 30d → ×ease
- Límite diario de tarjetas nuevas: 20 (config `DUTCH_DAILY_NEW_LIMIT`)

## Desarrollo

```bash
npm ci && npm run build
npm test          # node:test (sin red)
bash deploy/s6-register.sh   # registro s6 (puerto 3022)
```
