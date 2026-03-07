import { execSync, spawn } from "node:child_process";
import { platform } from "node:os";

export function copyToClipboard(text: string): void {
	emitOsc52(text);

	try {
		if (platform() === "darwin") {
			execSync("pbcopy", nativeCopyOptions(text));
			return;
		}

		if (platform() === "win32") {
			execSync("clip", nativeCopyOptions(text));
			return;
		}

		copyToLinuxClipboard(text);
	} catch {
		// Ignore native clipboard failures: OSC 52 was already emitted.
	}
}

function copyToLinuxClipboard(text: string): void {
	if (process.env.TERMUX_VERSION) {
		try {
			execSync("termux-clipboard-set", nativeCopyOptions(text));
			return;
		} catch {
			// Fall through to Wayland/X11 clipboard tools.
		}
	}

	if (isWaylandSession()) {
		try {
			execSync("which wl-copy", { stdio: "ignore" });
			pipeToClipboardProcess("wl-copy", text);
			return;
		} catch {
			// Fall through to X11 clipboard tools.
		}
	}

	try {
		execSync("xclip -selection clipboard", nativeCopyOptions(text));
	} catch {
		execSync("xsel --clipboard --input", nativeCopyOptions(text));
	}
}

function emitOsc52(text: string): void {
	const encoded = Buffer.from(text).toString("base64");
	process.stdout.write(`\u001b]52;c;${encoded}\u0007`);
}

function isWaylandSession(): boolean {
	return (
		process.env.XDG_SESSION_TYPE === "wayland" ||
		typeof process.env.WAYLAND_DISPLAY === "string"
	);
}

function nativeCopyOptions(text: string) {
	return {
		input: text,
		timeout: 5000,
		stdio: ["pipe", "ignore", "ignore"] as const,
	};
}

function pipeToClipboardProcess(command: string, text: string): void {
	const processHandle = spawn(command, [], {
		stdio: ["pipe", "ignore", "ignore"],
	});

	processHandle.stdin.on("error", () => {
		// Ignore EPIPE when the clipboard process exits early.
	});
	processHandle.stdin.end(text);
	processHandle.unref();
}
