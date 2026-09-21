// Static file server plus one JSON endpoint that asks Jev which cell to wall.
// The TypeSafe API key stays here; the browser never sees it.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { TypeSafeClient, APIError, APIConnectionError } from "@typesafe-ai/sdk";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import {
  HINT_LEVELS,
  buildWallQuestions,
  buildWallState,
  legalMoves,
  validateGame,
  wallCandidates,
} from "./public/game.js";

const ROOT = fileURLToPath(new URL("./public/", import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const DEFAULT_MODEL = process.env.TYPESAFE_DEFAULT_MODEL || "jev-latest";
const HAS_KEY = Boolean(process.env.TYPESAFE_API_KEY);
const CLAUDE_DEFAULT_MODEL = process.env.CLAUDE_DEFAULT_MODEL || "claude-haiku-4-5";
const HAS_ANTHROPIC_KEY = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const PROVIDERS = ["typesafe", "claude"];

const client = HAS_KEY ? new TypeSafeClient({ timeout: 15000 }) : null;
// The Anthropic client also resolves an `ant auth login` profile when no env var is set.
const anthropic = new Anthropic({ timeout: 30000, maxRetries: 1 });
const OUTLOOK_LEVELS = ["Lost", "Behind", "Even", "Winning"];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
};

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== "string" && !Buffer.isBuffer(body);
  const payload = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, {
    "content-type": isJson ? MIME[".json"] : headers["content-type"] || "text/plain; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(payload);
}

async function readJson(req, limit = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  let path = decodeURIComponent(url.pathname);
  if (path === "/") path = "/index.html";
  const file = normalize(join(ROOT, path));
  if (!file.startsWith(ROOT)) return send(res, 403, "forbidden");
  try {
    const info = await stat(file);
    if (!info.isFile()) return send(res, 404, "not found");
    const body = await readFile(file);
    send(res, 200, body, { "content-type": MIME[extname(file)] || "application/octet-stream" });
  } catch {
    send(res, 404, "not found");
  }
}

/**
 * POST /api/wall
 * body: { game, hintLevel?, provider?, model? }   provider: "typesafe" (default) | "claude"
 * Returns the wall the model chose plus everything needed to display the decision:
 * the candidate analysis, the exact state and questions sent, answers, usage, timing.
 */
async function handleWall(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch (err) {
    return send(res, 400, { error: `invalid JSON: ${err.message}` });
  }

  let game;
  try {
    game = validateGame(body.game);
  } catch (err) {
    return send(res, 400, { error: err.message });
  }
  const hintLevel = HINT_LEVELS.includes(body.hintLevel) ? body.hintLevel : "analyzed";
  const provider = PROVIDERS.includes(body.provider) ? body.provider : "typesafe";
  const model = typeof body.model === "string" && body.model.trim()
    ? body.model.trim()
    : provider === "claude" ? CLAUDE_DEFAULT_MODEL : DEFAULT_MODEL;

  if (legalMoves(game).length === 0) return send(res, 200, { kind: "trapped" });

  const plan = wallCandidates(game);
  if (plan.candidates.length === 0) return send(res, 200, { kind: "none", plan });

  const state = buildWallState(game, plan, hintLevel);
  const questions = buildWallQuestions(plan, hintLevel);
  const request = { state, questions, model };

  if (plan.candidates.length === 1) {
    const only = plan.candidates[0];
    return send(res, 200, { kind: "forced", wall: only.cell, letter: only.letter, plan, request, provider });
  }

  if (provider === "claude") return askClaude(res, plan, request);

  if (!client) {
    return send(res, 503, {
      error: "TYPESAFE_API_KEY is not set on the server. Export it and restart, or run the mock endpoint (see README).",
    });
  }

  const started = performance.now();
  try {
    const result = await client.systemOne(request);
    const latencyMs = Math.round(performance.now() - started);
    const answer = result.answers.wall;
    const chosen = plan.candidates.find((c) => c.letter === answer.choice);
    if (!chosen) {
      return send(res, 502, { error: `model chose an option that is not a candidate: ${answer.choice}`, request, result });
    }
    return send(res, 200, {
      kind: "model",
      provider: "typesafe",
      wall: chosen.cell,
      letter: chosen.letter,
      plan,
      request,
      answers: result.answers,
      model: result.model,
      usage: result.usage,
      latencyMs,
    });
  } catch (err) {
    const latencyMs = Math.round(performance.now() - started);
    if (err instanceof APIError) return send(res, 502, { error: `TypeSafe API error ${err.status ?? ""}: ${err.message}`, latencyMs });
    if (err instanceof APIConnectionError) return send(res, 502, { error: `could not reach TypeSafe: ${err.message}`, latencyMs });
    return send(res, 500, { error: err.message, latencyMs });
  }
}

/**
 * The same decision through the Claude API, for a speed and behaviour comparison.
 * The state and the per-candidate criteria are the ones built for Jev; Claude gets
 * them as a system prompt plus one user message and must answer with a structured
 * object whose `wall` is one of the candidate letters. No extended thinking, so the
 * measured latency is the model's fastest path.
 */
async function askClaude(res, plan, request) {
  const { state, questions, model } = request;
  const letters = plan.candidates.map((c) => c.letter);
  const Decision = z.object({
    wall: z.enum(letters),
    outlook: z.enum(OUTLOOK_LEVELS),
    // No length constraint here: the API does not enforce string maxLength in
    // structured outputs, so a Zod .max() only fails client-side validation after
    // the model has already answered. The prompt asks for one sentence and the
    // server trims what comes back.
    reason: z.string(),
  });
  const wallQ = questions.wall;
  const system = [
    wallQ.instructions.role,
    wallQ.instructions.goal,
    "Rules of the game: " + state.game_rules,
    "Guidance, in priority order:",
    ...wallQ.instructions.guidance.map((g, i) => `${i + 1}. ${g}`),
    "Answer with the letter of exactly one candidate wall, your outlook for the fence player (Lost, Behind, Even, Winning), and a reason: one short sentence, under 25 words.",
  ].join("\n");
  const user = [
    "Board (" + state.board.legend + "):",
    state.board.map,
    "",
    "Cat: " + JSON.stringify(state.cat),
    "",
    "Candidate walls:",
    ...letters.map((l) => `${l}: ${wallQ.criteria[l]}`),
  ].join("\n");
  const claudeRequest = {
    model,
    max_tokens: 1024,
    system,
    messages: [{ role: "user", content: user }],
    output_config: { format: zodOutputFormat(Decision) },
  };
  const started = performance.now();
  try {
    const message = await anthropic.messages.parse(claudeRequest);
    const latencyMs = Math.round(performance.now() - started);
    if (message.stop_reason === "refusal") return send(res, 502, { error: "Claude refused the request", latencyMs });
    const parsed = message.parsed_output;
    if (!parsed) return send(res, 502, { error: `Claude returned no parseable decision (stop_reason ${message.stop_reason})`, latencyMs });
    const chosen = plan.candidates.find((c) => c.letter === parsed.wall);
    if (!chosen) return send(res, 502, { error: `Claude chose a letter that is not a candidate: ${parsed.wall}`, latencyMs });
    return send(res, 200, {
      kind: "model",
      provider: "claude",
      wall: chosen.cell,
      letter: chosen.letter,
      plan,
      request: { ...request, claude: { system, user, schema: { wall: letters, outlook: OUTLOOK_LEVELS, reason: "string" }, max_tokens: 1024 } },
      answers: {
        wall: { type: "choice", choice: parsed.wall, probabilities: null, confidence: null },
        outlook: { type: "score", level: parsed.outlook, score: OUTLOOK_LEVELS.indexOf(parsed.outlook), probabilities: null, confidence: null },
        reason: parsed.reason.length > 300 ? parsed.reason.slice(0, 297) + "..." : parsed.reason,
      },
      model: message.model,
      usage: { input_tokens: message.usage.input_tokens, output_tokens: message.usage.output_tokens },
      latencyMs,
    });
  } catch (err) {
    const latencyMs = Math.round(performance.now() - started);
    if (err instanceof Anthropic.AuthenticationError) {
      return send(res, 503, { error: "Anthropic credentials missing or invalid. Export ANTHROPIC_API_KEY (or run `ant auth login`) and restart.", latencyMs });
    }
    if (err instanceof Anthropic.RateLimitError) return send(res, 502, { error: `Claude rate limited: ${err.message}`, latencyMs });
    if (err instanceof Anthropic.APIError) return send(res, 502, { error: `Claude API error ${err.status ?? ""}: ${err.message}`, latencyMs });
    return send(res, 500, { error: err.message, latencyMs });
  }
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/api/health") {
      return send(res, 200, {
        ok: true,
        hasKey: HAS_KEY,
        defaultModel: DEFAULT_MODEL,
        baseURL: process.env.TYPESAFE_BASE_URL || "https://api.typesafe.ai",
        claude: {
          hasKey: HAS_ANTHROPIC_KEY,
          defaultModel: CLAUDE_DEFAULT_MODEL,
          baseURL: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
        },
      });
    }
    if (req.method === "POST" && req.url === "/api/wall") return await handleWall(req, res);
    if (req.method === "GET") return await serveStatic(req, res);
    send(res, 405, "method not allowed");
  } catch (err) {
    send(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Chat Noir with Jev: http://localhost:${PORT}`);
  console.log(HAS_KEY ? `TypeSafe key found, model ${DEFAULT_MODEL}` : "TYPESAFE_API_KEY not set: Jev cannot place walls until you export it");
  if (process.env.TYPESAFE_BASE_URL) console.log(`TypeSafe base URL: ${process.env.TYPESAFE_BASE_URL}`);
  console.log(HAS_ANTHROPIC_KEY ? `Anthropic key found, Claude model ${CLAUDE_DEFAULT_MODEL}` : `ANTHROPIC_API_KEY not set: the Claude provider needs it (or an ant auth login profile), model ${CLAUDE_DEFAULT_MODEL}`);
  if (process.env.ANTHROPIC_BASE_URL) console.log(`Anthropic base URL: ${process.env.ANTHROPIC_BASE_URL}`);
});
