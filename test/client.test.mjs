import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BoTTubeApiClient,
  createBoTTubeMcpServer,
  mimeTypeForPath,
  normalizeTags,
} from "../dist/index.js";

function installFetchMock(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = original;
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("normalizes tags for upload form fields", () => {
  assert.equal(normalizeTags([" rustchain ", "", " mcp "]), "rustchain,mcp");
  assert.equal(normalizeTags("rustchain,mcp"), "rustchain,mcp");
});

test("uses expected video MIME types", () => {
  assert.equal(mimeTypeForPath("clip.mp4"), "video/mp4");
  assert.equal(mimeTypeForPath("clip.webm"), "video/webm");
  assert.equal(mimeTypeForPath("clip.unknown"), "application/octet-stream");
});

test("public search request uses BoTTube query parameters", async () => {
  let seenUrl = "";
  const restore = installFetchMock(async (url) => {
    seenUrl = url.toString();
    return jsonResponse({ ok: true, videos: [] });
  });

  try {
    const client = new BoTTubeApiClient({ baseUrl: "https://example.test" });
    await client.search("rustchain", { page: 2, per_page: 5, sort: "recent" });
    assert.equal(seenUrl, "https://example.test/api/search?q=rustchain&page=2&per_page=5&sort=recent");
  } finally {
    restore();
  }
});

test("trending trims results to requested limit", async () => {
  const restore = installFetchMock(async () =>
    jsonResponse({ videos: [{ video_id: "a" }, { video_id: "b" }, { video_id: "c" }] }),
  );

  try {
    const client = new BoTTubeApiClient({ baseUrl: "https://example.test" });
    const result = await client.trending(2);
    assert.equal(result.videos.length, 2);
    assert.deepEqual(result.videos.map((video) => video.video_id), ["a", "b"]);
  } finally {
    restore();
  }
});

test("comment and vote send authenticated JSON requests", async () => {
  const requests = [];
  const restore = installFetchMock(async (url, options = {}) => {
    requests.push({ url: url.toString(), options });
    return jsonResponse({ ok: true });
  });

  try {
    const client = new BoTTubeApiClient({
      baseUrl: "https://example.test",
      apiKey: "bottube_sk_test",
    });
    await client.comment({ video_id: "abc123", content: "Specific useful feedback." });
    await client.vote({ video_id: "abc123", vote: 1 });

    assert.equal(requests[0].url, "https://example.test/api/videos/abc123/comment");
    assert.equal(requests[0].options.method, "POST");
    assert.equal(requests[0].options.headers["X-API-Key"], "bottube_sk_test");
    assert.deepEqual(JSON.parse(requests[0].options.body), {
      content: "Specific useful feedback.",
      comment_type: "comment",
    });

    assert.equal(requests[1].url, "https://example.test/api/videos/abc123/vote");
    assert.deepEqual(JSON.parse(requests[1].options.body), { vote: 1 });
  } finally {
    restore();
  }
});

test("upload sends multipart form with video and metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bottube-mcp-"));
  const file = join(dir, "demo.mp4");
  await writeFile(file, Buffer.from("fake video"));

  let request = null;
  const restore = installFetchMock(async (url, options = {}) => {
    request = { url: url.toString(), options };
    return jsonResponse({ ok: true, video_id: "demo123" }, 201);
  });

  try {
    const client = new BoTTubeApiClient({
      baseUrl: "https://example.test",
      apiKey: "bottube_sk_test",
    });
    await client.upload({
      file,
      title: "MCP Demo",
      description: "Uploaded through MCP",
      tags: ["mcp", "bottube"],
    });

    assert.equal(request.url, "https://example.test/api/upload");
    assert.equal(request.options.method, "POST");
    assert.equal(request.options.headers["X-API-Key"], "bottube_sk_test");
    assert.equal(request.options.body.get("title"), "MCP Demo");
    assert.equal(request.options.body.get("description"), "Uploaded through MCP");
    assert.equal(request.options.body.get("tags"), "mcp,bottube");
    assert.ok(request.options.body.get("video"));
  } finally {
    restore();
  }
});

test("register sends unauthenticated agent creation body", async () => {
  let request = null;
  const restore = installFetchMock(async (url, options = {}) => {
    request = { url: url.toString(), options };
    return jsonResponse({ ok: true, api_key: "bottube_sk_new" }, 201);
  });

  try {
    const client = new BoTTubeApiClient({ baseUrl: "https://example.test" });
    await client.register({
      agent_name: "mcp-demo-agent",
      display_name: "MCP Demo Agent",
      bio: "Demo",
    });

    assert.equal(request.url, "https://example.test/api/register");
    assert.equal(request.options.method, "POST");
    assert.equal(request.options.headers["Content-Type"], "application/json");
    assert.equal(request.options.headers["X-API-Key"], undefined);
    assert.deepEqual(JSON.parse(request.options.body), {
      agent_name: "mcp-demo-agent",
      display_name: "MCP Demo Agent",
      bio: "Demo",
    });
  } finally {
    restore();
  }
});

test("MCP server can be constructed", () => {
  const server = createBoTTubeMcpServer(new BoTTubeApiClient({ baseUrl: "https://example.test" }));
  assert.ok(server);
});
