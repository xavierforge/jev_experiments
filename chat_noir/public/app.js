import {
  applyBlock,
  applyCatMove,
  bfs,
  catMove,
  cellLabel,
  isEdge,
  newGame,
  resolveEscape,
  resolveTrapped,
  xy,
} from "/game.js";

const $ = (id) => document.getElementById(id);
const els = {
  board: $("board"), cells: $("cells"), cat: $("cat"), overlay: $("overlay"), status: $("status"), error: $("error"), health: $("health"),
  stepBtn: $("stepBtn"), auto: $("auto"), newGame: $("newGame"), hint: $("hint"), provider: $("provider"), model: $("model"), showCands: $("showCands"),
  decision: $("decision"), outlook: $("outlook"), turnLabel: $("turnLabel"), decisionTitle: $("decisionTitle"), byline: $("byline"), outlookNote: $("outlookNote"),
  latModel: $("latModel"), latMean: $("latMean"), latRange: $("latRange"), latChart: $("latChart"),
  history: $("history").querySelector("tbody"),
  rawState: $("rawState"), rawQuestions: $("rawQuestions"), rawAnswers: $("rawAnswers"),
};

// Original geometry: 68 x 52 cell pitch, 64 px discs, odd rows shifted half a cell.
const CW = 68, CH = 52, R = 31, PAD = 6;
const ARROW = { "up-right": "↗", right: "→", "down-right": "↘", "down-left": "↙", left: "←", "up-left": "↖" };
const BOARD_SIZE = 11;
const PROVIDER_DEFAULT_MODEL = { typesafe: "jev-latest", claude: "claude-haiku-4-5" };
const PROVIDER_NAME = { typesafe: "Jev", claude: "Claude" };
let health = null;
// The cat is one silhouette that slides between cells with a CSS transition.
// It faces the direction of its last move; these directions face left.
const FACING_LEFT = new Set([3, 4, 5]); // down-left, left, up-left
// Pixel offset of one step per direction, used to walk the cat off the board.
const STEP_PX = [[CW / 2, -CH], [CW, 0], [CW / 2, CH], [-CW / 2, CH], [-CW, 0], [-CW / 2, -CH]];

let game = null;
let busy = false;
let lastWall = -1;
let lastPlan = null;      // { candidates, probs, chosenLetter }
let history = [];
let totalTokens = 0;
let autoTimer = null;

function loadPref(key, fallback) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } }
function savePref(key, value) { try { localStorage.setItem(key, value); } catch { /* ignore */ } }

// ---------- board ----------
function center(size, i) {
  const { x, y } = xy(size, i);
  return { cx: PAD + x * CW + CW / 2 + (y % 2 ? CW / 2 : 0), cy: PAD + y * CH + CH / 2 };
}

function renderBoard() {
  const { size } = game;
  const width = PAD * 2 + CW * size + CW / 2;
  const height = PAD * 2 + CH * size;
  els.board.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const parts = [];
  for (let i = 0; i < size * size; i++) {
    const { cx, cy } = center(size, i);
    const cls = ["cell", game.blocked[i] ? "wall" : "free"];
    if (i === lastWall) cls.push("last");
    if (i === game.cat && game.status !== "escaped") cls.push("catcell");
    parts.push(`<circle class="${cls.join(" ")}" cx="${cx}" cy="${cy}" r="${R}"><title>${cellLabel(size, i)}</title></circle>`);
  }
  if (lastPlan && els.showCands.checked && game.status === "playing") {
    for (const c of lastPlan.candidates) {
      if (game.blocked[c.cell] || c.cell === game.cat) continue;
      const { cx, cy } = center(size, c.cell);
      const p = lastPlan.probs ? lastPlan.probs[c.letter] : null;
      parts.push(`<circle class="cand-ring" cx="${cx}" cy="${cy}" r="${R - 3}"/>`);
      parts.push(`<text class="cand-text" x="${cx}" y="${cy + (p == null ? 5 : -1)}">${c.letter}</text>`);
      if (p != null) parts.push(`<text class="cand-pct" x="${cx}" y="${cy + 12}">${Math.round(p * 100)}%</text>`);
    }
  }
  els.cells.innerHTML = parts.join("");

  let { cx, cy } = center(size, game.cat);
  const escaping = game.status === "escaped";
  if (escaping) {
    const [dx, dy] = STEP_PX[game.catDir];
    cx += dx * 1.6;
    cy += dy * 1.6;
  }
  const flip = FACING_LEFT.has(game.catDir) ? " scale(-1,1)" : "";
  els.cat.style.transitionDuration = escaping ? ".9s" : ".3s";
  els.cat.style.opacity = escaping ? "0" : "1";
  els.cat.style.transform = `translate(${cx}px, ${cy}px)${flip}`;
}


function setStatus(text) { els.status.textContent = text; }
function showError(msg) {
  els.error.innerHTML = "";
  els.error.append(msg);
  const b = document.createElement("button");
  b.textContent = "Retry";
  b.onclick = () => { hideError(); takeTurn(); };
  els.error.append(b);
  els.error.classList.remove("hidden");
}
function hideError() { els.error.classList.add("hidden"); }

function endGame() {
  const won = game.status === "trapped";
  const who = PROVIDER_NAME[els.provider.value] ?? "The model";
  els.overlay.textContent = won ? `Trapped. ${who} wins.` : "The cat escaped.";
  els.overlay.classList.remove("hidden");
  setStatus(won ? `${who} enclosed the cat in ${game.turn} walls.` : `The cat walked off the board from ${cellLabel(game.size, game.cat)} after ${game.turn} walls.`);
  els.stepBtn.disabled = true;
  stopAuto();
}

// ---------- panels ----------
function fmtPct(p) { return `${(p * 100).toFixed(1)}%`; }
function escapeText(c) {
  if (c.trapsNow) return "traps the cat now";
  if (c.stepsToEdgeAfter === null) return "cat left with no route";
  return `cat's escape becomes ${c.stepsToEdgeAfter} steps · ${c.exitsAfter} exit${c.exitsAfter === 1 ? "" : "s"} · ${c.edgeCellsAfter} edge cells`;
}

function renderDecision(res) {
  els.turnLabel.textContent = `wall ${game.turn}`;
  const byLetter = Object.fromEntries(res.plan.candidates.map((c) => [c.letter, c]));

  if (res.kind === "forced") {
    const c = byLetter[res.letter];
    els.decision.innerHTML = `<div class="chosen"><b>${c.letter} · ${c.label}</b><span class="tag">only candidate, no model call</span></div>
      <p class="muted small">${escapeText(c)}</p>`;
    els.outlook.innerHTML = `<p class="muted">–</p>`;
    return;
  }

  const ans = res.answers.wall;
  if (res.provider === "claude") return renderClaudeDecision(res, byLetter);
  const rows = Object.keys(ans.probabilities)
    .sort((a, b) => ans.probabilities[b] - ans.probabilities[a])
    .map((l) => {
      const p = ans.probabilities[l];
      const win = l === ans.choice;
      const c = byLetter[l];
      return `<div class="k ${win ? "win" : ""}">${l} · ${c ? c.label.replace("row ", "r").replace(", column ", "c") : ""}</div>
        <div class="track"><div class="fill ${win ? "win" : ""}" style="width:${(p * 100).toFixed(1)}%"></div></div>
        <div class="v">${fmtPct(p)}</div>
        <div class="feat">${c ? `code rank #${c.codeRank} · ${escapeText(c)}` : ""}</div>`;
    })
    .join("");
  const chosen = byLetter[ans.choice];
  els.decision.innerHTML = `
    <div class="chosen"><b>${ans.choice} · ${chosen.label}</b>
      <span class="conf">confidence ${fmtPct(ans.confidence)}</span>
      <span class="tag">${res.request.model} → ${res.model}</span>
      <span class="tag">${els.hint.value} hints</span></div>
    <div class="bars">${rows}</div>`;

  const out = res.answers.outlook;
  if (out) {
    const names = ["Lost", "Behind", "Even", "Winning"];
    const lv = names.map((n, i) => {
      const p = out.probabilities[String(i)] ?? 0;
      return `<div class="lvl"><div>${n}</div><div class="p">${fmtPct(p)}</div><div class="f" style="width:${(p * 100).toFixed(0)}%"></div></div>`;
    }).join("");
    const now = res.plan.now;
    const truth = now.stepsToEdge === null
      ? "Code says: the cat already has no route to any edge."
      : `Code says: before this wall the cat's shortest escape was ${now.stepsToEdge} step${now.stepsToEdge === 1 ? "" : "s"} with ${now.exits} shortest exit${now.exits === 1 ? "" : "s"}.`;
    els.outlook.innerHTML = `<div class="levels">${lv}</div>
      <div class="truth">Expected level ${out.score.toFixed(2)} of 3, confidence ${fmtPct(out.confidence)}. ${truth}</div>`;
  }
}

function renderClaudeDecision(res, byLetter) {
  const ans = res.answers.wall;
  const chosen = byLetter[ans.choice];
  const rows = res.plan.candidates
    .slice()
    .sort((a, b) => a.codeRank - b.codeRank)
    .map((c) => {
      const win = c.letter === ans.choice;
      return `<div class="k ${win ? "win" : ""}">${c.letter} · ${c.label.replace("row ", "r").replace(", column ", "c")}</div>
        <div class="track"><div class="fill ${win ? "win" : ""}" style="width:${win ? 100 : 0}%"></div></div>
        <div class="v">${win ? "chosen" : ""}</div>
        <div class="feat">code rank #${c.codeRank} · ${escapeText(c)}</div>`;
    })
    .join("");
  els.decision.innerHTML = `
    <div class="chosen"><b>${ans.choice} · ${chosen.label}</b>
      <span class="tag">${res.request.model} → ${res.model}</span>
      <span class="tag">${els.hint.value} hints</span>
      <span class="tag">${res.usage.input_tokens} in / ${res.usage.output_tokens} out tokens</span></div>
    <p class="reason">“${res.answers.reason}”</p>
    <div class="bars">${rows}</div>
    <p class="muted small">Claude returns one choice, not a probability distribution, so there are no bars to compare. Candidates are listed in the code's rank order.</p>`;
  const level = res.answers.outlook.level;
  const names = ["Lost", "Behind", "Even", "Winning"];
  const now = res.plan.now;
  const truth = now.stepsToEdge === null
    ? "Code says: the cat already has no route to any edge."
    : `Code says: before this wall the cat's shortest escape was ${now.stepsToEdge} step${now.stepsToEdge === 1 ? "" : "s"} with ${now.exits} shortest exit${now.exits === 1 ? "" : "s"}.`;
  els.outlook.innerHTML = `<div class="levels">${names.map((n) => `<div class="lvl ${n === level ? "picked" : ""}"><div>${n}</div><div class="p">${n === level ? "picked" : ""}</div></div>`).join("")}</div>
    <div class="truth">${truth}</div>`;
}

function renderTiming(res, tripMs) {
  if (res.kind !== "model") return;
  const rows = history.filter((h) => h.latencyMs != null);
  const lats = rows.map((h) => h.latencyMs);
  const mean = lats.reduce((a, b) => a + b, 0) / lats.length;
  els.latModel.textContent = res.latencyMs;
  els.latMean.textContent = Math.round(mean);
  els.latRange.textContent = `${Math.min(...lats)} / ${Math.max(...lats)}`;
  totalTokens += res.usage.input_tokens;

  const max = Math.max(...lats, 1);
  const n = lats.length;
  const bw = Math.max(2, Math.min(24, 300 / n - 2));
  const bars = lats.map((v, i) => {
    const h = Math.max(1, (v / max) * 60);
    return `<rect class="${i === n - 1 ? "last" : ""}" x="${10 + i * (bw + 2)}" y="${70 - h}" width="${bw}" height="${h}"><title>wall ${rows[i].turn}: ${v} ms</title></rect>`;
  }).join("");
  els.latChart.innerHTML = `${bars}<text x="4" y="10">${max} ms</text>`;
}

function renderHistory() {
  els.history.innerHTML = history.slice().reverse().map((h) => `<tr>
    <td>${h.turn}</td><td>${h.wall}</td><td>${h.cat}</td><td>${h.model ?? ""}</td>
    <td class="num">${h.p == null ? "–" : fmtPct(h.p)}</td><td class="num">${h.conf == null ? "–" : fmtPct(h.conf)}</td>
    <td class="num">${h.latencyMs ?? (h.kind === "forced" ? "forced" : "–")}</td></tr>`).join("");
}

function renderRaw(res) {
  els.rawState.textContent = JSON.stringify(res.request.state, null, 2);
  els.rawQuestions.textContent = res.request.claude
    ? `SYSTEM:\n${res.request.claude.system}\n\nUSER:\n${res.request.claude.user}\n\nOUTPUT SCHEMA: ${JSON.stringify(res.request.claude.schema)}  max_tokens: ${res.request.claude.max_tokens}\n\n(built from the same Jev questions below)\n${JSON.stringify(res.request.questions, null, 2)}`
    : JSON.stringify(res.request.questions, null, 2);
  els.rawAnswers.textContent = res.answers
    ? JSON.stringify({ model: res.model, answers: res.answers, usage: res.usage, model_latency_ms: res.latencyMs, browser_round_trip_ms: Math.round(res.tripMs), input_tokens_total: totalTokens }, null, 2)
    : "(only one candidate, no request sent)";
}

// ---------- flow ----------
function startGame() {
  stopAuto();
  game = newGame(BOARD_SIZE);
  els.cat.style.transitionDuration = "0s";
  busy = false;
  lastWall = -1;
  lastPlan = null;
  history = [];
  totalTokens = 0;
  els.overlay.classList.add("hidden");
  els.stepBtn.disabled = false;
  hideError();
  els.decision.innerHTML = `<p class="muted">No wall placed yet.</p>`;
  els.outlook.innerHTML = `<p class="muted">–</p>`;
  els.turnLabel.textContent = "";
  for (const k of ["latModel", "latMean", "latRange"]) els[k].textContent = "–";
  els.latChart.innerHTML = "";
  renderHistory();
  renderBoard();
  setStatus(`Press Step. ${PROVIDER_NAME[els.provider.value] ?? "The model"} walls one cell, then the cat runs.`);
  if (els.auto.checked) scheduleAuto(300);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One full turn: Jev walls a cell, then the cat moves. */
async function takeTurn() {
  if (busy || !game || game.status !== "playing") return;
  busy = true;
  els.stepBtn.disabled = true;
  hideError();
  setStatus(`Asking ${PROVIDER_NAME[els.provider.value] ?? "the model"} which cell to wall…`);
  const t0 = performance.now();
  let res;
  try {
    const r = await fetch("/api/wall", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ game, hintLevel: els.hint.value, provider: els.provider.value, model: els.model.value }),
    });
    res = await r.json();
    if (!r.ok) throw new Error(res.error || `HTTP ${r.status}`);
  } catch (err) {
    busy = false;
    els.stepBtn.disabled = false;
    setStatus("Jev could not answer.");
    showError(`Wall decision failed: ${err.message}`);
    stopAuto();
    return;
  }
  const tripMs = performance.now() - t0;

  if (res.kind === "trapped" || res.kind === "none") {
    game = resolveTrapped(game);
    if (game.status === "playing") game = { ...game, status: "trapped" };
    renderBoard();
    busy = false;
    endGame();
    return;
  }

  // Jev's wall.
  game = applyBlock(game, res.wall);
  lastWall = res.wall;
  lastPlan = {
    candidates: res.plan.candidates,
    probs: res.kind === "model" ? res.answers.wall.probabilities : null,
    chosenLetter: res.letter,
  };
  const who = PROVIDER_NAME[res.provider] ?? "Model";
  els.decisionTitle.textContent = `${who}'s decision`;
  const entry = { turn: game.turn, wall: `${res.letter} · ${cellLabel(game.size, res.wall)}`, cat: "", kind: res.kind };
  if (res.kind === "model") {
    entry.model = res.model;
    entry.p = res.answers.wall.probabilities ? res.answers.wall.probabilities[res.letter] : null;
    entry.conf = res.answers.wall.confidence;
    entry.latencyMs = res.latencyMs;
  }
  history.push(entry);
  res.tripMs = tripMs;
  renderDecision(res);
  renderTiming(res, tripMs);
  renderRaw(res);
  renderBoard();

  setStatus(`${who} walled ${cellLabel(game.size, res.wall)}${res.kind === "model" ? ` (${entry.p == null ? "" : fmtPct(entry.p) + ", "}${res.latencyMs} ms)` : ""}. The cat's turn…`);
  await sleep(380);

  // The cat's turn, in the original's order: on an edge cell it walks off the
  // board whatever the walls; with no free neighbour it is trapped; else it moves.
  game = resolveEscape(game);
  if (game.status === "escaped") {
    entry.cat = "walked off the board";
    renderHistory();
    renderBoard();
    await sleep(950);
    busy = false;
    return endGame();
  }
  game = resolveTrapped(game);
  if (game.status === "trapped") {
    entry.cat = "trapped";
    renderHistory();
    busy = false;
    endGame();
    return;
  }
  const move = catMove(game);
  game = applyCatMove(game, move);
  entry.cat = `${ARROW[move.name]} ${move.name}`;
  renderHistory();
  renderBoard();
  await sleep(320);
  busy = false;

  if (isEdge(game.size, game.cat)) {
    setStatus(`Cat moved ${move.name} onto the edge. It walks off the board next turn, whatever Jev walls.`);
  } else {
    const escape = bfs(game, game.cat).nearestEdge;
    setStatus(`Cat moved ${move.name}. ${escape === null ? "It has no route left." : `Its shortest escape is ${escape} step${escape === 1 ? "" : "s"}.`}`);
  }
  els.stepBtn.disabled = false;
  if (els.auto.checked) scheduleAuto(600);
}

function scheduleAuto(ms) {
  stopAuto();
  autoTimer = setTimeout(() => { autoTimer = null; if (els.auto.checked) takeTurn(); }, ms);
}
function stopAuto() { if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; } }

// ---------- wiring ----------
els.stepBtn.addEventListener("click", takeTurn);
els.newGame.addEventListener("click", startGame);
els.auto.addEventListener("change", () => {
  savePref("auto", els.auto.checked ? "1" : "0");
  if (els.auto.checked) { if (!busy && game && game.status === "playing") scheduleAuto(200); }
  else stopAuto();
});
els.hint.addEventListener("change", () => savePref("hint", els.hint.value));
els.model.addEventListener("change", () => savePref(`model.${els.provider.value}`, els.model.value));
function applyProvider() {
  const p = els.provider.value;
  els.model.value = loadPref(`model.${p}`, PROVIDER_DEFAULT_MODEL[p]);
  els.byline.textContent = p === "claude" ? "Claude plays the fence" : "TypeSafe Jev plays the fence";
  els.outlookNote.textContent = p === "claude" ? "one level picked in the same structured answer" : "speculative Score question in the same request";
  renderHealth();
}
els.provider.addEventListener("change", () => { savePref("provider", els.provider.value); applyProvider(); if (game && game.turn === 0) startGame(); });

function renderHealth() {
  if (!health) return;
  const p = els.provider.value;
  const h = p === "claude" ? health.claude : health;
  const via = h.baseURL.includes("anthropic.com") || h.baseURL.includes("typesafe.ai") ? "" : " via " + h.baseURL;
  if (h.hasKey) { els.health.textContent = `${h.defaultModel}${via}`; els.health.className = "health ok"; }
  else { els.health.textContent = p === "claude" ? "ANTHROPIC_API_KEY not set" : "TYPESAFE_API_KEY not set"; els.health.className = "health bad"; }
}
els.showCands.addEventListener("change", () => { savePref("showCands", els.showCands.checked ? "1" : "0"); if (game) renderBoard(); });

els.hint.value = loadPref("hint", "analyzed");
els.provider.value = loadPref("provider", "typesafe");
applyProvider();
els.showCands.checked = loadPref("showCands", "1") === "1";
els.auto.checked = loadPref("auto", "0") === "1";

fetch("/api/health").then((r) => r.json()).then((h) => {
  health = h;
  renderHealth();
}).catch(() => {
  els.health.textContent = "server unreachable";
  els.health.className = "health bad";
});

startGame();
