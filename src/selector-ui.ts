import * as PiTui from "@mariozechner/pi-tui";
import type { Focusable, TUI } from "@mariozechner/pi-tui";
import {
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@mariozechner/pi-tui";

import type { PromptSearchResult, SearchScope } from "./search";
import {
  type PromptHistoryAction,
  type PromptHistoryActionKeyBindings,
  type PromptHistoryResultSection,
  type PromptHistorySessionContext,
  type PromptHistorySessionGroup,
  buildPromptHistoryMetadata,
  formatPromptHistoryScopeLabel,
  groupPromptHistoryResults,
  resolvePromptHistoryActionKeyBindings,
  resolvePromptHistorySessionGroup,
  togglePromptHistoryScope,
} from "./selector";

interface PromptHistoryTheme {
  fg: (name: string, text: string) => string;
  bold: (text: string) => string;
}

interface PromptHistoryKeybindings {
  matches(data: string, keybinding: string): boolean;
}

const PROMPT_HISTORY_KEYBINDINGS = {
  selectUp: ["tui.select.up", "selectUp"],
  selectDown: ["tui.select.down", "selectDown"],
  selectPageUp: ["tui.select.pageUp", "selectPageUp"],
  selectPageDown: ["tui.select.pageDown", "selectPageDown"],
  selectCancel: ["tui.select.cancel", "selectCancel"],
} as const;

const NAVIGATION_BINDINGS = [
  { names: PROMPT_HISTORY_KEYBINDINGS.selectUp, delta: -1, page: false },
  { names: PROMPT_HISTORY_KEYBINDINGS.selectDown, delta: 1, page: false },
  { names: PROMPT_HISTORY_KEYBINDINGS.selectPageUp, delta: -1, page: true },
  { names: PROMPT_HISTORY_KEYBINDINGS.selectPageDown, delta: 1, page: true },
] as const;

function asPromptHistoryKeybindings(
  value: unknown,
): PromptHistoryKeybindings | undefined {
  return value &&
    typeof (value as PromptHistoryKeybindings).matches === "function"
    ? (value as PromptHistoryKeybindings)
    : undefined;
}

function instantiatePromptHistoryKeybindings(
  ctor: unknown,
  definitions: unknown,
): PromptHistoryKeybindings | undefined {
  if (typeof ctor !== "function" || !definitions) {
    return undefined;
  }

  return new (ctor as new (definitions: unknown) => PromptHistoryKeybindings)(
    definitions,
  );
}

function getRuntimeKeybindings(
  runtime: Record<string, unknown>,
  getterName: "getKeybindings" | "getEditorKeybindings",
): PromptHistoryKeybindings | undefined {
  const getter = runtime[getterName];
  if (typeof getter !== "function") {
    return undefined;
  }

  return asPromptHistoryKeybindings((getter as () => unknown)());
}

function createManualKeybindings(): PromptHistoryKeybindings {
  return {
    matches(data: string, keybinding: string): boolean {
      switch (keybinding) {
        case "tui.select.up":
        case "selectUp":
          return matchesKey(data, "up");
        case "tui.select.down":
        case "selectDown":
          return matchesKey(data, "down");
        case "tui.select.pageUp":
        case "selectPageUp":
          return matchesKey(data, "pageUp");
        case "tui.select.pageDown":
        case "selectPageDown":
          return matchesKey(data, "pageDown");
        case "tui.select.cancel":
        case "selectCancel":
          return matchesKey(data, "escape") || matchesKey(data, "ctrl+c");
        default:
          return false;
      }
    },
  };
}

function resolveRuntimeKeybindings(): PromptHistoryKeybindings | undefined {
  const runtime = PiTui as Record<string, unknown>;

  return (
    getRuntimeKeybindings(runtime, "getKeybindings") ??
    getRuntimeKeybindings(runtime, "getEditorKeybindings") ??
    instantiatePromptHistoryKeybindings(
      runtime.KeybindingsManager,
      runtime.TUI_KEYBINDINGS,
    ) ??
    instantiatePromptHistoryKeybindings(
      runtime.EditorKeybindingsManager,
      runtime.DEFAULT_EDITOR_KEYBINDINGS,
    )
  );
}

function resolvePromptHistoryKeybindings(
  explicit?: unknown,
): PromptHistoryKeybindings {
  return (
    asPromptHistoryKeybindings(explicit) ??
    resolveRuntimeKeybindings() ??
    createManualKeybindings()
  );
}

function matchesPromptHistoryKeybinding(
  keybindings: PromptHistoryKeybindings,
  data: string,
  names: readonly string[],
): boolean {
  return names.some((name) => keybindings.matches(data, name));
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
  keybindings?: unknown;
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
  private readonly keybindings: PromptHistoryKeybindings;

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
    this.keybindings = resolvePromptHistoryKeybindings(options.keybindings);
    this.sessionContext = {
      currentCwd: options.currentCwd,
      activeSessionFile: options.activeSessionFile,
    };
    this.results = this.orderResults(options.initialResults);
    this.input.setValue(this.query);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.ctrl("r"))) {
      this.scope = togglePromptHistoryScope(this.scope);
      void this.refreshResults();
      return;
    }

    // Navigation
    const navDelta = this.resolveNavigationDelta(data);
    if (navDelta !== null) {
      this.moveSelection(navDelta);
      return;
    }

    // Action keys
    const action = this.resolveAction(data);
    const selected = this.results[this.selectedIndex];
    if (action && selected) {
      this.onSelect({
        item: selected,
        action,
        scope: this.scope,
        query: this.query,
      });
      return;
    }

    if (
      matchesPromptHistoryKeybinding(
        this.keybindings,
        data,
        PROMPT_HISTORY_KEYBINDINGS.selectCancel,
      )
    ) {
      this.onCancel();
      return;
    }

    // Text input
    const previousValue = this.input.getValue();
    this.input.handleInput(data);
    if (this.input.getValue() !== previousValue) {
      this.query = this.input.getValue();
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

  private resolveNavigationDelta(data: string): number | null {
    for (const binding of NAVIGATION_BINDINGS) {
      if (
        matchesPromptHistoryKeybinding(this.keybindings, data, binding.names)
      ) {
        return binding.delta * (binding.page ? this.maxVisible : 1);
      }
    }

    return null;
  }

  private moveSelection(delta: number): void {
    this.selectedIndex = Math.min(
      this.results.length - 1,
      Math.max(0, this.selectedIndex + delta),
    );
    this.tui.requestRender();
  }

  private resolveAction(data: string): PromptHistoryAction | null {
    if (matchesKey(data, this.actionKeyBindings.copy)) return "copy";
    if (matchesKey(data, this.actionKeyBindings.resume)) return "resume";
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
    if (!this.results.length) return [];

    // Center the selected item in the window
    const half = Math.floor(this.maxVisible / 2);
    const start = Math.max(
      0,
      Math.min(
        this.selectedIndex - half,
        this.results.length - this.maxVisible,
      ),
    );
    return this.results.slice(start, start + this.maxVisible);
  }

  private getSessionGroup(
    entry: PromptSearchResult,
  ): PromptHistorySessionGroup {
    return resolvePromptHistorySessionGroup(entry, this.sessionContext);
  }

  private defaultSessionGroup = (): PromptHistorySessionGroup =>
    this.sessionContext.activeSessionFile
      ? "current-session"
      : this.scope === "local"
        ? "same-cwd"
        : "other-cwd";

  private scopeLabel(sessionGroup: PromptHistorySessionGroup): string {
    return formatPromptHistoryScopeLabel(this.scope, sessionGroup);
  }
}

function boxLine(
  content: string,
  innerWidth: number,
  border: (text: string) => string,
): string {
  const visible = visibleWidth(content);
  const padding = Math.max(0, innerWidth - visible);
  // If the content's visible width exceeds innerWidth (e.g., Input component
  // rendering with ANSI cursor sequences), re-truncate to fit.
  const safeContent =
    visible > innerWidth ? truncateToWidth(content, innerWidth) : content;
  const safePadding = Math.max(0, innerWidth - visibleWidth(safeContent));
  return `${border("│")}${safeContent}${" ".repeat(safePadding)}${border("│")}`;
}

function highlightPositions(
  text: string,
  matchPositions: number[],
  highlight: (text: string) => string,
): string {
  if (!matchPositions.length) return text;
  const positions = new Set(matchPositions);
  return [...text]
    .map((c, i) => (positions.has(i) ? highlight(c) : c))
    .join("");
}

const SECTION_COLORS: Record<PromptHistorySessionGroup, string> = {
  "current-session": "accent",
  "same-cwd": "muted",
  "other-cwd": "dim",
};

function formatSectionHeader(
  section: PromptHistoryResultSection,
  innerWidth: number,
  theme: PromptHistoryTheme,
): string {
  const content = ` ${section.label} (${section.results.length}) `;
  const dashes = "─".repeat(Math.max(0, innerWidth - visibleWidth(content)));
  return theme.fg(SECTION_COLORS[section.group], theme.bold(content + dashes));
}

const KEY_LABELS: Record<string, string> = {
  enter: "Enter",
  f2: "F2",
};

function formatKeyLabel(key: string): string {
  return KEY_LABELS[key] ?? key;
}
