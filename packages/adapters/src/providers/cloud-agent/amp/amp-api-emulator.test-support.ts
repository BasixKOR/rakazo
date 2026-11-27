export const AMP_TOKEN = "fake-amp-token";
export const AMP_ORIGIN = "https://amp.example.test";

interface WireThread {
  id: string;
  labels: string[];
  archived: boolean;
  userMessageCount: number;
  lastUserMessageAt: string;
  /** Messages posted while the agent works, delivered when its turn ends. */
  queued: number;
  agentState?: { state: string; updatedAt: string };
  /** The agent reports its state on the next read, as Amp's state trails the agent. */
  reportsWorking: boolean;
  updatedAt: string;
}

/**
 * In-process Amp v2 threads API: create, metadata, follow-up messages queued behind a working
 * turn, label lookup, an agent state that trails the agent, and documented error statuses.
 */
export class AmpApiEmulator {
  readonly threads = new Map<string, WireThread>();
  readonly requests: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  loseNextCreateResponse = false;
  failNextRequest: number | undefined;
  private tick = 0;

  readonly fetch: typeof fetch = async (input, init) => {
    init?.signal?.throwIfAborted();
    const url = new URL(String(input));
    if (url.origin !== AMP_ORIGIN) throw new Error("Unexpected emulator origin");
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${AMP_TOKEN}`)
      return error(401);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.requests.push({ method, path: `${url.pathname}${url.search}`, body });
    if (this.failNextRequest) {
      const status = this.failNextRequest;
      this.failNextRequest = undefined;
      return new Response(`${AMP_TOKEN} must never be exposed`, {
        status,
        headers: status === 429 ? { "Retry-After": "30" } : {},
      });
    }
    if (url.pathname === "/api/v2/threads" && method === "POST") {
      if (!body?.project || !body.message) return error(400);
      const now = this.now();
      const thread: WireThread = {
        id: `T-${String(this.threads.size + 1).padStart(8, "0")}`,
        labels: body.labels ?? [],
        archived: false,
        userMessageCount: 1,
        lastUserMessageAt: now,
        queued: 0,
        reportsWorking: true,
        updatedAt: now,
      };
      this.threads.set(thread.id, thread);
      if (this.loseNextCreateResponse) {
        this.loseNextCreateResponse = false;
        throw new Error("Connection lost after create");
      }
      return Response.json(
        {
          thread: { id: thread.id, url: `${AMP_ORIGIN}/threads/${thread.id}`, agentMode: "smart" },
        },
        { status: 201 },
      );
    }
    if (url.pathname === "/api/v2/user/threads" && method === "GET") {
      const threads = [...this.threads.values()]
        .filter((thread) => !thread.archived)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, Number(url.searchParams.get("limit") ?? 50))
        .map((thread) => this.json(thread));
      return Response.json({ threads });
    }
    const match = /^\/api\/v2\/threads\/([^/]+)\/(metadata|messages)$/.exec(url.pathname);
    const thread = match && this.threads.get(decodeURIComponent(match[1]!));
    if (!match || !thread) return error(404);
    if (match[2] === "metadata" && method === "GET") {
      const response = Response.json(this.json(thread));
      if (thread.reportsWorking) {
        thread.reportsWorking = false;
        thread.agentState = { state: "working", updatedAt: this.now() };
      }
      return response;
    }
    if (match[2] === "messages" && method === "POST") {
      if (thread.archived) return error(409);
      if (!body?.message) return error(400);
      if (thread.agentState?.state === "idle") this.deliver(thread);
      else thread.queued += 1;
      return Response.json(
        {
          thread: { id: thread.id, url: `${AMP_ORIGIN}/threads/${thread.id}` },
          messageID: `message-${this.tick}`,
        },
        { status: 202 },
      );
    }
    return error(404);
  };

  /** End the agent's turn; a queued message starts the next unless the turn failed. */
  complete(id: string, state: "idle" | "error" = "idle") {
    const thread = this.threads.get(id)!;
    if (state === "idle" && thread.queued > 0) {
      thread.queued -= 1;
      this.deliver(thread);
      return;
    }
    thread.reportsWorking = false;
    thread.agentState = { state, updatedAt: this.now() };
    thread.updatedAt = thread.agentState.updatedAt;
  }

  archive(id: string) {
    this.threads.get(id)!.archived = true;
  }

  private deliver(thread: WireThread) {
    thread.userMessageCount += 1;
    thread.lastUserMessageAt = this.now();
    thread.updatedAt = thread.lastUserMessageAt;
    thread.reportsWorking = true;
  }

  private json(thread: WireThread) {
    return {
      id: thread.id,
      creatorUserID: "user-1",
      title: "Emulated thread",
      archived: thread.archived,
      labels: thread.labels,
      ...(thread.agentState ? { agentState: thread.agentState } : {}),
      stats: {
        messageCount: thread.userMessageCount * 2,
        userMessageCount: thread.userMessageCount,
        lastUserMessageAt: thread.lastUserMessageAt,
      },
      updatedAt: thread.updatedAt,
    };
  }

  /** A clock that moves on every event, so ordering never rests on equal timestamps. */
  private now() {
    return new Date(Date.UTC(2026, 0, 1) + ++this.tick * 1_000).toISOString();
  }
}

function error(status: number) {
  return Response.json({ error: `status ${status}` }, { status });
}
