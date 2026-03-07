import { basename } from "node:path";

import type { PromptSearchResult, SearchScope } from "./search";

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

export function buildPromptHistoryMetadata(
	entry: Pick<
		PromptSearchResult,
		"sessionFile" | "sessionName" | "cwd" | "timestampMs"
	>,
	scope: SearchScope,
	nowMs = Date.now(),
): string {
	const sessionLabel = entry.sessionName || basename(entry.sessionFile);
	const parts = [formatRelativeTime(entry.timestampMs, nowMs), sessionLabel];
	if (scope === "global") {
		parts.push(entry.cwd);
	}
	return parts.join(" • ");
}
