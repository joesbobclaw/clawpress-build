#!/bin/bash
# Start the ClawPress Build Relay (single instance)
cd "$(dirname "$0")"

PIDFILE=relay.pid

# Kill existing instance
if [ -f "$PIDFILE" ]; then
  OLD_PID=$(cat "$PIDFILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Killing old relay (PID $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null
    sleep 2
    kill -9 "$OLD_PID" 2>/dev/null
  fi
  rm -f "$PIDFILE"
fi

# Also kill any strays
pkill -f "node server.js" 2>/dev/null
sleep 1

# Load env (source to handle spaces in values)
set -a
source .env
set +a
nohup node server.js > relay.log 2>&1 &
echo $! > "$PIDFILE"
echo "ClawPress Build Relay started (PID $(cat $PIDFILE))"
sleep 2
tail -3 relay.log
