import type { AdapterContext } from "@rakazo/adapter-kit";
import { CloudAgentRequestRejected, CloudAgentRetryLater } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { AMP_ORIGIN, AMP_TOKEN, AmpApiEmulator } from "./amp-api-emulator.test-support.js";
import { AmpCloudAgentProvider, launchLabel } from "./amp-cloud-agent.js";

const context: AdapterContext = {
  operationId: "test",
  traceId: "test",
  spaceId: "test-space",
  userId: "test-user",
  signal: new AbortController().signal,
};

function connect(wire = new AmpApiEmulator()) {
  const provider = new AmpCloudAgentProvider({
    apiKey: AMP_TOKEN,
    project: "example/demo",
    url: AMP_ORIGIN,
    fetch: wire.fetch,
  });
  return { wire, provider };
}

describe("Amp HTTP boundary", () => {
  it("creates one labeled thread in the configured project and finds it after a lost response", async () => {
    const { wire, provider } = connect();
    wire.loseNextCreateResponse = true;
    const request = {
      idempotencyKey: "operation",
      prompt: "Task",
      repository: "https://github.com/example/demo",
      openPr: true,
    };
    await expect(provider.launch(request, context)).rejects.toThrow();
    const recovered = await provider.launch(request, context);
    const creates = wire.requests.filter((request) => request.method === "POST");
    expect(creates).toEqual([
      {
        method: "POST",
        path: "/api/v2/threads",
        body: {
          project: "example/demo",
          message: expect.stringMatching(/^Task\n\n.*https:\/\/github\.com\/example\/demo/s),
          labels: [launchLabel("operation")],
        },
      },
    ]);
    expect(launchLabel("operation")).toMatch(/^[a-z0-9-]{1,32}$/);
    expect(recovered).toMatchObject({ id: [...wire.threads.keys()][0], latestRunId: "1" });
  });
  it("keeps a follow-up running while the agent state predates its message", async () => {
    const { wire, provider } = connect();
    const agent = await provider.launch({ idempotencyKey: "lag", prompt: "Task" }, context);
    expect((await provider.get(agent.id, context, "1")).status).toBe("running");
    wire.complete(agent.id);
    expect((await provider.get(agent.id, context, "1")).status).toBe("finished");
    const followup = await provider.reply(agent.id, { prompt: "Tests" }, context);
    expect(followup.latestRunId).toBe("2");
    // The thread still reports idle from before the follow-up arrived.
    expect(wire.threads.get(agent.id)!.agentState?.state).toBe("idle");
    expect((await provider.get(agent.id, context, "2")).status).toBe("running");
    wire.complete(agent.id);
    expect(await provider.get(agent.id, context)).toMatchObject({
      status: "finished",
      latestRunId: "2",
    });
  });
  it("reports an archived thread as expired and refuses follow-ups without sending", async () => {
    const { wire, provider } = connect();
    const agent = await provider.launch({ idempotencyKey: "archived", prompt: "Task" }, context);
    wire.archive(agent.id);
    expect((await provider.get(agent.id, context, "1")).status).toBe("expired");
    const error = await provider.reply(agent.id, { prompt: "More" }, context).catch((e) => e);
    expect(error).toMatchObject({ name: "CloudAgentRequestRejected", reason: "expired" });
    expect(wire.requests.at(-1)?.method).toBe("GET");
  });
  it("refuses images before any request", async () => {
    const { wire, provider } = connect();
    const images = [{ data: "ZmFrZQ==", mimeType: "image/png" }];
    await expect(
      provider.launch({ idempotencyKey: "image", prompt: "Task", images }, context),
    ).rejects.toMatchObject({ reason: "invalid" });
    expect(wire.requests).toHaveLength(0);
  });
  it.each([
    [400, CloudAgentRequestRejected, { reason: "invalid" }],
    [402, CloudAgentRequestRejected, { reason: "invalid" }],
    [404, CloudAgentRequestRejected, { reason: "not_found" }],
    [409, CloudAgentRequestRejected, { reason: "expired" }],
    [401, CloudAgentRetryLater, { reason: "credential" }],
    [403, CloudAgentRetryLater, { reason: "credential" }],
    [429, CloudAgentRetryLater, { reason: "rate_limited", retryAfterMs: 30_000 }],
  ])("classifies a %s response without exposing its body", async (status, type, fields) => {
    const { wire, provider } = connect();
    const agent = await provider.launch({ idempotencyKey: "classify", prompt: "Task" }, context);
    wire.failNextRequest = status;
    const error = await provider.get(agent.id, context).catch((e) => e);
    expect(error).toBeInstanceOf(type);
    expect(error).toMatchObject(fields);
    expect(String(error)).not.toContain(AMP_TOKEN);
  });
  it("rejects redirects and non-https origins", async () => {
    let redirect: RequestRedirect | undefined;
    const provider = new AmpCloudAgentProvider({
      apiKey: AMP_TOKEN,
      project: "example/demo",
      fetch: async (url, init) => {
        expect(String(url).startsWith("https://ampcode.com/api/v2/threads/")).toBe(true);
        redirect = init?.redirect;
        return new Response(null, { status: 302 });
      },
    });
    await expect(provider.get("T-1", context)).rejects.toThrow();
    expect(redirect).toBe("error");
    expect(
      () => new AmpCloudAgentProvider({ apiKey: "k", project: "p", url: "http://amp.test" }),
    ).toThrow();
  });
});
