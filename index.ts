/**
 * pi-mock-provider — a zero-delay fake provider for pi, for measuring how
 * much of the end-to-end latency is pi's own machinery versus the network.
 *
 * The provider answers instantly in-process: no sockets, no HTTP, no sleep.
 * Any wall-clock time between your prompt and the reply is therefore pure
 * framework overhead (request building, transcript processing, agent loop,
 * TUI). Compare it against the same prompt on a real provider to see the
 * network/model share.
 *
 * Models:
 *   mock/instant   replies "Mock reply." immediately
 *   mock/echo      echoes your last user message back (truncated)
 *
 * Every turn on a mock model prints the measured framework delay.
 *
 * Auth: `/login mock` stores a fake credential once so pi's auth checks
 * (setModel, session restore) accept the provider from then on. The login
 * itself is instant and touches nothing.
 *
 * Environment:
 *   PI_MOCK_DELAY_MS   optional artificial delay in ms (default 0), to
 *                      simulate a slow provider for comparison
 *   PI_MOCK_DEBUG=1    trace logging to stderr
 */

import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Model,
	OAuthCredentials,
	OAuthLoginCallbacks,
	SimpleStreamOptions,
	TextContent,
	Usage,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

// =============================================================================
// Helpers
// =============================================================================

function debugLog(event: string, data: Record<string, unknown> = {}): void {
	if (process.env.PI_MOCK_DEBUG !== "1") return;
	try {
		console.error("[pi-mock] " + JSON.stringify({ event, ...data }));
	} catch {
		// Debug logging must never break the provider.
	}
}

function artificialDelayMs(): number {
	const raw = Number(process.env.PI_MOCK_DELAY_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(new Error("Aborted"));
			},
			{ once: true },
		);
	});
}

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function baseMessage(model: Model<any>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: zeroUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** Flatten the last user message of the transcript to plain text. */
function lastUserText(context: Context): string {
	const messages = context.messages ?? [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as { role?: string; content?: unknown };
		if (message.role !== "user") continue;
		const content = message.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter((block) => (block as TextContent).type === "text")
				.map((block) => (block as TextContent).text)
				.join(" ")
				.trim();
		}
	}
	return "(no user message found)";
}

function mockReplyFor(model: Model<any>, context: Context): string {
	if (model.id === "echo") {
		const text = lastUserText(context);
		return text.length > 200 ? `${text.slice(0, 200)}…` : text;
	}
	return "Mock reply.";
}

// =============================================================================
// The zero-delay stream
// =============================================================================

function streamMock(
	model: Model<any>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const reply = mockReplyFor(model, context);
	const delay = artificialDelayMs();
	const signal = options?.signal;

	void (async () => {
		try {
			const partial = baseMessage(model);
			const push = (event: AssistantMessageEvent): void => {
				debugLog("event", { type: event.type });
				stream.push(event);
			};

			if (delay > 0) await sleep(delay, signal);
			push({ type: "start", partial });

			const textBlock: TextContent = { type: "text", text: "" };
			partial.content.push(textBlock);
			push({ type: "text_start", contentIndex: 0, partial });

			// Emit word-by-word deltas with no delay between them: exercises the
			// delta path (rendering, transcript appends) without adding latency.
			const words = reply.split(/(\s+)/u).filter((w) => w.length > 0);
			for (const word of words) {
				if (signal?.aborted) throw new Error("Aborted");
				if (delay > 0) await sleep(delay, signal);
				textBlock.text += word;
				push({ type: "text_delta", contentIndex: 0, delta: word, partial });
			}

			push({ type: "text_end", contentIndex: 0, content: textBlock.text, partial });
			partial.usage = zeroUsage();
			partial.stopReason = "stop";
			push({ type: "done", reason: "stop", message: partial });
			stream.end();
		} catch (error) {
			const errorMessage = baseMessage(model);
			errorMessage.stopReason = "error";
			errorMessage.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: "aborted", error: errorMessage });
			stream.end();
		}
	})();

	return stream;
}

// =============================================================================
// Extension entry point
// =============================================================================

interface MockModelConfig {
	id: string;
	name: string;
}

const MOCK_MODELS: MockModelConfig[] = [
	{ id: "instant", name: "Mock Instant (0ms)" },
	{ id: "echo", name: "Mock Echo (0ms, echoes prompt)" },
];

export default function (pi: ExtensionAPI): void {
	function makeProviderConfig(): ProviderConfig {
		return {
			name: "Mock",
			baseUrl: "http://mock.invalid",
			apiKey: "mock-not-needed",
			api: "openai-completions",
			streamSimple: streamMock as never,
			headers: {},
		};
	}

	// Instant fake login: stores a credential once so pi's auth checks (setModel,
	// session restore) accept mock models. Touches no network and no state
	// beyond the auth entry itself.
	function makeOAuthConfig() {
		return {
			name: "Mock",
			login: async (callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> => {
				callbacks.onProgress?.("Mock login: instant, nothing to authorize...");
				return {
					refresh: "mock-refresh-token",
					access: "mock-access-token",
					expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
				};
			},
			refreshToken: (credentials: OAuthCredentials) => credentials,
			getApiKey: () => "mock-access-token",
		};
	}

	pi.registerProvider("mock", {
		...makeProviderConfig(),
		models: MOCK_MODELS.map((m) => ({
			id: m.id,
			name: m.name,
			api: "openai-completions" as const,
			reasoning: false,
			input: ["text"] as Array<"text" | "image">,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 4096,
		})),
		oauth: makeOAuthConfig(),
	});

	// Report the measured framework delay for every mock turn: the time from
	// agent_start (prompt accepted, loop begins) to the assistant message
	// completing. With a 0ms provider this is pi's own overhead.
	let turnStartedAt = 0;
	pi.on("agent_start", () => {
		turnStartedAt = Date.now();
	});
	pi.on("message_end", (event, ctx) => {
		const message = event.message as { role?: string; provider?: string };
		if (message.role !== "assistant" || message.provider !== "mock") return;
		const deltaMs = turnStartedAt > 0 ? Date.now() - turnStartedAt : -1;
		ctx.ui.notify(`[pi-mock] framework delay: ${deltaMs}ms`, "info");
	});

	debugLog("loaded", { models: MOCK_MODELS.map((m) => m.id) });
}
