#!/usr/bin/env python3
from __future__ import annotations
import json
import shlex
import subprocess
from pathlib import Path

HOME = Path.home()
ROOT = HOME / "cvm-smoke"
REPO = ROOT / "contextvm-services"
REST = REPO / "services/restaurant-cvm"

def fleet(name: str, field: str) -> str:
    r = subprocess.run([str(HOME/'.hermes/scripts/fleet_secret.py'), 'get', name, '--field', field],
                       capture_output=True, text=True, check=False)
    if r.returncode:
        raise RuntimeError(f'cannot read field {field} for {name}; no values exposed')
    return r.stdout.strip()

session_token = fleet('cvm-smoke-session', 'session_token')
phone = fleet('venue-phone', 'phone')
country = fleet('venue-phone', 'country') or 'DE'
mode = fleet('venue-phone', 'mode') or 'manual'

env = {
 'CVM_SESSION_BIND': 'fdfd:c0e5:3717:6cb1:bb60:de97:987e:7149',
 'CVM_SESSION_API_PORT': '8792',
 'CVM_SESSION_STORE': '/var/lib/cvm-smoke/sessions.json',
 'CVM_PUBLIC_BASE': 'https://cvm-pwa.orangesync.tech',
 'CVM_LAUNCHER': str(REST/'deploy/x280/run-venue-launcher.sh'),
 'CVM_HOLD_SECONDS': '900',
 'CVM_VNC_BIND': '127.0.0.1',
 'CVM_VNC_DIR': '/tmp/cvm-smoke-handoff',
 'CVM_CARD_SOURCE': 'manual',
 'CVM_PHONE_AUTO': '0',
 'CVM_PHONE': phone,
 'CVM_PHONE_COUNTRY': country,
 'CVM_PHONE_MODE': mode,
 'CVM_FACILITATOR_TOKENS': json.dumps({session_token: 'lnurlp-smoke'}),
 'CVM_PYTHON': str(ROOT/'pw-venv/bin/python'),
 'CVM_ROOT': str(REPO),
}
unit_env = ROOT/'session-api.env'
unit_env.write_text('\n'.join(f'{k}={shlex.quote(v)}' for k, v in env.items()) + '\n')
unit_env.chmod(0o600)

gw_env = ROOT/'handoff-gateway.env'
gw_env.write_text('\n'.join([
 'GATEWAY_BIND=127.0.0.1',
 'GATEWAY_PORT=8098',
 'GATEWAY_PREFIX=/venue/view/',
 'GATEWAY_HANDOFF=/tmp/cvm-smoke-handoff/handoff.json',
 'GATEWAY_NOVNC=/usr/share/novnc',
]) + '\n', encoding='utf-8')
gw_env.chmod(0o600)

units = HOME/'.config/systemd/user'
units.mkdir(parents=True, exist_ok=True)
(units/'cvm-smoke-session-api.service').write_text(f'''[Unit]
Description=CVM smoke venue session API (isolated testserver2)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory={REST}
EnvironmentFile={unit_env}
ExecStart=/usr/local/bin/deno run --allow-net --allow-env --allow-run --allow-read src/serve.ts
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
MemoryMax=2G
TasksMax=256

[Install]
WantedBy=default.target
''')
(units/'cvm-smoke-handoff.service').write_text(f'''[Unit]
Description=CVM smoke captcha noVNC gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory={REST}
EnvironmentFile={gw_env}
ExecStart=/usr/bin/python3 {REST}/tools/handoff_gateway.py
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
MemoryMax=256M

[Install]
WantedBy=default.target
''')
print('smoke env and units written (secret values not printed)')
subprocess.run(['systemctl','--user','daemon-reload'], check=True)
for unit in ('cvm-smoke-handoff.service', 'cvm-smoke-session-api.service'):
    subprocess.run(['systemctl','--user','enable','--now',unit], check=True)
    subprocess.run(['systemctl','--user','restart',unit], check=True)
