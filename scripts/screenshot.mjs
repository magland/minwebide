// Headless verification: serve the built app (or an already-running dev server),
// capture console output and a screenshot.
//
//   node scripts/screenshot.mjs <output.png> [url]
//
// With no url, runs `vite preview` on the dist/ build.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const out = process.argv[2] ?? 'screenshot.png';
let url = process.argv[3];
let previewProc;

if (!url) {
	previewProc = spawn('npx', ['vite', 'preview', '--port', '4173', '--strictPort'], {
		stdio: 'ignore',
	});
	url = 'http://localhost:4173/';
	await new Promise((r) => setTimeout(r, 1500));
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

const messages = [];
page.on('console', (msg) => messages.push(`[${msg.type()}] ${msg.text()}`));
page.on('pageerror', (err) => messages.push(`[pageerror] ${err.message}`));

try {
	await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
	await page.waitForTimeout(2500);
	await page.screenshot({ path: out });
	console.log(`screenshot: ${out}`);
	const interesting = messages.filter((m) => !m.startsWith('[log]') && !m.startsWith('[info]') && !m.startsWith('[debug]'));
	if (interesting.length) {
		console.log('console output:');
		for (const m of interesting.slice(0, 40)) console.log('  ' + m);
	} else {
		console.log('no console warnings/errors');
	}
} finally {
	await browser.close();
	previewProc?.kill();
}
