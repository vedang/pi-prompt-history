import type { Focusable, TUI } from "@mariozechner/pi-tui";
import {
	getEditorKeybindings,
	Input,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@mariozechner/pi-tui";

import type { PromptSearchResult, SearchScope } from "./search";
import {
	buildPromptHistoryMetadata,
	formatPromptHistoryScopeLabel,
	groupPromptHistoryResults,
	resolvePromptHistoryActionKeyBindings,
	resolvePromptHistorySessionGroup,
	togglePromptHistoryScope,
	type PromptHistoryAction,
	type PromptHistoryActionKeyBindings,
	type PromptHistoryResultSection,
	type PromptHistorySessionContext,
	type PromptHistorySessionGroup,
} from "./selector";

interface PromptHistoryTheme {
	fg: (name: string, text: string) => string;
	bold: (text: string) => string;
}

export interface PromptHistorySelection {
	item: PromptSearchResult;
	action: PromptHistoryAction;
	scope: SearchScope;
	query: string;
}

export interface PromptHistorySelectorOptions {
	tui: TUI;
	theme: PromptHistoryTheme;
	initialScope: SearchScope;
	initialResults: PromptSearchResult[];
	primaryAction: PromptHistoryAction;
	currentCwd: string;
	activeSessionFile?: string;
	initialQuery?: string;
	maxVisible?: number;
	onSearch: (
		query: string,
		scope: SearchScope,
	) => Promise<PromptSearchResult[]>;
	onSelect: (selection: PromptHistorySelection) => void;
	onCancel: () => void;
}

export class PromptHistorySelector implements Focusable {
	private readonly input = new Input();
	private readonly tui: TUI;
	private readonly theme: PromptHistoryTheme;
	private readonly onSearch: PromptHistorySelectorOptions["onSearch"];
	private readonly onSelect: PromptHistorySelectorOptions["onSelect"];
	private readonly onCancel: PromptHistorySelectorOptions["onCancel"];
	private readonly maxVisible: number;
	private readonly actionKeyBindings: PromptHistoryActionKeyBindings;
	private readonly sessionContext: PromptHistorySessionContext;

	private query = "";
	private scope: SearchScope;
	private results: PromptSearchResult[];
	private selectedIndex = 0;
	private loading = false;
	private requestId = 0;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(options: PromptHistorySelectorOptions) {
		this.tui = options.tui;
		this.theme = options.theme;
		this.scope = options.initialScope;
		this.query = options.initialQuery ?? "";
		this.onSearch = options.onSearch;
		this.onSelect = options.onSelect;
		this.onCancel = options.onCancel;
		this.maxVisible = options.maxVisible ?? 8;
		this.actionKeyBindings = resolvePromptHistoryActionKeyBindings(
			options.primaryAction,
		);
		this.sessionContext = {
			currentCwd: options.currentCwd,
			activeSessionFile: options.activeSessionFile,
		};
		this.results = this.orderResults(options.initialResults);
		this.input.setValue(this.query);
	}

	handleInput(data: string): void {
		const kb = getEditorKeybindings();

		if (matchesKey(data, Key.tab) || matchesKey(data, Key.ctrl("r"))) {
			this.scope = togglePromptHistoryScope(this.scope);
			void this.refreshResults();
			return;
		}

		if (kb.matches(data, "selectUp")) {
			this.moveSelection(-1);
			return;
		}

		if (kb.matches(data, "selectDown")) {
			this.moveSelection(1);
			return;
		}

		if (kb.matches(data, "selectPageUp")) {
			this.moveSelection(-this.maxVisible);
			return;
		}

		if (kb.matches(data, "selectPageDown")) {
			this.moveSelection(this.maxVisible);
			return;
		}

		const action = this.resolveAction(data);
		if (action) {
			const selected = this.results[this.selectedIndex];
			if (selected) {
				this.onSelect({
					item: selected,
					action,
					scope: this.scope,
					query: this.query,
				});
			}
			return;
		}

		if (kb.matches(data, "selectCancel")) {
			this.onCancel();
			return;
		}

		const previousValue = this.input.getValue();
		this.input.handleInput(data);
		const nextValue = this.input.getValue();
		if (nextValue !== previousValue) {
			this.query = nextValue;
			void this.refreshResults();
		}
	}

	render(width: number): string[] {
		const innerWidth = Math.max(20, width - 2);
		const lines: string[] = [];
		const border = (text: string) => this.theme.fg("border", text);
		const accent = (text: string) => this.theme.fg("accent", text);
		const muted = (text: string) => this.theme.fg("muted", text);
		const dim = (text: string) => this.theme.fg("dim", text);
		const selectedEntry = this.results[this.selectedIndex];
		const selectedGroup = selectedEntry
			? this.getSessionGroup(selectedEntry)
			: this.defaultSessionGroup();

		lines.push(border(`╭${"─".repeat(innerWidth)}╮`));
		lines.push(
			boxLine(
				`${accent(this.theme.bold("Prompt History"))} ${dim(`[${this.scopeLabel(selectedGroup)}]`)}`,
				innerWidth,
				border,
			),
		);

		for (const inputLine of this.input.render(innerWidth)) {
			lines.push(boxLine(inputLine, innerWidth, border));
		}

		lines.push(
			boxLine(
				dim(
					`${this.results.length} result${this.results.length === 1 ? "" : "s"}${this.loading ? " • searching…" : ""}`,
				),
				innerWidth,
				border,
			),
		);
		lines.push(border(`├${"─".repeat(innerWidth)}┤`));

		if (this.results.length === 0) {
			lines.push(boxLine(muted("No matching prompts"), innerWidth, border));
		} else {
			for (const section of this.getVisibleSections()) {
				lines.push(
					boxLine(
						truncateToWidth(
							formatSectionHeader(section, innerWidth, this.theme),
							innerWidth,
						),
						innerWidth,
						border,
					),
				);

				for (const entry of section.results) {
					const selected = entry === this.results[this.selectedIndex];
					const prefix = selected ? accent("› ") : dim("  ");
					const preview = highlightPositions(
						entry.preview || entry.text,
						entry.matchPositions,
						(text) => this.theme.fg("warning", this.theme.bold(text)),
					);
					const meta = buildPromptHistoryMetadata(entry, {
						scope: this.scope,
						sessionGroup: section.group,
						...this.sessionContext,
					});
					lines.push(
						boxLine(
							truncateToWidth(
								`${prefix}${selected ? accent(preview) : preview}`,
								innerWidth,
							),
							innerWidth,
							border,
						),
					);
					lines.push(
						boxLine(
							truncateToWidth(
								`  ${selected ? muted(meta) : dim(meta)}`,
								innerWidth,
							),
							innerWidth,
							border,
						),
					);
				}
			}
		}

		lines.push(border(`├${"─".repeat(innerWidth)}┤`));
		lines.push(
			boxLine(
				truncateToWidth(dim(this.helpText()), innerWidth),
				innerWidth,
				border,
			),
		);
		lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
		return lines;
	}

	invalidate(): void {
		this.input.invalidate();
	}

	private moveSelection(delta: number): void {
		if (this.results.length > 0) {
			const nextIndex = this.selectedIndex + delta;
			this.selectedIndex = Math.min(
				this.results.length - 1,
				Math.max(0, nextIndex),
			);
		}
		this.tui.requestRender();
	}

	private resolveAction(data: string): PromptHistoryAction | null {
		if (matchesKey(data, this.actionKeyBindings.copy)) {
			return "copy";
		}
		if (matchesKey(data, this.actionKeyBindings.resume)) {
			return "resume";
		}
		return null;
	}

	private helpText(): string {
		return [
			"↑ ↓ navigate",
			"PgUp/PgDn page",
			`${formatKeyLabel(this.actionKeyBindings.copy)} copy`,
			`${formatKeyLabel(this.actionKeyBindings.resume)} resume`,
			"Tab/Ctrl+R toggle",
			"Esc cancel",
		].join(" • ");
	}

	private async refreshResults(): Promise<void> {
		const requestId = ++this.requestId;
		this.loading = true;
		this.tui.requestRender();

		try {
			const results = await this.onSearch(this.query, this.scope);
			if (requestId !== this.requestId) {
				return;
			}
			this.results = this.orderResults(results);
			this.selectedIndex = Math.min(
				this.selectedIndex,
				Math.max(0, this.results.length - 1),
			);
		} finally {
			if (requestId === this.requestId) {
				this.loading = false;
				this.tui.requestRender();
			}
		}
	}

	private getVisibleSections(): PromptHistoryResultSection[] {
		return groupPromptHistoryResults(
			this.getVisibleResults(),
			this.sessionContext,
		);
	}

	private orderResults(results: PromptSearchResult[]): PromptSearchResult[] {
		return groupPromptHistoryResults(results, this.sessionContext).flatMap(
			(section) => section.results,
		);
	}

	private getVisibleResults(): PromptSearchResult[] {
		if (this.results.length === 0) {
			return [];
		}

		const windowStart = Math.max(
			0,
			Math.min(
				this.selectedIndex - Math.floor(this.maxVisible / 2),
				this.results.length - this.maxVisible,
			),
		);
		const windowEnd = Math.min(
			this.results.length,
			windowStart + this.maxVisible,
		);
		return this.results.slice(windowStart, windowEnd);
	}

	private getSessionGroup(
		entry: PromptSearchResult,
	): PromptHistorySessionGroup {
		return resolvePromptHistorySessionGroup(entry, this.sessionContext);
	}

	private defaultSessionGroup(): PromptHistorySessionGroup {
		if (this.sessionContext.activeSessionFile) {
			return "current-session";
		}
		return this.scope === "local" ? "same-cwd" : "other-cwd";
	}

	private scopeLabel(sessionGroup: PromptHistorySessionGroup): string {
		return formatPromptHistoryScopeLabel(this.scope, sessionGroup);
	}
}

function boxLine(
	content: string,
	innerWidth: number,
	border: (text: string) => string,
): string {
	const padding = Math.max(0, innerWidth - visibleWidth(content));
	return `${border("│")}${content}${" ".repeat(padding)}${border("│")}`;
}

function highlightPositions(
	text: string,
	matchPositions: number[],
	highlight: (text: string) => string,
): string {
	if (matchPositions.length === 0) {
		return text;
	}

	const positions = new Set(matchPositions);
	let result = "";
	for (let index = 0; index < text.length; index += 1) {
		const character = text.charAt(index);
		result += positions.has(index) ? highlight(character) : character;
	}
	return result;
}

function formatSectionHeader(
	section: PromptHistoryResultSection,
	innerWidth: number,
	theme: PromptHistoryTheme,
): string {
	const label = `${section.label} (${section.results.length})`;
	const content = ` ${label} `;
	const dashCount = Math.max(0, innerWidth - visibleWidth(content));
	const styled = `${content}${"─".repeat(dashCount)}`;
	return theme.fg(sectionColor(section.group), theme.bold(styled));
}

const PROMPT_HISTORY_SECTION_COLORS: Record<PromptHistorySessionGroup, string> =
	{
		"current-session": "accent",
		"same-cwd": "muted",
		"other-cwd": "dim",
	};

function sectionColor(group: PromptHistorySessionGroup): string {
	return PROMPT_HISTORY_SECTION_COLORS[group];
}

function formatKeyLabel(key: string): string {
	if (key === "enter") {
		return "Enter";
	}
	if (key === "f2") {
		return "F2";
	}
	return key;
}
