import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const previewProc = spawn('npx', ['vite', 'preview', '--port', '4173', '--strictPort'], { stdio: 'ignore', cwd: new URL('..', import.meta.url).pathname });
await new Promise((r) => setTimeout(r, 1500));

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (err) => errors.push(err.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

try {
	await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
	await page.waitForTimeout(1500);

	// open README.md from the explorer
	await page.getByText('README.md', { exact: true }).click();
	await page.waitForTimeout(1000);
	await page.screenshot({ path: process.argv[2] + '/opened.png' });

	// type a marker at the top of the editor and save
	await page.keyboard.press('Control+Home');
	await page.keyboard.type('PERSISTED-MARKER-42\n');
	await page.waitForTimeout(300);
	await page.screenshot({ path: process.argv[2] + '/edited.png' });
	await page.keyboard.press('Control+s');
	await page.waitForTimeout(800);

	// reload and re-open: contents must have persisted through IndexedDB
	await page.reload({ waitUntil: 'networkidle' });
	await page.waitForTimeout(1500);
	await page.getByText('README.md', { exact: true }).click();
	await page.waitForTimeout(1000);
	const hasMarker = await page.getByText('PERSISTED-MARKER-42').count();
	console.log(hasMarker > 0 ? 'PERSISTENCE OK' : 'PERSISTENCE FAILED');
	await page.screenshot({ path: process.argv[2] + '/reloaded.png' });

	// also open a second file to see tabs
	await page.getByText('src', { exact: true }).click();
	await page.waitForTimeout(500);
	await page.getByText('main.ts', { exact: true }).click();
	await page.waitForTimeout(800);
	await page.screenshot({ path: process.argv[2] + '/twotabs.png' });

	// search across files and open a match
	await page.locator('.mw-activitybar-item[title="Search"]').click();
	await page.waitForTimeout(300);
	await page.keyboard.type('greet');
	await page.waitForTimeout(800);
	await page.screenshot({ path: process.argv[2] + '/search.png' });
	const matches = page.locator('.mw-search-match');
	const matchCount = await matches.count();
	console.log(matchCount > 0 ? `SEARCH OK (${matchCount} match rows)` : 'SEARCH FAILED');
	if (matchCount > 0) {
		await matches.first().click();
		await page.waitForTimeout(600);
		await page.screenshot({ path: process.argv[2] + '/search-opened.png' });
	}

	// custom editors: CSV opens as a table by default
	await page.locator('.mw-activitybar-item[title="Explorer"]').click();
	await page.waitForTimeout(300);
	await page.getByText('data', { exact: true }).click();
	await page.waitForTimeout(500);
	await page.getByText('measurements.csv', { exact: true }).click();
	await page.waitForTimeout(800);
	const csvCells = await page.locator('.demo-csv-viewer td').count();
	console.log(csvCells > 10 ? `CSV VIEWER OK (${csvCells} cells)` : 'CSV VIEWER FAILED');
	await page.screenshot({ path: process.argv[2] + '/csv.png' });

	// ... with "reopen as text" available
	await page.locator('.mw-tab-action[title="Reopen as Text Editor"]').click();
	await page.waitForTimeout(600);
	const csvAsText = await page.getByText('voltage_mV', { exact: false }).count();
	console.log(csvAsText > 0 ? 'REOPEN AS TEXT OK' : 'REOPEN AS TEXT FAILED');

	// markdown preview via the tab-bar action (activate the existing tab)
	await page.locator('.mw-tab-label', { hasText: 'README.md' }).click();
	await page.waitForTimeout(400);
	await page.locator('.mw-tab-action[title="Open with Markdown Preview"]').click();
	await page.waitForTimeout(800);
	const mdHeadings = await page.locator('.demo-markdown-preview h1').count();
	console.log(mdHeadings > 0 ? 'MARKDOWN PREVIEW OK' : 'MARKDOWN PREVIEW FAILED');
	await page.screenshot({ path: process.argv[2] + '/markdown.png' });

	// image viewer (binary path)
	await page.getByText('assets', { exact: true }).click();
	await page.waitForTimeout(500);
	await page.getByText('banner.png', { exact: true }).click();
	await page.waitForTimeout(800);
	const imgOk = await page.locator('.demo-image-viewer img').evaluate((img) => img.complete && img.naturalWidth === 320).catch(() => false);
	console.log(imgOk ? 'IMAGE VIEWER OK' : 'IMAGE VIEWER FAILED');
	await page.screenshot({ path: process.argv[2] + '/image.png' });

	// run a JavaScript file: output goes to the Output panel view
	await page.getByText('scripts', { exact: true }).click();
	await page.waitForTimeout(500);
	await page.getByText('fibonacci.js', { exact: true }).click();
	await page.waitForTimeout(600);
	await page.locator('.mw-tab-action[title="Run JavaScript"]').click();
	await page.waitForTimeout(1200);
	// note: monaco virtualizes rendering (only visible lines appear in
	// innerText) and renders spaces as nbsp
	const outputText = (await page.locator('.mw-output').innerText()).replace(/ /g, ' ');
	const ranOk = outputText.includes('fib(10) = 55') && /\[(info|warning)\]/.test(outputText);
	console.log(ranOk ? 'RUNNER OK' : `RUNNER FAILED: ${JSON.stringify(outputText.slice(0, 200))}`);
	await page.screenshot({ path: process.argv[2] + '/runner.png' });

	// drive the terminal (reactivate its panel tab first)
	await page.locator('.mw-panel-tab', { hasText: 'Terminal' }).click();
	await page.waitForTimeout(300);
	await page.locator('.mw-terminal').click();
	await page.keyboard.type('ls');
	await page.keyboard.press('Enter');
	await page.waitForTimeout(300);
	await page.keyboard.type('cat data/config.json');
	await page.keyboard.press('Enter');
	await page.waitForTimeout(400);
	await page.screenshot({ path: process.argv[2] + '/terminal.png' });
	const termText = await page.locator('.mw-terminal').innerText();
	console.log(termText.includes('minwebide-demo') ? 'TERMINAL OK' : 'TERMINAL FAILED');

	if (errors.length) {
		console.log('errors:');
		for (const e of errors.slice(0, 10)) console.log('  ' + e);
	} else {
		console.log('no page errors');
	}
} finally {
	await browser.close();
	previewProc.kill();
}
