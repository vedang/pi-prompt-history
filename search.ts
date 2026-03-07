import type { PromptHistoryEntry } from "./db";

/**
 * Query/lookup module for prompt-history search.
 */
export type SearchScope = "local" | "global";

export interface SearchOptions {
	scope: SearchScope;
	query: string;
	cwd: string;
	limit?: number;
}

export interface PromptSearchResult extends PromptHistoryEntry {
	score: number;
	matchPositions: number[];
}

interface SubstringMatch {
	score: number;
	matchPositions: number[];
}

interface FuzzyMatch {
	score: number;
	matchPositions: number[];
}

const DEFAULT_LIMIT = 10;
const EXACT_MATCH_BONUS = 100_000;
const FUZZY_BASE_SCORE = 1_000;

/**
 * Search indexed prompt text with local/global scope filtering.
 */
export async function searchPrompts(
	db: {
		listRecentPrompts: (options: {
			scope: SearchScope;
			cwd: string;
			limit: number;
		}) => PromptHistoryEntry[];
		listPromptCandidates?: (options: {
			scope: SearchScope;
			cwd: string;
		}) => PromptHistoryEntry[];
	},
	options: SearchOptions,
): Promise<PromptSearchResult[]> {
	const query = options.query.trim();
	const limit = options.limit ?? DEFAULT_LIMIT;

	if (!query) {
		return db
			.listRecentPrompts({
				scope: options.scope,
				cwd: options.cwd,
				limit,
			})
			.map((entry, index) => ({
				...entry,
				score: Number.MAX_SAFE_INTEGER - index,
				matchPositions: [],
			}));
	}

	const candidates = db.listPromptCandidates
		? db.listPromptCandidates({
				scope: options.scope,
				cwd: options.cwd,
			})
		: db.listRecentPrompts({
				scope: options.scope,
				cwd: options.cwd,
				limit: Math.max(1_000, limit * 100),
			});

	const normalizedQuery = query.toLowerCase();
	const scoredCandidates = candidates
		.map((entry): PromptSearchResult | null => {
			const exact = scoreExactSubstringMatch(entry.text, normalizedQuery);
			if (exact !== null) {
				return {
					...entry,
					score: EXACT_MATCH_BONUS + exact.score,
					matchPositions: exact.matchPositions,
				};
			}

			const fuzzy = scoreFuzzyMatch(entry.text, normalizedQuery);
			if (fuzzy === null) {
				return null;
			}

			return {
				...entry,
				score: FUZZY_BASE_SCORE + fuzzy.score,
				matchPositions: fuzzy.matchPositions,
			};
		})
		.filter((entry): entry is PromptSearchResult => entry !== null)
		.sort((left, right) => {
			if (left.score !== right.score) {
				return right.score - left.score;
			}
			return right.timestampMs - left.timestampMs;
		});

	return scoredCandidates.slice(0, limit);
}

const scoreExactSubstringMatch = (
	text: string,
	query: string,
): SubstringMatch | null => {
	const lowerText = text.toLowerCase();
	const start = lowerText.indexOf(query);
	if (start < 0) {
		return null;
	}

	const matchPositions = Array.from(
		{ length: query.length },
		(_, index) => start + index,
	);

	const startBonus = Math.max(0, 256 - start);
	const lengthBonus = query.length * 16;

	return {
		score: startBonus + lengthBonus,
		matchPositions,
	};
};

const scoreFuzzyMatch = (text: string, query: string): FuzzyMatch | null => {
	const lowerText = text.toLowerCase();
	const lowerQuery = query.toLowerCase();

	const matchPositions: number[] = [];
	let textIndex = 0;
	let lastMatch = -1;
	let score = 0;

	for (const char of lowerQuery) {
		const foundIndex = lowerText.indexOf(char, textIndex);
		if (foundIndex < 0) {
			return null;
		}

		matchPositions.push(foundIndex);

		if (foundIndex === lastMatch + 1) {
			score += 75;
		} else {
			score += Math.max(1, 20 - (foundIndex - textIndex));
		}

		if (lastMatch >= 0) {
			score -= foundIndex - lastMatch - 1;
		} else {
			score += Math.max(0, 40 - foundIndex);
		}

		lastMatch = foundIndex;
		textIndex = foundIndex + 1;
	}

	return {
		score,
		matchPositions,
	};
};
