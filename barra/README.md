# Barra — progress bars for nested tasks in Obsidian

Adds automatic progress bars to tasks that have subtasks. The bar reflects how many subtasks are checked off, and updates automatically as you edit.

## Example

```markdown
- [ ] Tarea 1  ████████████░░░░░░░░░░░░
	- [x] Sub tarea 1-1
	- [x] Sub tarea 1-2
	- [ ] Sub tarea 1-3  ████████████████░░░░░░░░
		- [x] Sub sub tarea 3-1
		- [x] Sub sub tarea 3-2
		- [ ] Sub sub tarea 3-3
	- [ ] Subtarea 4
- [ ] Tarea 2  ████████████░░░░░░░░░░░░
	- [ ] Sub tarea 2-1
	- [x] Sub tarea 4-2
```

## Deferred tasks: `[>]`

A subtask marked `- [>]` is treated as deferred/postponed. It counts toward the parent's total (affecting the percentage shown) but never counts as completed, no matter how the bar is calculated. Deferred tasks also render with a dimmed, grayed-out style so they're visually distinct from regular pending tasks.

```markdown
- [ ] Casa  ░░░░░░░░░░░░░░░░░░░░░░░░
	- [>] Bombillos para la cocina -> ferretería
	- [ ] Bombillo para el extractor -> ferretería
```

## Enabling the plugin on a note

Add a `barra` property to the note's frontmatter:

```yaml
---
barra: "1"
---
```

Any of `true`, `"true"`, `1`, or `"1"` activates the plugin for that file. Notes without this property are left untouched.

## How it works

- Progress bars are recalculated automatically when you edit a note inside Obsidian, when you switch to a different file, or when the file changes on disk (e.g. edited with an external tool).
- Only the lines that actually change are rewritten, so your cursor position is preserved while typing.
- You can also trigger a manual recalculation with the **Update progress bars** command from the command palette.
- Bar appearance (width, filled/empty characters) is configurable from the plugin's settings tab.

## Compatibility note

This plugin's bar format (no brackets, two spaces before the bar) is designed to match output from a companion script for the [micro](https://micro-editor.github.io/) text editor, so progress bars stay consistent whether a file is edited inside or outside Obsidian.

---

Built with the help of Claude.ai.

