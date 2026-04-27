/*
 * Reporte Finanzas — Plugin para Obsidian
 *
 * Activación: propiedad YAML  reporte: true
 * Tipos de cambio opcionales en YAML:
 *   RUBUSD: 90    (cuántos ₽ vale 1 USD, por defecto 80)
 *   EURUSD: 0.90  (cuántos EUR vale 1 USD)
 *   RUBEUR: 100   (cuántos ₽ vale 1 EUR)
 *
 * El reporte se escribe ENCIMA del separador "----".
 * Los datos van DEBAJO del separador "----".
 * Se actualiza automáticamente al dejar de escribir (debounce 500ms).
 */

'use strict';

const { Plugin, MarkdownView } = require('obsidian');

// ═══════════════════════════════════════════════════════════════
// TIPOS DE CAMBIO
// ═══════════════════════════════════════════════════════════════

const DEFAULT_RUBUSD = 80; // ₽ por 1 USD

function getRates(frontmatter) {
	// Devuelve cuántos ₽ equivalen a 1 USD
	if (!frontmatter) return DEFAULT_RUBUSD;

	if (frontmatter.RUBUSD) return Number(frontmatter.RUBUSD);

	// Si tenemos RUBEUR y EURUSD podemos calcular
	if (frontmatter.RUBEUR && frontmatter.EURUSD) {
		const rubEur = Number(frontmatter.RUBEUR);   // ₽ por 1 EUR
		const eurUsd = Number(frontmatter.EURUSD);   // EUR por 1 USD
		return rubEur / eurUsd;                      // ₽ por 1 USD
	}

	return DEFAULT_RUBUSD;
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
	// Devuelve { rub, usd } como números positivos
	if (!str || str === '0') return { rub: 0, usd: 0 };
	let rub = 0, usd = 0;
	for (const part of str.split(',').map(s => s.trim())) {
		const m = part.match(/([-\d.]+)\s*(RUB|USD|EUR)/);
		if (!m) continue;
		const v = Math.abs(parseFloat(m[1]));
		if (m[2] === 'RUB') rub += v;
		else if (m[2] === 'USD') usd += v;
		// EUR lo ignoramos aquí — se convierte al mostrar
	}
	return { rub, usd };
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
	// Divide el bloque en secciones delimitadas por ━━━ nombre ━━━
	const re = /━{10,}[\s\S]*?\n\s*(\w+)\s*\n[\s\S]*?━{10,}/g;
	const sections = {};
	const positions = [];
	let m;
	while ((m = re.exec(dataBlock)) !== null) {
		positions.push({ name: m[1], end: m.index + m[0].length });
	}
	for (let i = 0; i < positions.length; i++) {
		const { name, end } = positions[i];
		const nextStart = i + 1 < positions.length
			? positions[i + 1].end - positions[i + 1].end  // recalculated below
			: dataBlock.length;
		// Buscar el inicio del siguiente bloque ━━━ para saber hasta dónde llega éste
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
		const dow = d.getDay() === 0 ? 7 : d.getDay(); // lunes=1
		const mon = new Date(d);
		mon.setDate(d.getDate() - dow + 1);
		const key = mon.toISOString().slice(0, 10);
		if (!acc[key]) acc[key] = [];
		acc[key].push(r);
	}
	return acc;
}

function sumRows(rows) {
	let rub = 0, usd = 0;
	for (const r of rows) {
		const a = parseAmount(r.amount);
		rub += a.rub;
		usd += a.usd;
	}
	return { rub, usd };
}

function sumByCategory(rows) {
	const acc = {};
	for (const r of rows) {
		const cat = r.account.replace(/^expenses:/, '');
		if (!acc[cat]) acc[cat] = 0;
		acc[cat] += parseAmount(r.amount).rub;
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

function fmt(n) {
	return Math.round(n).toLocaleString('es-RU');
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

function generateReport(sections, rubPerUsd) {
	const expRows = sections.expenses || [];
	const incRows = sections.income  || [];

	const expByMonth = groupByMonth(expRows);
	const incByMonth = groupByMonth(incRows);
	const months = [...new Set([
		...Object.keys(expByMonth),
		...Object.keys(incByMonth),
	])].sort();

	const multiMonth = months.length > 1;

	// ── Totales por mes ─────────────────────────────────────────
	const monthData = months.map(m => {
		const exp = sumRows(expByMonth[m] || []);
		const inc = sumRows(incByMonth[m] || []);
		return { key: m, label: monthLabel(m), exp, inc };
	});

	const maxExpRub = Math.max(...monthData.map(m => m.exp.rub), 1);
	const maxIncUsd = Math.max(...monthData.map(m => m.inc.usd), 1);

	// ── Tabla comparativa ────────────────────────────────────────
	let comp = '';
	const BAR_W = 26;
	comp += `${'Mes'.padEnd(12)}${'Gasto total'.padEnd(BAR_W + 2)}Ingreso\n`;
	comp += '─'.repeat(72) + '\n';

	for (const m of monthData) {
		const expBar = bar(m.exp.rub, maxExpRub, BAR_W);
		const incBar = bar(m.inc.usd, maxIncUsd, BAR_W);
		const incRubApprox = m.inc.usd * rubPerUsd + m.inc.rub;

		comp += `${m.label.padEnd(12)}${expBar}  ${incBar}\n`;
		comp += `${' '.repeat(12)}`;
		comp += `gasto: ${fmt(m.exp.rub)} ₽`;
		if (m.inc.usd > 0) {
			comp += `      ingreso: $${fmt(m.inc.usd)} (≈ ${fmt(incRubApprox)} ₽)`;
		} else if (m.inc.rub > 0) {
			comp += `      ingreso: ${fmt(m.inc.rub)} ₽`;
		}
		comp += '\n\n';
	}

	// ── Tabla de gastos ──────────────────────────────────────────
	const CAT_W = 24;

	function buildCatTable(rows, label) {
		const cats  = sumByCategory(rows);
		const sorted = Object.entries(cats).sort((a, b) => b[1] - a[1]);
		if (sorted.length === 0) return '';
		const maxCat = sorted[0][1];
		let t = label ? `── ${label} ──\n` : '';
		for (const [cat, total] of sorted) {
			const b = bar(total, maxCat, CAT_W);
			t += `[${b}] ${cat} (${fmt(total)} ₽)\n`;
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
	const totalExp = sumRows(expRows);
	const totalInc = sumRows(incRows);
	const totalIncRub = totalInc.usd * rubPerUsd + totalInc.rub;
	const balance    = totalIncRub - totalExp.rub;
	const balSign    = balance >= 0 ? '+' : '';

	const periodStr = multiMonth
		? `${monthLabel(months[0])}–${monthLabel(months[months.length - 1])}`
		: monthLabel(months[0] || '');

	let obs = `> 💡 **Período:** ${periodStr} · `;
	obs += `Gasto total: **${fmt(totalExp.rub)} ₽** · `;
	if (totalInc.usd > 0) {
		obs += `Ingreso: **$${fmt(totalInc.usd)}** (≈ ${fmt(totalIncRub)} ₽ a ${fmt(rubPerUsd)} ₽/$) · `;
	} else if (totalInc.rub > 0) {
		obs += `Ingreso: **${fmt(totalInc.rub)} ₽** · `;
	}
	obs += `Balance estimado: **${balSign}${fmt(balance)} ₽**`;

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

		// Actualizar cuando cambia el frontmatter (ej: reporte: true/false)
		this.registerEvent(
			this.app.metadataCache.on('changed', (file) => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view || !view.file) return;
				if (view.file.path !== file.path) return;
				clearTimeout(this._debounce);
				this._debounce = setTimeout(() => this._tryRender(view), 300);
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

	_tryRender(view) {
		if (!view || !view.file) return;

		// Verificar propiedad YAML reporte: true o 1
		const cache = this.app.metadataCache.getFileCache(view.file);
		const fm    = cache?.frontmatter;
		if (!fm) return;
		const reporteVal = fm.reporte;
		if (!ReporteFinanzasPlugin._isActive(reporteVal)) return;

		const editor  = view.editor;
		const content = editor.getValue();

		// Separador: línea que contiene solo "----"
		const sepMatch = content.match(/^----\s*$/m);
		if (!sepMatch) return;

		const sepIndex  = content.indexOf(sepMatch[0]);
		const dataBlock = content.slice(sepIndex + sepMatch[0].length).trim();

		// Si no hay nada debajo del separador, no hacer nada
		if (!dataBlock) return;

		// Detectar si la primera cabecera es AYUDA / HELP
		const helpMatch = dataBlock.match(/^#\s+(AYUDA|HELP)\b/im);
		if (helpMatch) {
			const helpBlock = this._buildHelp();
			this._injectAboveSep(editor, content, sepIndex, helpBlock);
			return;
		}

		// Detectar si la primera cabecera es DATA / DATOS / INFO / CSV
		const dataMatch = dataBlock.match(/^#\s+(DATA|DATOS|INFO|CSV)\b/im);
		if (!dataMatch) return;

		// Extraer secciones — si no hay CSV real todavía, no hacer nada
		const sections = extractSections(dataBlock);
		if (!sections || (!sections.expenses?.length && !sections.income?.length)) return;

		// Solo omitir si ya hay un reporte de datos encima (no de ayuda)
		const aboveSep = content.slice(0, sepIndex);
		const START = '<!-- reporte-finanzas:inicio -->';
		const HELP_MARKER = '> **Reporte Finanzas \u2014 uso r\u00e1pido**';
		const hasBlock = aboveSep.includes(START);
		const hasHelpBlock = hasBlock && aboveSep.includes(HELP_MARKER);
		// Si hay reporte de datos real (no ayuda), no sobreescribir
		if (hasBlock && !hasHelpBlock) return;

		const rubPerUsd = getRates(fm);
		const { comp, catSection, obs } = generateReport(sections, rubPerUsd);

		const reportBlock = this._buildBlock(comp, catSection, obs);
		this._inject(editor, content, sepIndex, reportBlock);
	}

	_buildHelp() {
		return [
			'<!-- reporte-finanzas:inicio -->',
			'> **Reporte Finanzas — uso rápido**',
			'>',
			'> 1. Añade `reporte: true` al frontmatter YAML.',
			'> 2. Escribe una línea `----` como separador.',
			'> 3. Debajo del `----` pon un encabezado `# DATA` (o `DATOS`, `INFO`, `CSV`)',
			'>    y pega tus datos CSV de hledger (secciones `expenses` / `income`).',
			'> 4. El reporte aparecerá automáticamente encima del `----`.',
			'>',
			'> Tipos de cambio opcionales en el frontmatter: `RUBUSD`, `RUBEUR`, `EURUSD`.',
			'<!-- reporte-finanzas:fin -->',
		].join('\n');
	}

	_injectAboveSep(editor, content, sepIndex, block) {
		const START = '<!-- reporte-finanzas:inicio -->';
		const END   = '<!-- reporte-finanzas:fin -->';

		const si = content.indexOf(START);
		const ei = content.indexOf(END);

		let newContent;
		if (si !== -1 && ei !== -1) {
			// Reemplazar bloque existente
			const before = content.slice(0, si);
			const after  = content.slice(ei + END.length);
			newContent = before + block + after;
		} else {
			// Insertar justo antes del separador ----
			const fmEnd  = this._findFrontmatterEnd(content);
			const before = content.slice(0, fmEnd).trimEnd();
			const after  = content.slice(fmEnd).trimStart();
			newContent = before + '\n\n' + block + '\n\n' + after;
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

	_inject(editor, content, sepIndex, reportBlock) {
		const START = '<!-- reporte-finanzas:inicio -->';
		const END   = '<!-- reporte-finanzas:fin -->';

		const si = content.indexOf(START);
		const ei = content.indexOf(END);

		let newContent;

		if (si !== -1 && ei !== -1) {
			// Reemplazar bloque existente (que está antes del separador)
			const before = content.slice(0, si);
			const after  = content.slice(ei + END.length);
			newContent = before + reportBlock + after;
		} else {
			// Primera vez: insertar justo antes del separador ----
			// Buscar el frontmatter para no insertarnos dentro de él
			const fmEnd = this._findFrontmatterEnd(content);
			const insertAt = Math.max(fmEnd, 0);

			// Insertar el bloque entre el frontmatter y el "----"
			const before = content.slice(0, insertAt).trimEnd();
			const after  = content.slice(insertAt).trimStart();
			newContent = before + '\n\n' + reportBlock + '\n\n' + after;
		}

		if (newContent !== content) {
			const cursor = editor.getCursor();
			editor.setValue(newContent);
			// Restaurar cursor aproximado
			try { editor.setCursor(cursor); } catch (_) {}
		}
	}

	_findFrontmatterEnd(content) {
		// El frontmatter YAML empieza con "---\n" y termina con "\n---\n"
		if (!content.startsWith('---')) return 0;
		const end = content.indexOf('\n---', 3);
		if (end === -1) return 0;
		return end + 4; // justo después del "---\n" de cierre
	}
}

module.exports = ReporteFinanzasPlugin;
