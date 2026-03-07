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
	togglePromptHistoryScope,
} from "./selector";

interface PromptHistoryTheme {
	fg: (name: string, text: string) => string;
	bold: (text: string) => string;
}

export interface PromptHistorySelection {
	item: PromptSearchResult;
	scope: SearchScope;
	query: string;
}

export interface PromptHistorySelectorOptions {
	tui: TUI;
	theme: PromptHistoryTheme;
	initialScope: SearchScope;
	initialResults: PromptSearchResult[];
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
		this.results = options.initialResults;
		this.query = options.initialQuery ?? "";
		this.onSearch = options.onSearch;
		this.onSelect = options.onSelect;
		this.onCancel = options.onCancel;
		this.maxVisible = options.maxVisible ?? 8;
	}

	handleInput(data: string): void {
		const kb = getEditorKeybindings();

		if (matchesKey(data, Key.tab) || matchesKey(data, Key.ctrl("r"))) {
			this.scope = togglePromptHistoryScope(this.scope);
			void this.refreshResults();
			return;
		}

		if (kb.matches(data, "selectUp")) {
			if (this.results.length > 0) {
				this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			}
			this.tui.requestRender();
			return;
		}

		if (kb.matches(data, "selectDown")) {
			if (this.results.length > 0) {
				this.selectedIndex = Math.min(
					this.results.length - 1,
					this.selectedIndex + 1,
				);
			}
			this.tui.requestRender();
			return;
		}

		if (kb.matches(data, "selectPageUp")) {
			if (this.results.length > 0) {
				this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisible);
			}
			this.tui.requestRender();
			return;
		}

		if (kb.matches(data, "selectPageDown")) {
			if (this.results.length > 0) {
				this.selectedIndex = Math.min(
					this.results.length - 1,
					this.selectedIndex + this.maxVisible,
				);
			}
			this.tui.requestRender();
			return;
		}

		if (kb.matches(data, "selectConfirm")) {
			const selected = this.results[this.selectedIndex];
			if (selected) {
				this.onSelect({
					item: selected,
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

		lines.push(border(`╭${"─".repeat(innerWidth)}╮`));
		lines.push(
			boxLine(
				`${accent(this.theme.bold("Prompt History"))} ${dim(`[${this.scopeLabel()}]`)}`,
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

			for (let index = windowStart; index < windowEnd; index += 1) {
				const entry = this.results[index];
				if (!entry) {
					continue;
				}
				const selected = index === this.selectedIndex;
				const prefix = selected ? accent("› ") : dim("  ");
				const preview = highlightPositions(
					entry.preview || entry.text,
					entry.matchPositions,
					(text) => this.theme.fg("warning", this.theme.bold(text)),
				);
				const meta = buildPromptHistoryMetadata(entry, this.scope);
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

		lines.push(border(`├${"─".repeat(innerWidth)}┤`));
		lines.push(
			boxLine(
				dim(
					"↑ ↓ navigate • PgUp/PgDn page • Enter select • Tab/Ctrl+R toggle • Esc cancel",
				),
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

	private async refreshResults(): Promise<void> {
		const requestId = ++this.requestId;
		this.loading = true;
		this.tui.requestRender();

		try {
			const results = await this.onSearch(this.query, this.scope);
			if (requestId !== this.requestId) {
				return;
			}
			this.results = results;
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

	private scopeLabel(): string {
		return this.scope === "local" ? "Local" : "Global";
	}
}

const boxLine = (
	content: string,
	innerWidth: number,
	border: (text: string) => string,
): string => {
	const padding = Math.max(0, innerWidth - visibleWidth(content));
	return `${border("│")}${content}${" ".repeat(padding)}${border("│")}`;
};

const highlightPositions = (
	text: string,
	matchPositions: number[],
	highlight: (text: string) => string,
): string => {
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
};
