/**
 * UI selector/overlay scaffolding for future Ctrl+R interaction.
 */
export interface PromptHistorySelection {
	text: string;
	selectedIndex: number;
}

export function createPromptHistorySelector(): Promise<PromptHistorySelection> {
	return Promise.resolve({ text: "", selectedIndex: -1 });
}
