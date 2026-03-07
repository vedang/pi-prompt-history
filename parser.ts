/**
 * Session parsing helpers for prompt-history indexing.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { PromptHistoryEntry } from "./db";

type SessionLine = {
	type?: string;
	id?: unknown;
	parentId?: unknown;
	cwd?: unknown;
	name?: unknown;
	timestamp?: unknown;
	message?: unknown;
};

type PromptMessage = {
	role?: unknown;
	content?: unknown;
	timestamp?: unknown;
};

type TextBlock = {
	type?: unknown;
	text?: unknown;
};

export type ParsedSessionPrompt = PromptHistoryEntry & {
	entryId: string;
	promptTimestampMs: number;
	parentId: string | null;
	sessionName: string;
	ordinalInSession: number;
	contentHash: string;
};

export interface ParsedSession {
	file: string;
	cwd: string;
	sessionName: string;
	prompts: ParsedSessionPrompt[];
}

export interface ParserOptions {
	cwd?: string;
}

const toTrimmedString = (value: unknown): string | undefined => {
	if (typeof value !== "string") {
		return undefined;
	}

	const trimmed = value.trim();
	return trimmed.length > 0 ? value : undefined;
};

const toTimestampMs = (value: unknown): number | undefined => {
	if (typeof value === "number") {
		return Number.isFinite(value) ? value : undefined;
	}

	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isNaN(parsed) ? undefined : parsed;
	}

	return undefined;
};

const parsePromptTimestampMs = (
	entryTimestamp: unknown,
	messageTimestamp: unknown,
): number => {
	return (
		toTimestampMs(messageTimestamp) ??
		toTimestampMs(entryTimestamp) ??
		Date.now()
	);
};

export const extractUserPromptText = (content: unknown): string | undefined => {
	if (typeof content === "string") {
		return toTrimmedString(content);
	}

	if (!Array.isArray(content)) {
		return undefined;
	}

	const textBlocks = content
		.filter((block): block is TextBlock => {
			if (!block || typeof block !== "object") {
				return false;
			}

			return (
				(block as { type?: unknown }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string"
			);
		})
		.map((block) => (block.text as string).trim())
		.filter((text) => text.length > 0);

	if (textBlocks.length === 0) {
		return undefined;
	}

	return textBlocks.join("\n");
};

export const buildPromptPreview = (text: string): string => {
	return text.trim().replace(/\s+/g, " ");
};

const buildPromptHash = (text: string): string => {
	return createHash("sha256").update(text).digest("hex");
};

export async function parseSessionFile(
	sessionFile: string,
	options: ParserOptions = {},
): Promise<ParsedSession | null> {
	let content: string;
	try {
		content = await readFile(sessionFile, "utf-8");
	} catch {
		return null;
	}

	const lines = content.split("\n");
	let cwd = options.cwd ?? "";
	let latestSessionName = "";
	let ordinalInSession = 0;

	const prompts: Array<Omit<ParsedSessionPrompt, "sessionName">> = [];

	for (const rawLine of lines) {
		if (!rawLine.trim()) {
			continue;
		}

		let parsed: SessionLine;
		try {
			parsed = JSON.parse(rawLine) as SessionLine;
		} catch {
			continue;
		}

		if (parsed.type === "session") {
			const nextCwd = toTrimmedString(parsed.cwd);
			if (nextCwd !== undefined) {
				cwd = nextCwd;
			}
			continue;
		}

		if (parsed.type === "session_info") {
			const nextSessionName = toTrimmedString(parsed.name);
			if (nextSessionName !== undefined) {
				latestSessionName = nextSessionName;
			}
			continue;
		}

		if (parsed.type !== "message") {
			continue;
		}

		const message = parsed.message as PromptMessage | undefined;
		if (!message || typeof message !== "object") {
			continue;
		}

		if (message.role !== "user") {
			continue;
		}

		const entryIdRaw = toTrimmedString(parsed.id);
		if (!entryIdRaw) {
			continue;
		}

		const entryText = extractUserPromptText(message.content);
		if (entryText === undefined) {
			continue;
		}

		const parentId =
			typeof parsed.parentId === "string"
				? parsed.parentId
				: parsed.parentId === null
					? null
					: null;

		const promptTimestampMs = parsePromptTimestampMs(
			parsed.timestamp,
			message.timestamp,
		);

		prompts.push({
			sessionFile,
			entryId: entryIdRaw,
			id: entryIdRaw,
			parentId,
			cwd,
			text: entryText,
			preview: buildPromptPreview(entryText),
			timestampMs: promptTimestampMs,
			promptTimestampMs,
			ordinalInSession,
			contentHash: buildPromptHash(entryText),
		});

		ordinalInSession += 1;
	}

	return {
		file: sessionFile,
		cwd,
		sessionName: latestSessionName,
		prompts: prompts.map((prompt) => ({
			...prompt,
			sessionName: latestSessionName,
		})),
	};
}
