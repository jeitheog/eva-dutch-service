#!/usr/bin/env bash
# ── Registro del servicio s6 de eva-dutch-service ───────────────────────────
# Crea (o recrea) el servicedir en /run/service y lo deja listo para que
# s6-svscan lo recoja. Idempotente. Patrón idéntico a eva-youtube-bot.
#
# Uso:  bash /opt/data/eva-dutch-service/deploy/s6-register.sh
set -euo pipefail

APP_DIR="${1:-/opt/data/eva-dutch-service}"
SVC=/run/service/eva-dutch-service

if [ ! -d "$APP_DIR/dist" ]; then
  echo "✗ No existe $APP_DIR/dist — ejecuta primero: cd $APP_DIR && npm ci && npm run build"
  exit 1
fi
if [ ! -f "$APP_DIR/.env" ]; then
  echo "✗ No existe $APP_DIR/.env — copia .env.example y rellena las credenciales."
  exit 1
fi

echo "── Creando servicedir $SVC"
rm -rf "$SVC"
mkdir -p "$SVC/log"
printf 'longrun\n' > "$SVC/type"

cat > "$SVC/run" <<'EOF'
#!/command/with-contenv sh
# shellcheck shell=sh
# eva-dutch-service — Lingua (cerebro SRS, puerto 3022).
set -e
export HOME=/opt/data
cd /opt/data/eva-dutch-service
[ "$(id -u)" = 0 ] || exec /usr/local/bin/node --env-file=.env dist/index.js
exec s6-setuidgid hermes /usr/local/bin/node --env-file=.env dist/index.js
EOF

cat > "$SVC/finish" <<'EOF'
#!/command/with-contenv sh
# shellcheck shell=sh
# $1 = exit code from the run script.
# Semántica "restart: unless-stopped": cualquier salida reinicia el servicio.
if [ "$1" = "125" ]; then
  exit 125
fi
exit 0
EOF

cat > "$SVC/log/run" <<'EOF'
#!/command/with-contenv sh
# shellcheck shell=sh
log_dir="/opt/data/eva-dutch-service/logs"
if [ "$(id -u)" = 0 ]; then
  s6-setuidgid hermes mkdir -p "$log_dir"
  s6-setuidgid hermes rm -f "$log_dir/lock"
else
  mkdir -p "$log_dir"
  rm -f "$log_dir/lock"
fi
[ "$(id -u)" = 0 ] || exec s6-log 1 n10 s1000000 T "$log_dir"
exec s6-setuidgid hermes s6-log 1 n10 s1000000 T "$log_dir"
EOF

chmod +x "$SVC/run" "$SVC/finish" "$SVC/log/run"

mkdir -p "$SVC/supervise" "$SVC/log/supervise" "$SVC/event" "$SVC/log/event"
[ -p "$SVC/supervise/control" ] || mkfifo "$SVC/supervise/control"
[ -p "$SVC/log/supervise/control" ] || mkfifo "$SVC/log/supervise/control"
chmod 0710 "$SVC/supervise" "$SVC/log/supervise"
chmod 0660 "$SVC/supervise/control" "$SVC/log/supervise/control"
chmod 03730 "$SVC/event" "$SVC/log/event"
mkdir -p "$APP_DIR/logs"

echo "── Forzando rescan de s6-svscan"
S6=/package/admin/s6/command
"$S6/s6-svscanctl" -a /run/service 2>/dev/null || sleep 6
sleep 2

echo "── Estado"
"$S6/s6-svstat" "$SVC" || true
echo
echo "✅ Servicio registrado. Verifica:"
echo "   curl http://127.0.0.1:3022/health"
echo "   tail -f $APP_DIR/logs/current"
