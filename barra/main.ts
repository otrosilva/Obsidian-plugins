import { App, Editor, MarkdownView, Plugin, PluginSettingTab, Setting, TFile, MarkdownPostProcessorContext } from 'obsidian';

interface TodoProgressSettings {
	barWidth: number;
	filledChar: string;
	emptyChar: string;
	autoUpdate: boolean;
}

const DEFAULT_SETTINGS: TodoProgressSettings = {
	barWidth: 24,
	filledChar: '█',
	emptyChar: '░',
	autoUpdate: true
}

// Parse task lines and their nesting level
interface TaskInfo {
	line: number;
	indent: number;
	checked: boolean;
	text: string;
	hasChildren: boolean;
	children: TaskInfo[];
}

export default class TodoProgressPlugin extends Plugin {
	settings: TodoProgressSettings;
	private updateTimeout: NodeJS.Timeout | null = null;

	async onload() {
		await this.loadSettings();

		// Watch for file changes to update progress bars
		this.registerEvent(
			this.app.workspace.on('editor-change', (editor: Editor, view: MarkdownView) => {
				if (!this.settings.autoUpdate) return;
				if (!view.file) return;
				
				// Debounce updates
				if (this.updateTimeout) clearTimeout(this.updateTimeout);
				this.updateTimeout = setTimeout(() => {
					this.updateProgressBars(view.file!, editor);
				}, 300);
			})
		);

		// Also update when switching to a file
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', () => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (view?.file) {
					setTimeout(() => {
						if (view.file) this.updateProgressBars(view.file, view.editor);
					}, 100);
				}
			})
		);

		// Detecta cambios hechos por fuera de Obsidian (ej. micro con mdtasks.lua).
		// Si el archivo modificado es el que está abierto en el editor activo,
		// usamos ese editor (preserva cursor); si no, escribimos directo a disco.
		this.registerEvent(
			this.app.vault.on('modify', (file) => {
				if (!this.settings.autoUpdate) return;
				if (!(file instanceof TFile)) return;

				const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
				const isActiveFile = activeView?.file?.path === file.path;

				if (this.updateTimeout) clearTimeout(this.updateTimeout);
				this.updateTimeout = setTimeout(() => {
					if (isActiveFile && activeView?.file) {
						this.updateProgressBars(activeView.file, activeView.editor);
					} else {
						this.updateProgressBarsInFile(file);
					}
				}, 300);
			})
		);

		// Add command to manually update
		this.addCommand({
			id: 'update-progress-bars',
			name: 'Update progress bars',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				if (view.file) this.updateProgressBars(view.file, editor);
			}
		});

		this.addSettingTab(new TodoProgressSettingTab(this.app, this));
	}

	onunload() {
		if (this.updateTimeout) clearTimeout(this.updateTimeout);
	}

	async hasTodolistFrontmatter(file: TFile): Promise<boolean> {
		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache?.frontmatter) return false;
		const val = cache.frontmatter['barra'];
		return val === true || val === 'true' || val === 1 || val === '1';
	}

	buildProgressBar(completed: number, total: number): string {
		if (total === 0) return '';
		const ratio = completed / total;
		const filled = Math.round(ratio * this.settings.barWidth);
		const empty = this.settings.barWidth - filled;
		return `${this.settings.filledChar.repeat(filled)}${this.settings.emptyChar.repeat(empty)}`;
	}

	// Strip existing progress bar from a line
	stripProgressBar(text: string): string {
		// Igual a stripBar() en barra.lua: quita "  33% ████░░░" o "  ████░░░" al final, sin corchetes.
		// Solo se recorta espacio sobrante cuando alguno de los patrones de barra
		// realmente matcheó; si la línea no tenía barra, se devuelve sin tocar
		// (importante: no debe comerse espacios que el usuario esté tipeando,
		// como en una subtarea recién creada y todavía vacía).
		const withoutPercentBar = text.replace(/\s+\d+%\s+[█░]+\s*$/, '');
		if (withoutPercentBar !== text) return withoutPercentBar.trimEnd();

		const withoutBar = text.replace(/\s+[█░]+\s*$/, '');
		if (withoutBar !== text) return withoutBar.trimEnd();

		return text;
	}

	// Parse indentation level (count leading tabs/spaces, treating 4 spaces as 1 tab)
	getIndent(line: string): number {
		const match = line.match(/^(\s*)/);
		if (!match) return 0;
		const spaces = match[1].replace(/\t/g, '    ');
		return Math.floor(spaces.length / 4);
	}

	isTaskLine(line: string): boolean {
		return /^\s*- \[[ x>]\]/i.test(line);
	}

	isChecked(line: string): boolean {
		return /^\s*- \[x\]/i.test(line);
	}

	// Build a tree of tasks from lines
	buildTaskTree(lines: string[], startIdx: number, parentIndent: number): { tasks: TaskInfo[], nextIdx: number } {
		const tasks: TaskInfo[] = [];
		let i = startIdx;

		while (i < lines.length) {
			const line = lines[i];
			if (!this.isTaskLine(line)) {
				// A nivel raíz (parentIndent === -1) las líneas no-tarea (encabezados,
				// texto suelto, líneas vacías) se saltan: pueden separar bloques de tareas
				// sin que eso signifique el fin del árbol. Dentro de un grupo de hijos
				// (parentIndent >= 0) sí cortamos, porque ahí una línea no-tarea cierra
				// ese nivel de anidación.
				if (parentIndent === -1) { i++; continue; }
				break;
			}

			const indent = this.getIndent(line);
			
			if (indent < parentIndent + 1) break; // Back to parent or higher
			if (indent > parentIndent + 1) { i++; continue; } // Skip deeper orphans

			const task: TaskInfo = {
				line: i,
				indent,
				checked: this.isChecked(line),
				text: line,
				hasChildren: false,
				children: []
			};

			// Look ahead for children
			const childResult = this.buildTaskTree(lines, i + 1, indent);
			task.children = childResult.tasks;
			task.hasChildren = task.children.length > 0;
			i = childResult.nextIdx;

			tasks.push(task);
		}

		return { tasks, nextIdx: i };
	}

	// Count completed and total direct children
	countChildren(task: TaskInfo): { completed: number, total: number } {
		const total = task.children.length;
		const completed = task.children.filter(c => c.checked).length;
		return { completed, total };
	}

	// Calcula el nuevo contenido a partir de texto plano. No toca el editor ni el disco.
	// Devuelve null si no hay cambios que aplicar.
	// Calcula qué líneas cambiarían y su nuevo texto, sin tocar editor ni disco.
	computeUpdates(content: string): { lineNum: number, newText: string }[] {
		const lines = content.split('\n');

		// Find frontmatter end
		let fmEnd = 0;
		if (lines[0] === '---') {
			for (let i = 1; i < lines.length; i++) {
				if (lines[i] === '---') { fmEnd = i + 1; break; }
			}
		}

		const updates: { lineNum: number, newText: string }[] = [];

		const rootResult = this.buildTaskTree(lines, fmEnd, -1);
		for (const task of rootResult.tasks) {
			this.collectUpdates(task, lines, updates);
		}

		if (updates.length === 0) return [];

		updates.sort((a, b) => b.lineNum - a.lineNum);

		const seen = new Set<number>();
		const deduped = updates.filter(u => {
			if (seen.has(u.lineNum)) return false;
			seen.add(u.lineNum);
			return true;
		});

		// Solo devolver las que realmente cambian el texto de su línea
		return deduped.filter(u => u.newText !== lines[u.lineNum]);
	}

	// Calcula el nuevo contenido completo a partir de texto plano (usado para
	// escritura directa a disco, donde no hay editor ni cursor que preservar).
	computeUpdatedContent(content: string): string | null {
		const lines = content.split('\n');
		const updates = this.computeUpdates(content);
		if (updates.length === 0) return null;

		const newLines = [...lines];
		for (const update of updates) {
			newLines[update.lineNum] = update.newText;
		}

		return newLines.join('\n');
	}

	// Actualiza usando el editor activo. Reemplaza solo las líneas que cambiaron
	// con replaceRange, no el documento completo, así CodeMirror mantiene la
	// posición del cursor por sí mismo en líneas no afectadas (ej. al crear una
	// subtarea nueva justo cuando se recalcula la barra del padre).
	async updateProgressBars(file: TFile, editor: Editor) {
		const hasTodolist = await this.hasTodolistFrontmatter(file);
		if (!hasTodolist) return;

		const content = editor.getValue();
		const updates = this.computeUpdates(content);
		if (updates.length === 0) return;

		const cursor = editor.getCursor();

		// updates ya viene ordenado de mayor a menor lineNum (ver computeUpdates),
		// lo cual es importante: aplicar de abajo hacia arriba evita que un
		// replaceRange en una línea anterior desplace los números de línea
		// de las siguientes updates pendientes.
		for (const update of updates) {
			const lineLen = editor.getLine(update.lineNum).length;
			editor.replaceRange(
				update.newText,
				{ line: update.lineNum, ch: 0 },
				{ line: update.lineNum, ch: lineLen }
			);
		}

		// Solo reubicar el cursor si una de las líneas editadas era la línea
		// donde estaba el cursor (por ejemplo, se completó una subtarea en la
		// misma línea que se estaba tipeando). En cualquier otro caso, CodeMirror
		// ya mantuvo el cursor correctamente sin intervención.
		const cursorLineChanged = updates.some(u => u.lineNum === cursor.line);
		if (cursorLineChanged) {
			editor.setCursor(cursor);
		}
	}

	// Actualiza un archivo directamente en disco, sin depender de que esté abierto
	// en un editor. Necesario para detectar cambios hechos por fuera de Obsidian
	// (ej. editores externos como micro/mdtasks.lua).
	async updateProgressBarsInFile(file: TFile) {
		const hasTodolist = await this.hasTodolistFrontmatter(file);
		if (!hasTodolist) return;

		await this.app.vault.process(file, (content) => {
			const newContent = this.computeUpdatedContent(content);
			return newContent === null ? content : newContent;
		});
	}

	collectUpdates(task: TaskInfo, lines: string[], updates: { lineNum: number, newText: string }[]) {
		// Recurse into children first
		for (const child of task.children) {
			this.collectUpdates(child, lines, updates);
		}

		// Only add bar if task has children
		if (task.children.length > 0) {
			const { completed, total } = this.countChildren(task);
			const bar = this.buildProgressBar(completed, total);
			const cleanText = this.stripProgressBar(lines[task.line]);
			updates.push({
				lineNum: task.line,
				newText: `${cleanText}  ${bar}`
			});
		} else {
			// Remove bar if task no longer has children (or never had)
			const cleanText = this.stripProgressBar(lines[task.line]);
			if (cleanText !== lines[task.line]) {
				updates.push({ lineNum: task.line, newText: cleanText });
			}
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class TodoProgressSettingTab extends PluginSettingTab {
	plugin: TodoProgressPlugin;

	constructor(app: App, plugin: TodoProgressPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl('h2', { text: 'Todolist Progress — Ajustes' });

		new Setting(containerEl)
			.setName('Ancho de la barra')
			.setDesc('Número de caracteres de ancho para la barra de progreso')
			.addSlider(slider => slider
				.setLimits(8, 40, 2)
				.setValue(this.plugin.settings.barWidth)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.barWidth = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Carácter relleno')
			.setDesc('Carácter para la parte completada')
			.addText(text => text
				.setValue(this.plugin.settings.filledChar)
				.onChange(async (value) => {
					this.plugin.settings.filledChar = value || '█';
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Carácter vacío')
			.setDesc('Carácter para la parte incompleta')
			.addText(text => text
				.setValue(this.plugin.settings.emptyChar)
				.onChange(async (value) => {
					this.plugin.settings.emptyChar = value || '░';
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Actualización automática')
			.setDesc('Actualizar barras automáticamente al cambiar tareas')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoUpdate)
				.onChange(async (value) => {
					this.plugin.settings.autoUpdate = value;
					await this.plugin.saveSettings();
				}));
	}
}
