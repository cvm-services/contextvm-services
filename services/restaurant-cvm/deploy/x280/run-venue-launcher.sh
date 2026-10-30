#!/bin/bash
# The session API spawns this. It must keep the serve.ts CLI contract
# (--hold --no-password --public-base --session-id --out) and add the VNC
# handoff, card source, and the OpenBao-materialized venue phone.
#
# The phone is NOT passed as an argument: argv is world-readable in /proc, so a
# --phone flag would publish the number to every local user. The launcher reads
# CVM_PHONE / CVM_PHONE_COUNTRY / CVM_PHONE_MODE from the inherited service
# environment (0600 EnvironmentFile, materialized by install-session-api.sh).
set -euo pipefail
exec /home/c08r4d0r/.cache/pw-venv/bin/python \
  /home/c08r4d0r/repos/contextvm-services/services/restaurant-cvm/tools/venue_phone_test.py \
  --vnc --card-source "${CVM_CARD_SOURCE:-synthetic}" \
  "$@"
