/**
 * Database module scaffolding for prompt history indexing.
 */
export interface PromptHistoryDbConfig {
	path: string;
}

export interface PromptHistoryEntry {
	id: string;
	sessionFile: string;
	text: string;
	cwd: string;
	timestampMs: number;
}

export class PromptHistoryDb {
	constructor(_config: PromptHistoryDbConfig) {
		_config;
	}

	close(): Promise<void> {
		return Promise.resolve();
	}

	listRecentPrompts(
		_cwd: string,
		_limit: number,
	): Promise<PromptHistoryEntry[]> {
		return Promise.resolve([]);
	}
}
