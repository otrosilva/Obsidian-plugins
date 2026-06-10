/*
 * Reporte Finanzas — Plugin para Obsidian
 *
 * Activación: propiedad YAML  reporte: true  (o 1, verdadero, yes, si)
 *
 * Moneda principal/secundaria (opcional):
 *   moneda: RUB, USD   → principal rublos, secundaria dólares  (por defecto)
 *   moneda: USD, RUB   → principal dólares, secundaria rublos
 *   moneda: EUR, USD   → principal euros, secundaria dólares
 *   (cualquier combinación de RUB, USD, EUR)
 *
 * Tipos de cambio opcionales en YAML:
 *   RUBUSD: 90    (₽ por 1 USD,  por defecto 90)
 *   RUBEUR: 95    (₽ por 1 EUR,  por defecto 95)
 *   EURUSD: 1.05  (EUR por 1 USD, por defecto 1.05)
 *   Si defines RUBEUR + EURUSD se calcula RUBUSD automáticamente.
 *
 * El reporte se escribe ENCIMA del separador "----".
 * Los datos van DEBAJO del separador "----".
 * Se actualiza al dejar de escribir (500ms) y al cambiar el frontmatter.
 */

'use strict';

const { Plugin, MarkdownView } = require('obsidian');

// ═══════════════════════════════════════════════════════════════
// TIPOS DE CAMBIO
// ═══════════════════════════════════════════════════════════════

const DEFAULTS = {
	RUBUSD: 90,   // ₽ por 1 USD
	RUBEUR: 95,   // ₽ por 1 EUR
	EURUSD: 1.05, // EUR por 1 USD
};

function getRates(fm) {
	// Devuelve objeto { rubusd, rubeur, eurusd } todos como float
	const rubusd = fm?.RUBUSD ? Number(fm.RUBUSD) : null;
	const rubeur = fm?.RUBEUR ? Number(fm.RUBEUR) : null;
	const eurusd = fm?.EURUSD ? Number(fm.EURUSD) : null;

	// Calcular los que falten con los que tengamos
	let _rubusd = rubusd || DEFAULTS.RUBUSD;
	let _rubeur = rubeur || DEFAULTS.RUBEUR;
	let _eurusd = eurusd || DEFAULTS.EURUSD;

	if (rubeur && eurusd && !rubusd) _rubusd = rubeur / eurusd;
	if (rubusd && eurusd && !rubeur) _rubeur = rubusd * eurusd;
	if (rubusd && rubeur && !eurusd) _eurusd = rubeur / rubusd;

	return { rubusd: _rubusd, rubeur: _rubeur, eurusd: _eurusd };
}

// Convierte cualquier cantidad a la moneda destino
function convert(amount, fromCur, toCur, rates) {
	if (fromCur === toCur) return amount;
	// Primero convertir a RUB, luego a destino
	let inRub = amount;
	if (fromCur === 'USD') inRub = amount * rates.rubusd;
	if (fromCur === 'EUR') inRub = amount * rates.rubeur;
	if (toCur === 'RUB') return inRub;
	if (toCur === 'USD') return inRub / rates.rubusd;
	if (toCur === 'EUR') return inRub / rates.rubeur;
	return amount;
}

// ═══════════════════════════════════════════════════════════════
// MONEDA PRINCIPAL / SECUNDARIA
// ═══════════════════════════════════════════════════════════════

const CURRENCY_SYMBOL = { RUB: '₽', USD: '$', EUR: '€' };
const CURRENCY_NAMES  = { RUB: 'RUB', USD: 'USD', EUR: 'EUR' };

function parseCurrency(fm) {
	// Devuelve { primary, secondary }
	// Por defecto: primary=RUB, secondary=USD
	const raw = fm?.moneda || fm?.currency || '';
	const parts = String(raw).toUpperCase().split(/[\s,;\/]+/).map(s => s.trim()).filter(Boolean);
	const valid = ['RUB', 'USD', 'EUR'];
	const primary   = valid.includes(parts[0]) ? parts[0] : 'RUB';
	const secondary = valid.includes(parts[1]) && parts[1] !== primary ? parts[1] : (primary === 'RUB' ? 'USD' : 'RUB');
	return { primary, secondary };
}

function fmtCurrency(amount, currency) {
	const sym = CURRENCY_SYMBOL[currency] || currency;
	const rounded = Math.round(amount).toLocaleString('es-RU');
	return currency === 'USD' ? `$${rounded}` : `${rounded} ${sym}`;
}

// ═══════════════════════════════════════════════════════════════
// PARSEO CSV
// ═══════════════════════════════════════════════════════════════

function parseCSVLine(line) {
	const fields = [];
	let cur = '', inQ = false;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (c === '"') { inQ = !inQ; continue; }
		if (c === ',' && !inQ) { fields.push(cur); cur = ''; continue; }
		cur += c;
	}
	fields.push(cur);
	return fields;
}

function parseAmount(str) {
	// Devuelve { rub, usd, eur } como números positivos
	if (!str || str === '0') return { rub: 0, usd: 0, eur: 0 };
	let rub = 0, usd = 0, eur = 0;
	for (const part of str.split(',').map(s => s.trim())) {
		const m = part.match(/([-\d.]+)\s*(RUB|USD|EUR)/);
		if (!m) continue;
		const v = Math.abs(parseFloat(m[1]));
		if (m[2] === 'RUB') rub += v;
		else if (m[2] === 'USD') usd += v;
		else if (m[2] === 'EUR') eur += v;
	}
	return { rub, usd, eur };
}

function parseSection(block) {
	const rows = [];
	let hasHeader = false;
	for (const rawLine of block.split('\n')) {
		const line = rawLine.trim();
		if (!line || line.startsWith('━') || line === 'expenses' || line === 'income') continue;
		const fields = parseCSVLine(line);
		if (fields[0] === 'txnidx') { hasHeader = true; continue; }
		if (!hasHeader || fields.length < 6) continue;
		rows.push({
			date:        fields[1],
			description: fields[3],
			account:     fields[4],
			amount:      fields[5],
		});
	}
	return rows;
}

function extractSections(dataBlock) {
	const re = /━{10,}[\s\S]*?\n\s*(\w+)\s*\n[\s\S]*?━{10,}/g;
	const sections = {};
	const positions = [];
	let m;
	while ((m = re.exec(dataBlock)) !== null) {
		positions.push({ name: m[1], end: m.index + m[0].length });
	}
	for (let i = 0; i < positions.length; i++) {
		const { name, end } = positions[i];
		const nextBlockStart = i + 1 < positions.length
			? dataBlock.indexOf('━━━', end + 1)
			: dataBlock.length;
		sections[name] = parseSection(dataBlock.slice(end, nextBlockStart === -1 ? dataBlock.length : nextBlockStart));
	}
	return sections;
}

// ═══════════════════════════════════════════════════════════════
// AGRUPACIÓN TEMPORAL
// ═══════════════════════════════════════════════════════════════

function groupByMonth(rows) {
	const acc = {};
	for (const r of rows) {
		if (!r.date || r.date.length < 7) continue;
		const key = r.date.slice(0, 7);
		if (!acc[key]) acc[key] = [];
		acc[key].push(r);
	}
	return acc;
}

function groupByWeek(rows) {
	const acc = {};
	for (const r of rows) {
		if (!r.date) continue;
		const d = new Date(r.date + 'T00:00:00');
		if (isNaN(d)) continue;
		const dow = d.getDay() === 0 ? 7 : d.getDay();
		const mon = new Date(d);
		mon.setDate(d.getDate() - dow + 1);
		const key = mon.toISOString().slice(0, 10);
		if (!acc[key]) acc[key] = [];
		acc[key].push(r);
	}
	return acc;
}

// Suma filas y convierte todo a la moneda destino
function sumRowsIn(rows, toCur, rates) {
	let total = 0;
	for (const r of rows) {
		const a = parseAmount(r.amount);
		total += convert(a.rub, 'RUB', toCur, rates);
		total += convert(a.usd, 'USD', toCur, rates);
		total += convert(a.eur, 'EUR', toCur, rates);
	}
	return total;
}

function sumByCategory(rows, toCur, rates) {
	const acc = {};
	for (const r of rows) {
		const cat = r.account.replace(/^expenses:/, '');
		if (!acc[cat]) acc[cat] = 0;
		const a = parseAmount(r.amount);
		acc[cat] += convert(a.rub, 'RUB', toCur, rates);
		acc[cat] += convert(a.usd, 'USD', toCur, rates);
		acc[cat] += convert(a.eur, 'EUR', toCur, rates);
	}
	return acc;
}

// ═══════════════════════════════════════════════════════════════
// FORMATO
// ═══════════════════════════════════════════════════════════════

const MONTH_ES = {
	'01': 'Enero', '02': 'Febrero', '03': 'Marzo',    '04': 'Abril',
	'05': 'Mayo',  '06': 'Junio',   '07': 'Julio',    '08': 'Agosto',
	'09': 'Sep',   '10': 'Oct',     '11': 'Nov',       '12': 'Dic',
};

function monthLabel(key) {
	return MONTH_ES[key.slice(5, 7)] || key;
}

function weekLabel(isoMonday) {
	const d = new Date(isoMonday + 'T00:00:00');
	const end = new Date(d);
	end.setDate(d.getDate() + 6);
	const p = (dt) => `${dt.getDate()}/${dt.getMonth() + 1}`;
	return `${p(d)}–${p(end)}`;
}

function bar(value, max, width) {
	width = width || 24;
	if (max <= 0) return '░'.repeat(width);
	const filled = Math.min(width, Math.round((value / max) * width));
	return '█'.repeat(filled) + '░'.repeat(width - filled);
}

// ═══════════════════════════════════════════════════════════════
// GENERACIÓN DEL REPORTE
// ═══════════════════════════════════════════════════════════════

function generateReport(sections, rates, currencies) {
	const { primary, secondary } = currencies;
	const symP = CURRENCY_SYMBOL[primary];
	const symS = CURRENCY_SYMBOL[secondary];

	const expRows = sections.expenses || [];
	const incRows = sections.income   || [];

	const expByMonth = groupByMonth(expRows);
	const incByMonth = groupByMonth(incRows);
	const months = [...new Set([
		...Object.keys(expByMonth),
		...Object.keys(incByMonth),
	])].sort();

	const multiMonth = months.length > 1;

	// ── Totales por mes ─────────────────────────────────────────
	const monthData = months.map(m => {
		const expP = sumRowsIn(expByMonth[m] || [], primary,   rates);
		const expS = sumRowsIn(expByMonth[m] || [], secondary, rates);
		const incP = sumRowsIn(incByMonth[m] || [], primary,   rates);
		const incS = sumRowsIn(incByMonth[m] || [], secondary, rates);
		return { key: m, label: monthLabel(m), expP, expS, incP, incS };
	});

	const maxExpP = Math.max(...monthData.map(m => m.expP), 1);
	const maxIncP = Math.max(...monthData.map(m => m.incP), 1);

	// ── Tabla comparativa ────────────────────────────────────────
	let comp = '';
	const BAR_W = 26;
	comp += `${'Mes'.padEnd(12)}${'Gasto'.padEnd(BAR_W + 2)}Ingreso\n`;
	comp += '─'.repeat(72) + '\n';

	for (const m of monthData) {
		const expBar = bar(m.expP, maxExpP, BAR_W);
		const incBar = bar(m.incP, maxIncP, BAR_W);

		// Línea 1: barras
		comp += `${m.label.padEnd(12)}${expBar}  ${incBar}\n`;

		// Línea 2: moneda principal
		const expPStr = `gasto: ${fmtCurrency(m.expP, primary)}`;
		const incPStr = m.incP > 0 ? `ingreso: ${fmtCurrency(m.incP, primary)}` : '';
		comp += ' '.repeat(12) + expPStr.padEnd(BAR_W + 2);
		if (incPStr) comp += incPStr;
		comp += '\n';

		// Línea 3: moneda secundaria (alineada bajo la principal)
		if (primary !== secondary) {
			const expSStr = fmtCurrency(m.expS, secondary);
			const incSStr = m.incS > 0 ? fmtCurrency(m.incS, secondary) : '';
			comp += ' '.repeat(12) + expSStr.padEnd(BAR_W + 2);
			if (incSStr) comp += incSStr;
			comp += '\n';
		}
		comp += '\n';
	}

	// ── Tabla de gastos por categoría ────────────────────────────
	const CAT_W = 24;

	function buildCatTable(rows, label) {
		const catsP  = sumByCategory(rows, primary,   rates);
		const catsS  = sumByCategory(rows, secondary, rates);
		const sorted = Object.entries(catsP).sort((a, b) => b[1] - a[1]);
		if (sorted.length === 0) return '';
		const maxCat = sorted[0][1];
		let t = label ? `── ${label} ──\n` : '';
		for (const [cat, total] of sorted) {
			const b    = bar(total, maxCat, CAT_W);
			const totalS = catsS[cat] || 0;
			const secStr = primary !== secondary && totalS > 0 ? ` / ${fmtCurrency(totalS, secondary)}` : '';
			t += `[${b}] ${cat} (${fmtCurrency(total, primary)}${secStr})\n`;
		}
		return t + '\n';
	}

	let catSection = '';
	if (multiMonth) {
		for (const m of months) {
			const rows = expByMonth[m] || [];
			if (rows.length === 0) continue;
			catSection += buildCatTable(rows, monthLabel(m));
		}
	} else {
		const byWeek  = groupByWeek(expRows);
		const weekKeys = Object.keys(byWeek).sort();
		for (const wk of weekKeys) {
			catSection += buildCatTable(byWeek[wk], `Semana ${weekLabel(wk)}`);
		}
	}

	// ── Observación ──────────────────────────────────────────────
	const totalExpP = sumRowsIn(expRows, primary,   rates);
	const totalIncP = sumRowsIn(incRows, primary,   rates);
	const totalIncS = sumRowsIn(incRows, secondary, rates);
	const balance   = totalIncP - totalExpP;
	const balSign   = balance >= 0 ? '+' : '';

	const periodStr = multiMonth
		? `${monthLabel(months[0])}–${monthLabel(months[months.length - 1])}`
		: monthLabel(months[0] || '');

	// Mostrar los tipos de cambio usados
	let rateStr = '';
	if (primary === 'RUB' || secondary === 'RUB') {
		if (primary === 'USD' || secondary === 'USD') rateStr += ` · 1 USD = ${Math.round(rates.rubusd)} ₽`;
		if (primary === 'EUR' || secondary === 'EUR') rateStr += ` · 1 EUR = ${Math.round(rates.rubeur)} ₽`;
	} else if ((primary === 'USD' && secondary === 'EUR') || (primary === 'EUR' && secondary === 'USD')) {
		rateStr += ` · 1 USD = ${rates.eurusd.toFixed(2)} EUR`;
	}

	let obs = `> 💡 **Período:** ${periodStr}${rateStr} · `;
	obs += `Gasto: **${fmtCurrency(totalExpP, primary)}** · `;
	if (totalIncP > 0) {
		obs += `Ingreso: **${fmtCurrency(totalIncP, primary)}**`;
		if (secondary !== primary && totalIncS > 0) {
			obs += ` (≈ ${fmtCurrency(totalIncS, secondary)})`;
		}
		obs += ` · `;
	}
	obs += `Balance: **${balSign}${fmtCurrency(balance, primary)}**`;

	return { comp, catSection, obs };
}

// ═══════════════════════════════════════════════════════════════
// PLUGIN
// ═══════════════════════════════════════════════════════════════

class ReporteFinanzasPlugin extends Plugin {

	onload() {
		this._debounce = null;

		// Actualizar cuando cambia el contenido del editor
		this.registerEvent(
			this.app.workspace.on('editor-change', (editor, view) => {
				if (!view || !view.file) return;
				clearTimeout(this._debounce);
				this._debounce = setTimeout(() => this._tryRender(view), 500);
			})
		);

		// Actualizar al abrir una nota
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', () => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (view) setTimeout(() => this._tryRender(view), 300);
			})
		);

		// Al cargar el plugin, renderizar la nota activa
		this.app.workspace.onLayoutReady(() => {
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (view) this._tryRender(view);
		});

		// Actualizar cuando cambia el frontmatter (reporte, RUBUSD, moneda, etc.)
		this.registerEvent(
			this.app.metadataCache.on('changed', (file) => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view || !view.file) return;
				if (view.file.path !== file.path) return;
				clearTimeout(this._debounce);
				this._debounce = setTimeout(() => this._tryRender(view, true), 300);
			})
		);

		console.log('[Reporte Finanzas] Plugin cargado');
	}

	static _isActive(val) {
		if (val === true || val === 1) return true;
		if (typeof val === 'string') {
			const v = val.trim().toLowerCase();
			return v === '1' || v === 'true' || v === 'verdadero' || v === 'yes' || v === 'si' || v === 'sí';
		}
		return false;
	}

	onunload() {
		clearTimeout(this._debounce);
		console.log('[Reporte Finanzas] Plugin descargado');
	}

	// force=true → recalcula siempre (cambio de frontmatter)
	// force=false → solo genera si no hay reporte de datos previo
	_tryRender(view, force = false) {
		if (!view || !view.file) return;

		const cache = this.app.metadataCache.getFileCache(view.file);
		const fm    = cache?.frontmatter;
		if (!fm) return;
		if (!ReporteFinanzasPlugin._isActive(fm.reporte)) return;

		const editor  = view.editor;
		const content = editor.getValue();

		// Separador: línea que contiene solo "----"
		const sepMatch = content.match(/^----\s*$/m);
		if (!sepMatch) return;

		const sepIndex  = content.indexOf(sepMatch[0]);
		const dataBlock = content.slice(sepIndex + sepMatch[0].length).trim();

		if (!dataBlock) return;

		const START     = '<!-- reporte-finanzas:inicio -->';
		const END       = '<!-- reporte-finanzas:fin -->';
		const HELP_MARK = '> **Reporte Finanzas \u2014 uso r\u00e1pido**';
		const aboveSep  = content.slice(0, sepIndex);
		const hasBlock  = aboveSep.includes(START);
		const hasHelp   = hasBlock && aboveSep.includes(HELP_MARK);

		// ── AYUDA / HELP ────────────────────────────────────────────
		if (dataBlock.match(/^#\s+(AYUDA|HELP)\b/im)) {
			// Solo insertar/actualizar la ayuda si no hay ya un reporte de datos
			if (hasBlock && !hasHelp) return;
			this._replaceBlock(editor, content, START, END, sepIndex, this._buildHelp());
			return;
		}

		// ── DATA / DATOS / INFO / CSV ────────────────────────────────
		if (!dataBlock.match(/^#\s+(DATA|DATOS|INFO|CSV)\b/im)) return;

		// Sin CSV real todavía → no hacer nada
		const sections = extractSections(dataBlock);
		if (!sections || (!sections.expenses?.length && !sections.income?.length)) return;

		// Ya hay reporte de datos y no es forzado → no sobreescribir
		if (hasBlock && !hasHelp && !force) return;

		const rates      = getRates(fm);
		const currencies = parseCurrency(fm);
		const { comp, catSection, obs } = generateReport(sections, rates, currencies);

		this._replaceBlock(editor, content, START, END, sepIndex, this._buildBlock(comp, catSection, obs));
	}

	// Reemplaza el bloque START…END si existe, o lo inserta antes del separador
	_replaceBlock(editor, content, START, END, sepIndex, block) {
		const si = content.indexOf(START);
		const ei = content.indexOf(END);

		let newContent;
		if (si !== -1 && ei !== -1) {
			newContent = content.slice(0, si) + block + content.slice(ei + END.length);
		} else {
			const fmEnd  = this._findFrontmatterEnd(content);
			const before = content.slice(0, fmEnd).trimEnd();
			const after  = content.slice(fmEnd).trimStart();
			newContent   = before + '\n\n' + block + '\n\n' + after;
		}

		if (newContent !== content) {
			const cursor = editor.getCursor();
			editor.setValue(newContent);
			try { editor.setCursor(cursor); } catch (_) {}
		}
	}

	_buildBlock(comp, catSection, obs) {
		return [
			'<!-- reporte-finanzas:inicio -->',
			'# Finanzas',
			'',
			'## Comparativa',
			'',
			'```',
			comp.trimEnd(),
			'```',
			'',
			'## Gastos',
			'',
			'```',
			catSection.trimEnd(),
			'```',
			'',
			obs,
			'',
			'<!-- reporte-finanzas:fin -->',
		].join('\n');
	}

	_buildHelp() {
		return [
			'<!-- reporte-finanzas:inicio -->',
			'> **Reporte Finanzas \u2014 uso r\u00e1pido**',
			'>',
			'> 1. A\u00f1ade `reporte: true` al frontmatter YAML.',
			'> 2. Escribe una l\u00ednea `----` como separador.',
			'> 3. Debajo del `----` pon un encabezado `# DATA` (o `DATOS`, `INFO`, `CSV`)',
			'>    y pega tus datos CSV de hledger (secciones `expenses` / `income`).',
			'> 4. El reporte aparece autom\u00e1ticamente encima del `----`.',
			'>',
			'> **Moneda:** `moneda: RUB, USD` (principal, secundaria). Opciones: RUB, USD, EUR.',
			'> **Tipos de cambio:** `RUBUSD: 90` · `RUBEUR: 95` · `EURUSD: 1.05`',
			'<!-- reporte-finanzas:fin -->',
		].join('\n');
	}

	_findFrontmatterEnd(content) {
		if (!content.startsWith('---')) return 0;
		const end = content.indexOf('\n---', 3);
		if (end === -1) return 0;
		return end + 4;
	}
}

module.exports = ReporteFinanzasPlugin;
