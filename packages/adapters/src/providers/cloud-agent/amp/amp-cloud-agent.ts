import { createHash } from "node:crypto";
import type {
  AdapterContext,
  CloudAgentHandle,
  CloudAgentLaunchRequest,
  CloudAgentProvider,
  CloudAgentReplyRequest,
  CloudAgentSnapshot,
  CloudAgentStatus,
} from "@rakazo/adapter-kit";
import { CloudAgentRequestRejected, CloudAgentRetryLater } from "@rakazo/adapter-kit";
import { deadlineSignal, parseRetryAfter } from "@rakazo/core";
import { bestEffort } from "@rakazo/logging";
import { z } from "zod";
import {
  CLOUD_AGENT_OPEN_PR,
  cloudAgentRepositoryPrompt,
} from "../../../runs/wakeups/wakes.prompt.js";
import { readBodyCapped } from "../../../web/web-ssrf.js";

const threadSchema = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  archived: z.boolean().optional(),
  labels: z.array(z.string()).optional(),
  // Unknown future states read as running rather than wedging the poll.
  agentState: z.object({ state: z.string(), updatedAt: z.string() }).optional(),
  stats: z
    .object({ userMessageCount: z.number().int(), lastUserMessageAt: z.string().optional() })
    .optional(),
});
type Thread = z.infer<typeof threadSchema>;

/** Threads updated since a lost create response are few, so its thread is on the first page. */
const LABEL_LOOKUP_LIMIT = 100;

export interface AmpCloudAgentOptions {
  /** A personal access token; Amp lets no other credential create threads. */
  apiKey: string;
  /** The project, `namespace/name` or its ID, that new threads start in. */
  project: string;
  /** The workspace's custom domain when it requires one. */
  url?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Amp threads over its v2 HTTP API; wire formats and the token stay inside this adapter.
 * A run is one user message, identified by its position among the thread's user messages.
 */
export class AmpCloudAgentProvider implements CloudAgentProvider {
  private readonly apiKey: string;
  private readonly project: string;
  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: AmpCloudAgentOptions) {
    this.apiKey = options.apiKey.trim();
    this.project = options.project.trim();
    if (!this.apiKey) throw new Error("AMP_API_KEY is required");
    if (!this.project) throw new Error("AMP_PROJECT is required");
    const url = new URL(options.url?.trim() || "https://ampcode.com");
    if (url.protocol !== "https:") throw new Error("AMP_URL must be an https URL");
    this.origin = url.origin;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  describe() {
    return {
      id: "amp",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      // A personal access token cannot stop, archive or delete a thread.
      capabilities: { launch: true, reply: true, cancel: false, offline: false },
    };
  }

  async launch(
    request: CloudAgentLaunchRequest,
    context: AdapterContext,
  ): Promise<CloudAgentHandle> {
    // Amp takes text messages only.
    if (request.images?.length) throw new CloudAgentRequestRejected("invalid");
    const signal = request.signal ?? context.signal;
    // Amp's create takes no idempotency key, so the key travels as a label and a replay finds
    // the thread an earlier attempt created.
    const label = launchLabel(request.idempotencyKey);
    const existing = await this.labeled(label, signal);
    if (existing) return this.snapshot(existing, 1);
    const message = [
      request.prompt,
      ...(request.repository ? [cloudAgentRepositoryPrompt(request.repository)] : []),
      ...(request.openPr ? [CLOUD_AGENT_OPEN_PR] : []),
    ].join("\n\n");
    const parsed = z
      .object({ thread: z.object({ id: z.string().min(1), url: z.string() }) })
      .safeParse(
        await this.request(
          "POST",
          "/api/v2/threads",
          { project: this.project, message, labels: [label] },
          signal,
        ),
      );
    if (!parsed.success) throw new Error("Invalid cloud agent response");
    return {
      id: parsed.data.thread.id,
      title: request.prompt.trim().split("\n", 1)[0]!.trim().slice(0, 80) || "Cloud agent",
      url: parsed.data.thread.url,
      status: "running",
      latestRunId: "1",
    };
  }

  async get(id: string, context: AdapterContext, runId?: string): Promise<CloudAgentSnapshot> {
    const thread = await this.thread(id, context.signal);
    return this.snapshot(thread, runId ? Number(runId) : userMessages(thread));
  }

  async reply(
    id: string,
    request: CloudAgentReplyRequest,
    context: AdapterContext,
  ): Promise<CloudAgentHandle> {
    if (request.images?.length) throw new CloudAgentRequestRejected("invalid");
    const signal = request.signal ?? context.signal;
    // Read first: no fallible call after the send, and a failed read means nothing was sent.
    const thread = await this.thread(id, signal).catch((error) => {
      if (error instanceof CloudAgentRequestRejected || error instanceof CloudAgentRetryLater)
        throw error;
      throw new CloudAgentRetryLater("unavailable");
    });
    if (thread.archived) throw new CloudAgentRequestRejected("expired");
    // A message to a working thread waits in its queue and runs after the current turn.
    await this.request(
      "POST",
      `/api/v2/threads/${encodeURIComponent(id)}/messages`,
      { message: request.prompt },
      signal,
    );
    const run = userMessages(thread) + 1;
    return { ...this.snapshot(thread, run), status: "running" };
  }

  /** Nothing can stop an Amp thread here, so cancel only reports how the run stands. */
  async cancel(id: string, context: AdapterContext, runId?: string): Promise<CloudAgentSnapshot> {
    return this.get(id, context, runId);
  }

  private async thread(id: string, signal: AbortSignal) {
    const parsed = threadSchema.safeParse(
      await this.request(
        "GET",
        `/api/v2/threads/${encodeURIComponent(id)}/metadata`,
        undefined,
        signal,
      ),
    );
    if (!parsed.success || parsed.data.id !== id) throw new Error("Invalid cloud agent response");
    return parsed.data;
  }

  private async labeled(label: string, signal: AbortSignal) {
    const parsed = z
      .object({ threads: z.array(threadSchema) })
      .safeParse(
        await this.request(
          "GET",
          `/api/v2/user/threads?limit=${LABEL_LOOKUP_LIMIT}`,
          undefined,
          signal,
        ),
      );
    if (!parsed.success) throw new Error("Invalid cloud agent response");
    return parsed.data.threads.find((thread) => thread.labels?.includes(label));
  }

  private snapshot(thread: Thread, run: number): CloudAgentSnapshot {
    return {
      id: thread.id,
      title: thread.title || "Cloud agent",
      url: `${this.origin}/threads/${encodeURIComponent(thread.id)}`,
      status: statusOf(thread, run),
      latestRunId: String(run),
    };
  }

  private async request(
    method: string,
    path: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    const boundedSignal = deadlineSignal(this.timeoutMs, signal);
    const response = await this.fetchImpl(`${this.origin}${path}`, {
      method,
      redirect: "error",
      signal: boundedSignal,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      // Error bodies may echo the request; none leave this adapter.
      void bestEffort("cloud agent error body cancel", response.body?.cancel());
      if (response.status === 404) throw new CloudAgentRequestRejected("not_found");
      // Amp refuses messages to an archived thread.
      if (response.status === 409) throw new CloudAgentRequestRejected("expired");
      // 402: the token owner is out of Amp credits, which only they can fix.
      if ([400, 402, 422].includes(response.status)) throw new CloudAgentRequestRejected();
      if (response.status === 401 || response.status === 403)
        throw new CloudAgentRetryLater("credential");
      if (response.status === 429)
        throw new CloudAgentRetryLater(
          "rate_limited",
          parseRetryAfter(response.headers.get("retry-after")),
        );
      throw new Error(`Cloud agent request failed (${response.status})`);
    }
    const bytes = await readBodyCapped(response, 1_000_000, boundedSignal);
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error("Invalid cloud agent response");
    }
  }
}

/** A launched thread always has its first message, even before Amp counts it. */
function userMessages(thread: Thread) {
  return Math.max(1, thread.stats?.userMessageCount ?? 0);
}

/**
 * The thread's agent state is the run's once Amp has recorded the run's message and the agent
 * has reported since the newest one: the state trails the agent by seconds, so an idle state
 * from before a follow-up must not finish it. A newer message, as from a person in Amp, carries
 * on the same work, so the run follows it.
 */
function statusOf(thread: Thread, run: number): CloudAgentStatus {
  const state = thread.agentState;
  const lastMessageAt = Date.parse(thread.stats?.lastUserMessageAt ?? "");
  const current =
    state !== undefined &&
    (thread.stats?.userMessageCount ?? 0) >= run &&
    !(Date.parse(state.updatedAt) < lastMessageAt);
  if (current && state.state === "idle") return "finished";
  if (current && state.state === "error") return "failed";
  return thread.archived ? "expired" : "running";
}

/** Amp labels are lowercase letters, digits and hyphens, at most 32 characters. */
export function launchLabel(key: string) {
  return `rakazo-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
}
