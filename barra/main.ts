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

		// Add command to manually update
		this.addCommand({
			id: 'update-progress-bars',
			name: 'Actualizar barras de progreso',
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
		const val = cache.frontmatter['todolist'];
		return val === true || val === 'true' || val === 1;
	}

	buildProgressBar(completed: number, total: number): string {
		if (total === 0) return '';
		const ratio = completed / total;
		const filled = Math.round(ratio * this.settings.barWidth);
		const empty = this.settings.barWidth - filled;
		return `[${this.settings.filledChar.repeat(filled)}${this.settings.emptyChar.repeat(empty)}]`;
	}

	// Strip existing progress bar from a line
	stripProgressBar(text: string): string {
		return text.replace(/\s*\[█*░*\]\s*$/, '').trimEnd();
	}

	// Parse indentation level (count leading tabs/spaces, treating 4 spaces as 1 tab)
	getIndent(line: string): number {
		const match = line.match(/^(\s*)/);
		if (!match) return 0;
		const spaces = match[1].replace(/\t/g, '    ');
		return Math.floor(spaces.length / 4);
	}

	isTaskLine(line: string): boolean {
		return /^\s*- \[[ x]\]/.test(line);
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
				// Non-task line - stop if we're past parent level
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

	async updateProgressBars(file: TFile, editor: Editor) {
		const hasTodolist = await this.hasTodolistFrontmatter(file);
		if (!hasTodolist) return;

		const content = editor.getValue();
		const lines = content.split('\n');
		
		// Find frontmatter end
		let fmEnd = 0;
		if (lines[0] === '---') {
			for (let i = 1; i < lines.length; i++) {
				if (lines[i] === '---') { fmEnd = i + 1; break; }
			}
		}

		// Collect all task lines that need progress bars
		const updates: { lineNum: number, newText: string }[] = [];

		// Build full task tree from after frontmatter
		const processLines = (startLine: number, endLine: number) => {
			let i = startLine;
			while (i < endLine) {
				if (!this.isTaskLine(lines[i])) { i++; continue; }
				
				const indent = this.getIndent(lines[i]);
				// Only process top-level and any level that has children
				const { tasks, nextIdx } = this.buildTaskTree(lines, i, indent - 1);
				
				for (const task of tasks) {
					this.collectUpdates(task, lines, updates);
				}
				
				i = nextIdx;
			}
		};

		// Process root-level tasks
		const rootResult = this.buildTaskTree(lines, fmEnd, -1);
		for (const task of rootResult.tasks) {
			this.collectUpdates(task, lines, updates);
		}

		// Apply updates in reverse order to preserve line numbers
		if (updates.length === 0) return;

		// Sort by line number descending
		updates.sort((a, b) => b.lineNum - a.lineNum);

		// Remove duplicates (keep first occurrence = last line)
		const seen = new Set<number>();
		const deduped = updates.filter(u => {
			if (seen.has(u.lineNum)) return false;
			seen.add(u.lineNum);
			return true;
		});

		// Apply all changes at once using transaction
		const newLines = [...lines];
		for (const update of deduped) {
			newLines[update.lineNum] = update.newText;
		}

		const newContent = newLines.join('\n');
		if (newContent !== content) {
			const cursor = editor.getCursor();
			editor.setValue(newContent);
			editor.setCursor(cursor);
		}
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
				newText: `${cleanText} ${bar}`
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
