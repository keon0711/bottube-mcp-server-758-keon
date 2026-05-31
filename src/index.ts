#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

type JsonObject = Record<string, unknown>;
type QueryValue = string | number | boolean | undefined | null;

const DEFAULT_BASE_URL = "https://bottube.ai";

function jsonText(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function normalizeTags(tags: string[] | string | undefined): string {
  if (Array.isArray(tags)) {
    return tags.map((tag) => tag.trim()).filter(Boolean).join(",");
  }
  return (tags ?? "").trim();
}

function mimeTypeForPath(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".mp4":
      return "video/mp4";
    case ".webm":
      return "video/webm";
    case ".mov":
      return "video/quicktime";
    case ".mkv":
      return "video/x-matroska";
    case ".avi":
      return "video/x-msvideo";
    case ".gif":
      return "image/gif";
    default:
      return "application/octet-stream";
  }
}

function appendQuery(url: URL, params: Record<string, QueryValue>) {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    url.searchParams.set(key, String(value));
  }
}

export class BoTTubeApiClient {
  readonly baseUrl: string;
  private readonly apiKey?: string;

  constructor(options: { baseUrl?: string; apiKey?: string } = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.BOTTUBE_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.apiKey = options.apiKey ?? process.env.BOTTUBE_API_KEY;
  }

  private url(path: string, params: Record<string, QueryValue> = {}): URL {
    const url = new URL(path, `${this.baseUrl}/`);
    appendQuery(url, params);
    return url;
  }

  private authHeaders(): HeadersInit {
    if (!this.apiKey) {
      throw new Error("BOTTUBE_API_KEY is required for this tool.");
    }
    return {
      Accept: "application/json",
      "X-API-Key": this.apiKey,
    };
  }

  private async parseResponse(response: Response): Promise<unknown> {
    const text = await response.text();
    let body: unknown = text;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text };
      }
    }

    if (!response.ok) {
      const message =
        typeof body === "object" && body !== null && "error" in body
          ? String((body as JsonObject).error)
          : `BoTTube request failed with HTTP ${response.status}`;
      const err = new Error(message);
      (err as Error & { status?: number; body?: unknown }).status = response.status;
      (err as Error & { status?: number; body?: unknown }).body = body;
      throw err;
    }

    return body;
  }

  async get(path: string, params: Record<string, QueryValue> = {}) {
    const response = await fetch(this.url(path, params), {
      headers: { Accept: "application/json" },
    });
    return this.parseResponse(response);
  }

  async postJson(path: string, body: JsonObject, options: { auth?: boolean } = {}) {
    const response = await fetch(this.url(path), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(options.auth ? this.authHeaders() : {}),
      },
      body: JSON.stringify(body),
    });
    return this.parseResponse(response);
  }

  async postMultipart(path: string, form: FormData) {
    const response = await fetch(this.url(path), {
      method: "POST",
      headers: this.authHeaders(),
      body: form,
    });
    return this.parseResponse(response);
  }

  async trending(limit = 10) {
    const data = await this.get("/api/trending", { limit });
    if (
      typeof data === "object" &&
      data !== null &&
      Array.isArray((data as JsonObject).videos)
    ) {
      return {
        ...(data as JsonObject),
        videos: ((data as JsonObject).videos as unknown[]).slice(0, limit),
      };
    }
    return data;
  }

  search(query: string, options: { page?: number; per_page?: number; sort?: string; category?: string } = {}) {
    return this.get("/api/search", {
      q: query,
      page: options.page ?? 1,
      per_page: options.per_page ?? 10,
      sort: options.sort,
      category: options.category,
    });
  }

  async video(videoId: string, includeComments = true) {
    const details = await this.get(`/api/videos/${encodeURIComponent(videoId)}`);
    if (!includeComments) {
      return details;
    }
    const comments = await this.get(`/api/videos/${encodeURIComponent(videoId)}/comments`);
    return { video: details, comments };
  }

  agent(agentName: string) {
    return this.get(`/api/agents/${encodeURIComponent(agentName)}`);
  }

  stats() {
    return this.get("/api/stats");
  }

  register(input: { agent_name: string; display_name?: string; bio?: string; avatar_url?: string }) {
    return this.postJson("/api/register", input);
  }

  async upload(input: {
    file: string;
    title?: string;
    description?: string;
    tags?: string[] | string;
    category?: string;
    scene_description?: string;
    revision_of?: string;
    revision_note?: string;
    challenge_id?: string;
    gen_method?: string;
    response_to?: string;
  }) {
    const bytes = await readFile(input.file);
    const blobBytes = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const form = new FormData();
    form.append("video", new Blob([blobBytes], { type: mimeTypeForPath(input.file) }), basename(input.file));

    const fields: Record<string, string | undefined> = {
      title: input.title,
      description: input.description,
      tags: normalizeTags(input.tags),
      category: input.category,
      scene_description: input.scene_description,
      revision_of: input.revision_of,
      revision_note: input.revision_note,
      challenge_id: input.challenge_id,
      gen_method: input.gen_method,
      response_to: input.response_to,
    };
    for (const [key, value] of Object.entries(fields)) {
      if (value) {
        form.append(key, value);
      }
    }

    return this.postMultipart("/api/upload", form);
  }

  comment(input: { video_id: string; content: string; comment_type?: string; parent_id?: number }) {
    return this.postJson(
      `/api/videos/${encodeURIComponent(input.video_id)}/comment`,
      {
        content: input.content,
        comment_type: input.comment_type ?? "comment",
        parent_id: input.parent_id,
      },
      { auth: true },
    );
  }

  vote(input: { video_id: string; vote: -1 | 0 | 1 }) {
    return this.postJson(
      `/api/videos/${encodeURIComponent(input.video_id)}/vote`,
      { vote: input.vote },
      { auth: true },
    );
  }
}

export function createBoTTubeMcpServer(client = new BoTTubeApiClient()) {
  const server = new McpServer({
    name: "bottube-mcp-server",
    version: "0.1.0",
  });

  server.tool(
    "bottube_trending",
    "Get trending BoTTube videos.",
    {
      limit: z.number().int().min(1).max(50).default(10),
    },
    async ({ limit }) => jsonText(await client.trending(limit)),
  );

  server.tool(
    "bottube_search",
    "Search BoTTube videos.",
    {
      query: z.string().min(1),
      page: z.number().int().min(1).default(1),
      per_page: z.number().int().min(1).max(50).default(10),
      sort: z.enum(["views", "likes", "recent", "trending"]).optional(),
      category: z.string().optional(),
    },
    async ({ query, page, per_page, sort, category }) =>
      jsonText(await client.search(query, { page, per_page, sort, category })),
  );

  server.tool(
    "bottube_video",
    "Get BoTTube video details and optionally comments.",
    {
      video_id: z.string().min(1),
      include_comments: z.boolean().default(true),
    },
    async ({ video_id, include_comments }) => jsonText(await client.video(video_id, include_comments)),
  );

  server.tool(
    "bottube_agent",
    "Get a BoTTube agent profile and recent videos.",
    {
      agent_name: z.string().min(1),
    },
    async ({ agent_name }) => jsonText(await client.agent(agent_name)),
  );

  server.tool("bottube_stats", "Get BoTTube platform statistics.", {}, async () => jsonText(await client.stats()));

  server.tool(
    "bottube_register",
    "Register a new BoTTube agent. Returns an API key; save it immediately.",
    {
      agent_name: z.string().regex(/^[a-z0-9_-]{2,32}$/),
      display_name: z.string().min(1).max(80).optional(),
      bio: z.string().max(500).optional(),
      avatar_url: z.string().url().optional(),
    },
    async (input) => jsonText(await client.register(input)),
  );

  server.tool(
    "bottube_upload",
    "Upload a local video file to BoTTube. Requires BOTTUBE_API_KEY.",
    {
      file: z.string().min(1),
      title: z.string().max(200).optional(),
      description: z.string().max(5000).optional(),
      tags: z.union([z.array(z.string()), z.string()]).optional(),
      category: z.string().optional(),
      scene_description: z.string().max(5000).optional(),
      revision_of: z.string().optional(),
      revision_note: z.string().max(5000).optional(),
      challenge_id: z.string().optional(),
      gen_method: z.string().optional(),
      response_to: z.string().optional(),
    },
    async (input) => jsonText(await client.upload(input)),
  );

  server.tool(
    "bottube_comment",
    "Post a comment on a BoTTube video. Requires BOTTUBE_API_KEY.",
    {
      video_id: z.string().min(1),
      content: z.string().min(1).max(5000),
      comment_type: z.enum(["comment", "question", "answer", "correction", "timestamp"]).default("comment"),
      parent_id: z.number().int().positive().optional(),
    },
    async (input) => jsonText(await client.comment(input)),
  );

  server.tool(
    "bottube_vote",
    "Upvote, downvote, or remove a BoTTube video vote. Requires BOTTUBE_API_KEY.",
    {
      video_id: z.string().min(1),
      vote: z.union([z.literal(1), z.literal(-1), z.literal(0)]),
    },
    async (input) => jsonText(await client.vote(input)),
  );

  return server;
}

async function main() {
  const server = createBoTTubeMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export { mimeTypeForPath, normalizeTags };
