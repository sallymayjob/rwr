#!/usr/bin/env python3
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
manifest = json.loads((ROOT / 'slack-manifest.json').read_text())
code = (ROOT / 'Code.gs').read_text()
readme = (ROOT / 'README.md').read_text()
deployment = (ROOT / 'DEPLOYMENT.md').read_text()

manifest_commands = {c['command'] for c in manifest['features']['slash_commands']}
handler_commands = set(re.findall(r"case\s+'(/[^']+)'\s*:", code))

manifest_events = set(manifest['settings']['event_subscriptions']['bot_events'])
# routeEvent handles generic `message`; manifest splits channel types.
expected_events = {'app_mention', 'reaction_added'}
if re.search(r"case\s+'message'\s*:", code):
    expected_events.update({'message.channels', 'message.im'})

errors = []
missing_in_manifest = sorted(handler_commands - manifest_commands)
missing_handlers = sorted(manifest_commands - handler_commands)
if missing_in_manifest:
    errors.append('Commands implemented but missing in manifest: ' + ', '.join(missing_in_manifest))
if missing_handlers:
    errors.append('Commands in manifest but missing handlers: ' + ', '.join(missing_handlers))

if manifest_events != expected_events:
    errors.append(
        'Manifest events mismatch. manifest=' + ', '.join(sorted(manifest_events)) +
        ' expected=' + ', '.join(sorted(expected_events))
    )

syntax = '/submit <submit_code> <evidence>'
if syntax not in readme:
    errors.append('README missing required syntax example: ' + syntax)
if syntax not in deployment:
    errors.append('DEPLOYMENT missing required syntax example: ' + syntax)

if errors:
    print('PARITY CHECK: FAIL')
    for e in errors:
        print('- ' + e)
    raise SystemExit(1)

print('PARITY CHECK: PASS')
print('Commands:', len(manifest_commands), 'Events:', len(manifest_events))
