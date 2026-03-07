import { basename } from "node:path";

import type { PromptHistoryAction } from "./config";
import type { PromptSearchResult, SearchScope } from "./search";

export type { PromptHistoryAction } from "./config";

export interface PromptHistoryActionKeyBindings {
	copy: string;
	resume: string;
}

export type PromptHistorySessionGroup =
	| "current-session"
	| "same-cwd"
	| "other-cwd";

export interface PromptHistorySessionContext {
	currentCwd: string;
	activeSessionFile?: string;
}

export interface PromptHistoryMetadataOptions
	extends PromptHistorySessionContext {
	scope: SearchScope;
	nowMs?: number;
	sessionGroup: PromptHistorySessionGroup;
}

export interface PromptHistoryResultSection {
	group: PromptHistorySessionGroup;
	label: string;
	results: PromptSearchResult[];
}

export const PROMPT_HISTORY_RESUME_CHOICES = {
	fork: "Fork from this point (default)",
	restore: "Restore entire session",
} as const;

const SECONDARY_ACTION_KEY = "f2";
const PROMPT_HISTORY_GROUP_ORDER: PromptHistorySessionGroup[] = [
	"current-session",
	"same-cwd",
	"other-cwd",
];
const PROMPT_HISTORY_SESSION_GROUP_LABELS: Record<
	PromptHistorySessionGroup,
	string
> = {
	"current-session": "Current session",
	"same-cwd": "Same cwd",
	"other-cwd": "Other cwd",
};

const PROMPT_HISTORY_ACTION_KEY_BINDINGS: Record<
	PromptHistoryAction,
	PromptHistoryActionKeyBindings
> = {
	copy: {
		copy: "enter",
		resume: SECONDARY_ACTION_KEY,
	},
	resume: {
		copy: SECONDARY_ACTION_KEY,
		resume: "enter",
	},
};

export function resolvePromptHistoryActionKeyBindings(
	primaryAction: PromptHistoryAction,
): PromptHistoryActionKeyBindings {
	return { ...PROMPT_HISTORY_ACTION_KEY_BINDINGS[primaryAction] };
}

export function togglePromptHistoryScope(scope: SearchScope): SearchScope {
	return scope === "local" ? "global" : "local";
}

export function formatRelativeTime(
	timestampMs: number,
	nowMs = Date.now(),
): string {
	const deltaMs = Math.max(0, nowMs - timestampMs);
	if (deltaMs < 60_000) {
		return "just now";
	}

	const minutes = Math.floor(deltaMs / 60_000);
	if (minutes < 60) {
		return `${minutes}m ago`;
	}

	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return `${hours}h ago`;
	}

	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

export function resolvePromptHistorySessionGroup(
	entry: Pick<PromptSearchResult, "sessionFile" | "cwd">,
	context: PromptHistorySessionContext,
): PromptHistorySessionGroup {
	if (
		context.activeSessionFile !== undefined &&
		entry.sessionFile === context.activeSessionFile
	) {
		return "current-session";
	}
	if (entry.cwd === context.currentCwd) {
		return "same-cwd";
	}
	return "other-cwd";
}

export function formatPromptHistorySessionGroupLabel(
	group: PromptHistorySessionGroup,
): string {
	return PROMPT_HISTORY_SESSION_GROUP_LABELS[group];
}

export function formatPromptHistoryScopeLabel(
	scope: SearchScope,
	sessionGroup: PromptHistorySessionGroup,
): string {
	const scopeLabel = scope === "local" ? "Local" : "Global";
	return `${scopeLabel} • ${formatPromptHistorySessionGroupLabel(sessionGroup)}`;
}

export function buildPromptHistoryMetadata(
	entry: Pick<
		PromptSearchResult,
		"sessionFile" | "sessionName" | "cwd" | "timestampMs"
	>,
	options: PromptHistoryMetadataOptions,
): string {
	const nowMs = options.nowMs ?? Date.now();
	const sessionLabel = entry.sessionName || basename(entry.sessionFile);
	const parts = [
		formatRelativeTime(entry.timestampMs, nowMs),
		sessionLabel,
		formatPromptHistorySessionGroupLabel(options.sessionGroup).toLowerCase(),
	];
	if (options.scope === "global" || options.sessionGroup === "other-cwd") {
		parts.push(entry.cwd);
	}
	return parts.join(" • ");
}

export function groupPromptHistoryResults(
	results: PromptSearchResult[],
	context: PromptHistorySessionContext,
): PromptHistoryResultSection[] {
	const buckets: Record<PromptHistorySessionGroup, PromptSearchResult[]> = {
		"current-session": [],
		"same-cwd": [],
		"other-cwd": [],
	};

	for (const result of results) {
		const group = resolvePromptHistorySessionGroup(result, context);
		buckets[group].push(result);
	}

	return PROMPT_HISTORY_GROUP_ORDER.flatMap((group) => {
		const groupedResults = buckets[group];
		if (groupedResults.length === 0) {
			return [];
		}
		return [
			{
				group,
				label: formatPromptHistorySessionGroupLabel(group),
				results: groupedResults,
			},
		];
	});
}
