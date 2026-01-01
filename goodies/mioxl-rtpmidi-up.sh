#!/bin/bash

# Script de découverte et énumération automatique des MIO XL connectées au système


set -e

SOCK="/var/run/rtpmidid/control.sock"
MIO_HOST="MASAmioXL.local"
MIO_PORT="5004"          # 29A-01
RTP_CLIENT="128"
RTP_PORT="1"             # 128:1 = mioXL 29A-01
LOCAL_SRC="14:0"         # Midi Through (exemple)
LOCAL_DST="14:0"

# Déjà connecté ? on sort
if awk -v P="$RTP_PORT" -v SRC="$LOCAL_SRC" -v DST="$LOCAL_DST" '
/Client 128 : "rtpmidid"/ {inrtp=1}
inrtp && $0 ~ ("Port[ ]+" P " : \"mioXL 29A-01\"") {inport=1}
inport && $0 ~ ("Connected From: " SRC) {from=1}
inport && $0 ~ ("Connecting To: " DST) {to=1}
inport && $0 ~ /^  Port/ && $0 !~ ("^  Port[ ]+" P " :") {exit}
END{exit !(from && to)}
' /proc/asound/seq/clients; then
  exit 0
fi

# Si pas de MIO on sort
if ! avahi-resolve-host-name "$MIO_HOST" >/dev/null 2>&1; then
  echo "mioXL absente, on sort proprement"
  exit 0
fi


# Attendre que le socket de contrôle existe (rtpmidid prêt)
for i in {1..50}; do
  [[ -S "$SOCK" ]] && break
  sleep 0.2
done

[[ -S "$SOCK" ]] || { echo "rtpmidid pas prêt (socket absent)"; exit 0; }


# Attendre qu'on résolve le host (réseau prêt)
for i in {1..50}; do
  getent hosts "$MIO_HOST" >/dev/null && break
  sleep 0.2
done

getent hosts "$MIO_HOST" >/dev/null || { echo "mioXL non résolue"; exit 0; }

# Demander la connexion RTP-MIDI à la mioXL (port en STRING)
python3 - <<PY
import socket, json
sock_path="$SOCK"
req={"method":"connect","params":["$MIO_HOST","$MIO_PORT"],"id":1}
s=socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect(sock_path)
s.sendall((json.dumps(req)+"\n").encode())
print(s.recv(65536).decode())
PY

# Attendre que le port ALSA apparaisse (128:1)
for i in {1..50}; do
  if grep -q "Port *$RTP_PORT : \"mioXL 29A-01\"" /proc/asound/seq/clients; then
    break
  fi
  sleep 0.2
done

# Nettoyer d'éventuelles connexions existantes (évite les doublons)
aconnect -d "$LOCAL_SRC" "$RTP_CLIENT:$RTP_PORT" 2>/dev/null || true
aconnect -d "$RTP_CLIENT:$RTP_PORT" "$LOCAL_DST" 2>/dev/null || true

# Router MIDI (exemple)
aconnect "$LOCAL_SRC" "$RTP_CLIENT:$RTP_PORT"    # Pi -> mioXL
aconnect "$RTP_CLIENT:$RTP_PORT" "$LOCAL_DST"    # mioXL -> Pi (optionnel)
