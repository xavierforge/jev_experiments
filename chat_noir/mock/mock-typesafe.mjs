// A stand-in for api.typesafe.ai (POST /v1/systemone) and for the Anthropic
// Messages API (POST /v1/messages) so the whole demo can be exercised without
// keys. Both decide with a crude heuristic parsed from the criteria text.
// Never use it to judge Jev or Claude.
//
//   node mock/mock-typesafe.mjs            # listens on :8788
//   TYPESAFE_API_KEY=mock TYPESAFE_BASE_URL=http://localhost:8788 \
//   ANTHROPIC_API_KEY=mock ANTHROPIC_BASE_URL=http://localhost:8788 npm start

import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_PORT || 8788);

function softmax(scores, temp = 1) {
  const max = Math.max(...scores);
  const exps = scores.map((s) => Math.exp((s - max) / temp));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

function confidence(probs) {
  // Normalised entropy complement, roughly what a "concentration" measure looks like.
  const n = probs.length;
  if (n <= 1) return 1;
  const h = -probs.reduce((a, p) => (p > 0 ? a + p * Math.log(p) : a), 0);
  return Math.round((1 - h / Math.log(n)) * 1000) / 1000;
}

function scoreCriterion(text) {
  {
    // Fence-player wording (this demo).
    if (/trapped immediately/i.test(text)) return 12;
    if (/no route to any edge/i.test(text)) return 10;
    const look = /one exchange ahead.*?(the cat is trapped|sealed off|reaches the edge and escapes|shortest escape is (\d+) steps)/.exec(text);
    if (look) {
      if (/trapped/.test(look[1])) return 11;
      if (/sealed/.test(look[1])) return 9;
      if (/reaches the edge/.test(look[1])) return -8;
      return Number(look[2]) * 1.3 + (Math.random() - 0.5) * 0.6;
    }
    const escape = /shortest escape is (\d+) steps with (\d+) shortest exit/.exec(text);
    const touching = /touching (\d+) existing wall/.exec(text);
    const fromCat = /(\d+) steps? from the cat/.exec(text);
    let s = 0;
    if (escape) s += Number(escape[1]) * 1.0 - Number(escape[2]) * 0.5;
    if (touching) s += Number(touching[1]) * 0.3;
    if (!escape && fromCat) s -= Math.abs(Number(fromCat[1]) - 2) * 0.8; // local mode: like cells ~2 ahead
    return s + (Math.random() - 0.5) * 0.8;
  }
}

function answerChoice(q) {
  const labels = Object.keys(q.criteria);
  const scores = labels.map((l) => scoreCriterion(String(q.criteria[l] ?? "")));
  const probs = softmax(scores, 1.1).map((p) => Math.round(p * 1000) / 1000);
  const best = probs.indexOf(Math.max(...probs));
  const probabilities = Object.fromEntries(labels.map((l, i) => [l, probs[i]]));
  return { type: "choice", choice: labels[best], probabilities, confidence: confidence(probs) };
}

function answerScore(q) {
  const n = q.criteria.length;
  const centre = Math.random() * (n - 1);
  const raw = q.criteria.map((_, i) => -Math.abs(i - centre) * 1.5);
  const probs = softmax(raw).map((p) => Math.round(p * 1000) / 1000);
  const score = probs.reduce((a, p, i) => a + p * i, 0);
  return {
    type: "score",
    score: Math.round(score * 1000) / 1000,
    legend: Object.fromEntries(q.criteria.map((c, i) => [String(i), c])),
    probabilities: Object.fromEntries(probs.map((p, i) => [String(i), p])),
    confidence: confidence(probs),
  };
}

function answerNoul() {
  return { type: "noul", noul: Math.round(Math.random() * 1000) / 1000 };
}

const server = createServer(async (req, res) => {
  const json = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (!req.headers.authorization?.startsWith("Bearer ") && !req.headers["x-api-key"]) return json(401, { error: "missing credentials" });
  if (req.method === "GET" && req.url === "/v1/models") {
    return json(200, { models: [{ name: "jev-latest", description: "mock", release_date: "2026-01-01" }] });
  }
  if (req.method === "POST" && req.url === "/v1/systemone") {
    let body = "";
    for await (const c of req) body += c;
    let payload;
    try { payload = JSON.parse(body); } catch { return json(422, { error: "bad json" }); }
    if (!payload.questions || !("state" in payload) || !payload.model) return json(422, { error: "missing field" });
    const answers = {};
    for (const [id, q] of Object.entries(payload.questions)) {
      if (q.type === "choice") answers[id] = answerChoice(q);
      else if (q.type === "score") answers[id] = answerScore(q);
      else if (q.type === "noul") answers[id] = answerNoul();
      else return json(422, { error: `unknown question type ${q.type}` });
    }
    const inputTokens = Math.ceil(body.length / 4);
    await new Promise((r) => setTimeout(r, 90 + Math.random() * 220));
    return json(200, { model: "mock-jev-0.0", answers, usage: { input_tokens: inputTokens, output_tokens: 40 } });
  }
  if (req.method === "POST" && req.url === "/v1/messages") {
    let body = "";
    for await (const c of req) body += c;
    let payload;
    try { payload = JSON.parse(body); } catch { return json(400, { type: "error", error: { type: "invalid_request_error", message: "bad json" } }); }
    // Parse the candidate lines out of the user message and pick like the Jev mock does.
    const text = typeof payload.messages?.[0]?.content === "string" ? payload.messages[0].content : "";
    const lines = text.split("\n").filter((l) => /^[A-P]: /.test(l));
    const letters = lines.map((l) => l[0]);
    const scores = lines.map((l) => scoreCriterion(l.slice(3)));
    const best = letters.length ? letters[scores.indexOf(Math.max(...scores))] : "A";
    const decision = { wall: best, outlook: ["Lost", "Behind", "Even", "Winning"][Math.floor(Math.random() * 4)], reason: "Mock pick from the criteria text; not a real model judgment." };
    await new Promise((r) => setTimeout(r, 250 + Math.random() * 500));
    return json(200, {
      id: "msg_mock", type: "message", role: "assistant", model: "mock-claude-0.0",
      content: [{ type: "text", text: JSON.stringify(decision) }],
      stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: Math.ceil(body.length / 4), output_tokens: 40 },
    });
  }
  json(404, { error: "not found" });
});

server.listen(PORT, () => console.log(`mock TypeSafe endpoint on http://localhost:${PORT} (heuristic answers, not Jev)`));
