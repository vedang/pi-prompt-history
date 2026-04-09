import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { registerPromptHistoryCommands } from "./commands";

/**
 * Prompt History extension entry point.
 * Registers the /prompt-history commands and the Ctrl+R shortcut.
 */
export default function promptHistoryExtension(pi: ExtensionAPI): void {
  registerPromptHistoryCommands(pi);
}
