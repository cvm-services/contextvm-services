#!/usr/bin/env python3
"""One isolated rehearsal on testserver2. Never autofill or send card-ready.

Read the demo token from OpenBao on this host (never a command argument), create
one disposable noVNC session, wait for awaiting_card, then cancel it and stop
its browser. Only the card form is captured: no venue submission is made.
"""
from __future__ import annotations

import argparse
import json
import os
import secrets
import signal
import subprocess
import time
import urllib.request
from pathlib import Path

HOME = Path.home()
ORDER_PREFIX = "o_smoke_rehearsal"


def secret() -> str:
    return subprocess.check_output([
        str(HOME/'.hermes/scripts/fleet_secret.py'), 'get',
        'cvm-smoke-session', '--field', 'session_token'], text=True).strip()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--order-id', default=f'{ORDER_PREFIX}_{secrets.token_hex(6)}')
    args = ap.parse_args()
    token = secret()
    repo = HOME/'cvm-smoke/contextvm-services'
    subprocess.run(['git','-C',str(repo),'pull','--ff-only','--quiet'], check=True)
    create = subprocess.run([
        'curl','-fsS','-m','40','-X','POST','http://127.0.0.1:8792/sessions',
        '-H',f'authorization: Bearer {token}','-H','content-type: application/json',
        '--data',json.dumps({'order_id': args.order_id})],
        capture_output=True, text=True, check=True)
    rec = json.loads(create.stdout)
    sid = rec['session_id']
    url = rec['novnc_url']
    print('session', sid, rec['state'])
    print('VNC', url)
    state_file = Path(f'/tmp/cvm-state-{sid}.json')
    state = None
    for _ in range(90):
        time.sleep(3)
        if state_file.exists():
            state = json.loads(state_file.read_text())['state']
            if state in ('awaiting_card', 'failed', 'expired', 'completed'):
                break
    if state != 'awaiting_card':
        subprocess.run(['journalctl','--user','-u','cvm-smoke-session-api.service',
                        '--since','6 min ago','--no-pager'], check=False)
        raise SystemExit(f'rehearsal did not reach awaiting_card: {state}')
    print('state', state)

    def health() -> int:
        tok = url.split('/venue/view/')[1].split('/')[0]
        try:
            with urllib.request.urlopen(
                    f'https://cvm-pwa.orangesync.tech/venue/view/{tok}/health', timeout=10) as r:
                return r.status
        except Exception as exc:
            return getattr(exc,'code',0)
    print('health before', health())
    subprocess.run(['cp','/tmp/vt-card-pause.png', str(HOME/'cvm-smoke/card-pause.png')],
                   check=False)
    cancel = subprocess.run([
        'curl','-fsS','-X','POST',f'http://127.0.0.1:8792/sessions/{sid}/cancel',
        '-H',f'authorization: Bearer {token}','-H','content-type: application/json',
        '-d','{}'], capture_output=True, text=True)
    print('cancel', cancel.returncode)
    for line in subprocess.run(['pgrep','-af','venue_phone_test.py'],
                               capture_output=True, text=True).stdout.splitlines():
        if sid in line:
            pid = int(line.split(' ',1)[0])
            try: os.kill(pid, signal.SIGINT)
            except ProcessLookupError: pass
    time.sleep(4)
    print('health after', health())
    print('evidence', HOME/'cvm-smoke/card-pause.png')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
