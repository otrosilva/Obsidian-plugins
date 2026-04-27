/*
 * Barra — Obsidian Plugin v1.3.0
 *
 * frontmatter:
 *   barra: 0 / false          → desactivado
 *   barra: 1 / true           → activo, sin porcentaje
 *   barra: 2 / porcentaje / percent → activo, con porcentaje numérico
 */
'use strict';

var obsidian = require('obsidian');

const DEFAULT_SETTINGS = {
    barWidth:   24,
    filledChar: '█',
    emptyChar:  '░',
};

// ─── Parsear valor de barra ────────────────────────────────────────────────────
// Devuelve: { active: false }  → desactivado, limpiar barras si las hay
//           { active: true, showPercent: bool } → activo
//           null → propiedad ausente, no tocar el archivo
function parseBarraValue(raw) {
    if (raw === undefined || raw === null) return null;
    const s = String(raw).trim().toLowerCase();
    if (['0', 'false', 'no', 'off', ''].includes(s)) return { active: false };
    const withPercent = ['2', 'porcentaje', 'percent', 'percentage'];
    return { active: true, showPercent: withPercent.includes(s) };
}

// ─── Plugin ───────────────────────────────────────────────────────────────────
class BarraPlugin extends obsidian.Plugin {

    async onload() {
        await this.loadSettings();

        // Actualizar al cambiar de línea con teclado
        this.registerDomEvent(document, 'keyup', (e) => {
            if (!['ArrowUp', 'ArrowDown', 'Tab'].includes(e.key)) return;
            const view = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
            if (!view?.file) return;
            const line = view.editor.getCursor().line;
            if (line !== this._lastLine) {
                this._lastLine = line;
                this.updateProgressBars(view.file, view.editor);
            }
        });

        // Actualizar al cambiar de línea con ratón
        this.registerDomEvent(document, 'mouseup', () => {
            const view = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
            if (!view?.file) return;
            const line = view.editor.getCursor().line;
            if (line !== this._lastLine) {
                this._lastLine = line;
                this.updateProgressBars(view.file, view.editor);
            }
        });

        // Actualizar al abrir / cambiar de archivo
        this.registerEvent(
            this.app.workspace.on('active-leaf-change', () => {
                this._lastLine = undefined;
                const view = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
                if (view?.file) {
                    setTimeout(() => {
                        if (view.file) this.updateProgressBars(view.file, view.editor);
                    }, 200);
                }
            })
        );

        // Comando manual
        this.addCommand({
            id: 'barra-update',
            name: 'Actualizar barras de progreso',
            editorCallback: (editor, view) => {
                if (view.file) this.updateProgressBars(view.file, editor);
            }
        });

        this.addSettingTab(new BarraSettingTab(this.app, this));
        console.log('Barra: plugin cargado ✓');
    }

    onunload() {}

    // ── Opciones desde frontmatter ────────────────────────────────────────────
    getBarraOptions(file) {
        const cache = this.app.metadataCache.getFileCache(file);
        if (!cache?.frontmatter) return null;
        if (!('barra' in cache.frontmatter)) return null; // propiedad ausente
        return parseBarraValue(cache.frontmatter['barra']);
    }

    // ── Construir barra ───────────────────────────────────────────────────────
    buildBar(completed, total, opts) {
        if (total === 0) return '';
        const ratio  = completed / total;
        const filled = Math.round(ratio * this.settings.barWidth);
        const empty  = this.settings.barWidth - filled;
        const bar    = this.settings.filledChar.repeat(filled) + this.settings.emptyChar.repeat(empty);
        if (opts.showPercent) {
            return `${Math.round(ratio * 100)}% ${bar}`;
        }
        return bar;
    }

    // Eliminar barra existente de una línea
    stripBar(text) {
        // Con porcentaje:  "  33% ████░░░░"
        // Sin porcentaje:  "  ████░░░░"
        return text
            .replace(/\s+\d+%\s+[█░\u2588\u2591]+\s*$/i, '')
            .replace(/\s+[█░\u2588\u2591]+\s*$/, '')
            .trimEnd();
    }

    // ── Helpers ───────────────────────────────────────────────────────────────
    getIndent(line) {
        const m = line.match(/^(\s*)/);
        return m ? Math.floor(m[1].replace(/\t/g, '    ').length / 4) : 0;
    }

    isTaskLine(line) { return /^\s*- \[[ xX]\]/.test(line); }
    isChecked(line)  { return /^\s*- \[[xX]\]/.test(line); }

    // ── Árbol de tareas ───────────────────────────────────────────────────────
    buildTaskTree(lines, startIdx, parentIndent) {
        const tasks = [];
        let i = startIdx;
        while (i < lines.length) {
            const line = lines[i];
            if (!this.isTaskLine(line)) {
                if (parentIndent === -1) { i++; continue; }
                break;
            }
            const indent = this.getIndent(line);
            if (indent < parentIndent + 1) break;
            if (indent > parentIndent + 1) { i++; continue; }

            const task = { line: i, checked: this.isChecked(line), children: [] };
            const { tasks: children, nextIdx } = this.buildTaskTree(lines, i + 1, indent);
            task.children = children;
            i = nextIdx;
            tasks.push(task);
        }
        return { tasks, nextIdx: i };
    }

    // ── Recolectar actualizaciones (bottom-up) ────────────────────────────────
    collectUpdates(task, lines, updates, opts) {
        // Primero recurrir en hijos para que su estado checked esté actualizado
        for (const child of task.children) {
            this.collectUpdates(child, lines, updates, opts);
        }

        const original = lines[task.line];
        const clean    = this.stripBar(original);

        if (task.children.length > 0) {
            const total     = task.children.length;
            const completed = task.children.filter(c => c.checked).length;
            const allDone   = completed === total;

            // Auto-marcar o desmarcar la tarea padre según sus hijos
            const currentlyChecked = this.isChecked(clean);
            let updatedClean = clean;
            if (allDone && !currentlyChecked) {
                updatedClean = clean.replace(/^(\s*- )\[ \]/, '$1[x]');
                task.checked = true; // propagar hacia arriba
            } else if (!allDone && currentlyChecked) {
                updatedClean = clean.replace(/^(\s*- )\[[xX]\]/, '$1[ ]');
                task.checked = false;
            }

            // Barra de progreso (si opts está activo)
            if (opts) {
                const bar     = this.buildBar(completed, total, opts);
                const newText = `${updatedClean}  ${bar}`;
                if (newText !== original) updates.push({ lineNum: task.line, newText });
            } else if (updatedClean !== original) {
                updates.push({ lineNum: task.line, newText: updatedClean });
            }
        } else {
            // Sin hijos: solo quitar barra sobrante si la hubiera
            if (clean !== original) updates.push({ lineNum: task.line, newText: clean });
        }
    }

    // ── Actualización principal ───────────────────────────────────────────────
    async updateProgressBars(file, editor) {
        const opts = this.getBarraOptions(file);
        if (!opts) return; // propiedad ausente → no tocar

        const content = editor.getValue();
        const lines   = content.split('\n');

        let start = 0;
        if (lines[0] === '---') {
            for (let i = 1; i < lines.length; i++) {
                if (lines[i] === '---') { start = i + 1; break; }
            }
        }

        if (!opts.active) {
            // Limpiar todas las barras existentes en el archivo
            let changed = false;
            const newLines = lines.map(line => {
                if (!this.isTaskLine(line)) return line;
                const clean = this.stripBar(line);
                if (clean !== line) { changed = true; return clean; }
                return line;
            });
            if (changed) {
                const cursor = editor.getCursor();
                editor.setValue(newLines.join('\n'));
                editor.setCursor(cursor);
            }
            return;
        }

        const { tasks } = this.buildTaskTree(lines, start, -1);
        const updates   = [];
        for (const task of tasks) this.collectUpdates(task, lines, updates, opts);
        if (updates.length === 0) return;

        const newLines = [...lines];
        for (const u of updates) newLines[u.lineNum] = u.newText;

        const newContent = newLines.join('\n');
        if (newContent !== content) {
            const cursor = editor.getCursor();
            editor.setValue(newContent);
            editor.setCursor(cursor);
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }
    async saveSettings() {
        await this.saveData(this.settings);
    }
}

// ─── Settings tab ─────────────────────────────────────────────────────────────
class BarraSettingTab extends obsidian.PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'Barra — Ajustes' });

        new obsidian.Setting(containerEl)
            .setName('Ancho de la barra')
            .setDesc('Número de caracteres (ej: 24 → ████████░░░░░░░░░░░░░░░░)')
            .addSlider(slider => slider
                .setLimits(8, 48, 2)
                .setValue(this.plugin.settings.barWidth)
                .setDynamicTooltip()
                .onChange(async (v) => {
                    this.plugin.settings.barWidth = v;
                    await this.plugin.saveSettings();
                }));

        new obsidian.Setting(containerEl)
            .setName('Carácter relleno')
            .setDesc('Carácter para la parte completada')
            .addText(t => t
                .setPlaceholder('█')
                .setValue(this.plugin.settings.filledChar)
                .onChange(async (v) => {
                    this.plugin.settings.filledChar = v.charAt(0) || '█';
                    await this.plugin.saveSettings();
                }));

        new obsidian.Setting(containerEl)
            .setName('Carácter vacío')
            .setDesc('Carácter para la parte incompleta')
            .addText(t => t
                .setPlaceholder('░')
                .setValue(this.plugin.settings.emptyChar)
                .onChange(async (v) => {
                    this.plugin.settings.emptyChar = v.charAt(0) || '░';
                    await this.plugin.saveSettings();
                }));

        containerEl.createEl('h3', { text: 'Valores de barra en el frontmatter' });
        containerEl.createEl('div').innerHTML = `
<table style="width:100%;border-collapse:collapse;font-size:.9em">
  <tr style="background:var(--background-secondary)">
    <th style="text-align:left;padding:6px 10px">Valor</th>
    <th style="text-align:left;padding:6px 10px">Efecto</th>
    <th style="text-align:left;padding:6px 10px">Ejemplo de barra</th>
  </tr>
  <tr>
    <td style="padding:6px 10px"><code>0</code> / <code>false</code></td>
    <td style="padding:6px 10px">Desactivado</td>
    <td style="padding:6px 10px">—</td>
  </tr>
  <tr style="background:var(--background-secondary)">
    <td style="padding:6px 10px"><code>1</code> / <code>true</code></td>
    <td style="padding:6px 10px">Activo sin porcentaje</td>
    <td style="padding:6px 10px"><code>████████░░░░░░░░░░░░░░░░</code></td>
  </tr>
  <tr>
    <td style="padding:6px 10px"><code>2</code> / <code>porcentaje</code> / <code>percent</code></td>
    <td style="padding:6px 10px">Activo con porcentaje</td>
    <td style="padding:6px 10px"><code>33% ████░░░░░░░░░░░░░░░░░░░░</code></td>
  </tr>
</table>
<br>
<p>Las barras se actualizan al cambiar de línea (Enter, ↑↓, Tab, clic).</p>`;
    }
}

module.exports = BarraPlugin;
