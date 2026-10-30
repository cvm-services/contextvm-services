#!/bin/bash
# The session API spawns this. It must keep the serve.ts CLI contract
# (--hold --no-password --public-base --session-id --out) and add the VNC
# handoff, card source, and the OpenBao-materialized venue phone.
set -euo pipefail
exec /home/c08r4d0r/.cache/pw-venv/bin/python \
  /home/c08r4d0r/repos/contextvm-services/services/restaurant-cvm/tools/venue_phone_test.py \
  --vnc --card-source "${CVM_CARD_SOURCE:-synthetic}" \
  --phone "${CVM_PHONE:-}" \
  --phone-country "${CVM_PHONE_COUNTRY:-US}" \
  --phone-mode "${CVM_PHONE_MODE:-jmp}" \
  "$@"
