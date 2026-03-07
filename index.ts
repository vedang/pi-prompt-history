import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { registerPromptHistoryCommands } from "./commands";
import { initializePromptHistoryConfig } from "./config";

/**
 * Prompt History extension scaffold.
 *
 * Real command, shortcut, and overlay wiring will be added in follow-up tasks.
 */
export default function promptHistoryExtension(pi: ExtensionAPI): void {
	initializePromptHistoryConfig();
	registerPromptHistoryCommands(pi);
}
