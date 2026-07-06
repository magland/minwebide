// A small single-series line-plot renderer for the demo runner's plot() API.
// Everything is themed with the --vscode-* variables (including VS Code's own
// charts.* colors), so plots follow the active color theme.

export type PlotColor = 'blue' | 'orange' | 'green' | 'purple' | 'red' | 'yellow';

export interface PlotSpec {
	readonly y: number[];
	readonly x?: number[];
	readonly title?: string;
	readonly color?: PlotColor;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
	const el = document.createElementNS(SVG_NS, tag);
	for (const [key, value] of Object.entries(attrs)) {
		el.setAttribute(key, String(value));
	}
	return el;
}

function niceTicks(min: number, max: number, count = 4): number[] {
	const span = (max - min) || 1;
	const rough = span / count;
	const magnitude = 10 ** Math.floor(Math.log10(rough));
	const step = [1, 2, 5, 10].map(m => m * magnitude).find(s => span / s <= count) ?? magnitude * 10;
	const ticks: number[] = [];
	for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) {
		ticks.push(Number(v.toFixed(10)));
	}
	return ticks;
}

function fmt(value: number): string {
	if (Number.isInteger(value) && Math.abs(value) < 1e6) {
		return String(value);
	}
	return String(Number(value.toPrecision(4)));
}

/** Renders one plot card into the container and keeps it sized to fit. */
export function renderPlot(container: HTMLElement, spec: PlotSpec): void {
	const card = document.createElement('div');
	card.className = 'demo-plot';
	if (spec.title) {
		const title = document.createElement('div');
		title.className = 'demo-plot-title';
		title.textContent = spec.title;
		card.appendChild(title);
	}
	const plotArea = document.createElement('div');
	plotArea.className = 'demo-plot-area';
	card.appendChild(plotArea);
	container.appendChild(card);

	const draw = () => {
		plotArea.textContent = '';
		const width = Math.max(200, plotArea.clientWidth || 280);
		drawChart(plotArea, spec, width);
	};
	draw();
	let lastWidth = plotArea.clientWidth;
	const observer = new ResizeObserver(() => {
		if (plotArea.isConnected && plotArea.clientWidth !== lastWidth && plotArea.clientWidth > 0) {
			lastWidth = plotArea.clientWidth;
			requestAnimationFrame(draw);
		}
	});
	observer.observe(plotArea);
}

function drawChart(host: HTMLElement, spec: PlotSpec, width: number): void {
	const height = 200;
	const margin = { top: 8, right: 12, bottom: 26, left: 46 };
	const innerWidth = width - margin.left - margin.right;
	const innerHeight = height - margin.top - margin.bottom;
	const color = `var(--vscode-charts-${spec.color ?? 'blue'})`;

	const ys = spec.y;
	const xs = spec.x ?? ys.map((_, i) => i);
	const n = Math.min(xs.length, ys.length);
	if (n === 0) {
		return;
	}

	const xMin = Math.min(...xs), xMax = Math.max(...xs);
	let yMin = Math.min(...ys), yMax = Math.max(...ys);
	const yPad = (yMax - yMin || 1) * 0.05;
	yMin -= yPad;
	yMax += yPad;

	const px = (x: number) => margin.left + ((x - xMin) / (xMax - xMin || 1)) * innerWidth;
	const py = (y: number) => margin.top + (1 - (y - yMin) / (yMax - yMin || 1)) * innerHeight;

	const svg = svgEl('svg', { width, height });

	// recessive horizontal grid + y tick labels
	for (const tick of niceTicks(yMin, yMax)) {
		const y = py(tick);
		const grid = svgEl('line', { x1: margin.left, x2: width - margin.right, y1: y, y2: y });
		grid.style.stroke = 'var(--vscode-panel-border)';
		grid.style.opacity = '0.5';
		svg.appendChild(grid);
		const label = svgEl('text', { x: margin.left - 6, y: y + 3, 'text-anchor': 'end', 'font-size': 10 });
		label.style.fill = 'var(--vscode-descriptionForeground)';
		label.textContent = fmt(tick);
		svg.appendChild(label);
	}
	// x axis labels
	for (const tick of niceTicks(xMin, xMax, 5)) {
		const label = svgEl('text', { x: px(tick), y: height - margin.bottom + 14, 'text-anchor': 'middle', 'font-size': 10 });
		label.style.fill = 'var(--vscode-descriptionForeground)';
		label.textContent = fmt(tick);
		svg.appendChild(label);
	}
	const axis = svgEl('line', { x1: margin.left, x2: width - margin.right, y1: py(yMin) , y2: py(yMin) });
	axis.style.stroke = 'var(--vscode-panel-border)';
	svg.appendChild(axis);

	// the series: a thin 2px line
	const path = svgEl('path', {
		d: Array.from({ length: n }, (_, i) => `${i === 0 ? 'M' : 'L'}${px(xs[i]).toFixed(1)},${py(ys[i]).toFixed(1)}`).join(''),
		fill: 'none', 'stroke-width': 2, 'stroke-linejoin': 'round',
	});
	path.style.stroke = color;
	svg.appendChild(path);

	// hover layer: crosshair + ringed marker + tooltip on nearest point
	const crosshair = svgEl('line', { y1: margin.top, y2: height - margin.bottom, 'stroke-width': 1 });
	crosshair.style.stroke = 'var(--vscode-panel-border)';
	crosshair.style.display = 'none';
	svg.appendChild(crosshair);
	const marker = svgEl('circle', { r: 4, 'stroke-width': 2 });
	marker.style.fill = color;
	marker.style.stroke = 'var(--vscode-sideBar-background)';
	marker.style.display = 'none';
	svg.appendChild(marker);
	const tooltip = document.createElement('div');
	tooltip.className = 'demo-plot-tooltip';
	tooltip.style.display = 'none';
	host.appendChild(tooltip);

	svg.addEventListener('pointermove', (e) => {
		const rect = svg.getBoundingClientRect();
		const mouseX = e.clientX - rect.left;
		let best = 0;
		for (let i = 1; i < n; i++) {
			if (Math.abs(px(xs[i]) - mouseX) < Math.abs(px(xs[best]) - mouseX)) {
				best = i;
			}
		}
		const cx = px(xs[best]), cy = py(ys[best]);
		crosshair.setAttribute('x1', String(cx));
		crosshair.setAttribute('x2', String(cx));
		crosshair.style.display = '';
		marker.setAttribute('cx', String(cx));
		marker.setAttribute('cy', String(cy));
		marker.style.display = '';
		tooltip.textContent = `${fmt(xs[best])}, ${fmt(ys[best])}`;
		tooltip.style.display = '';
		tooltip.style.left = `${Math.min(cx + 8, width - 90)}px`;
		tooltip.style.top = `${Math.max(cy - 26, 2)}px`;
	});
	svg.addEventListener('pointerleave', () => {
		crosshair.style.display = 'none';
		marker.style.display = 'none';
		tooltip.style.display = 'none';
	});

	host.appendChild(svg);
}
