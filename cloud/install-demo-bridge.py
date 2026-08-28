from pathlib import Path

runner = Path('/home/sanisol255/sani-cloud/runner.js')
if not runner.exists():
    raise SystemExit('runner.js not found')
s = runner.read_text()

if "DemoExecutionBridge" not in s:
    marker = "const { chromium } = require('playwright');\n"
    if marker not in s:
        raise SystemExit('Could not find Playwright import in runner.js')
    s = s.replace(marker, marker + "const { DemoExecutionBridge } = require('./demo-execution');\n", 1)

if "DEMO LIVE BRIDGE START" not in s:
    marker = "  await prepareComet(comet);\n  await prepareLastMan(lastMan);\n"
    if marker not in s:
        raise SystemExit('Could not find COMET/LAST MAN prepare block')
    addition = marker + "\n  // DEMO LIVE BRIDGE START\n  const demoBridge = new DemoExecutionBridge({\n    cometPage: comet,\n    lastManPage: lastMan,\n    credsPath: '/home/sanisol255/sani-cloud/deriv-demo.json',\n    symbol: '1HZ25V',\n    multiplier: 10\n  });\n  await demoBridge.start();\n  // DEMO LIVE BRIDGE END\n"
    s = s.replace(marker, addition, 1)

runner.write_text(s)
print('✅ runner.js patched for Deriv DEMO execution.')
print('✅ LAST MAN is forced to GRAB-only by the bridge.')
print('✅ COMET remains unchanged; bridge mirrors its paper entries/exits into Demo multipliers.')
