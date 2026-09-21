// Chat Noir game engine, shared by the browser UI and the Node server.
// Pure functions over a plain JSON game object so it can travel over HTTP.
//
// Geometry and the cat's behaviour follow Taro Ito's original (gamedesign.jp):
// a square grid of size*size cells where odd rows are shifted half a cell to
// the right, giving every cell six neighbours. Cells on the outer ring are
// "edge" cells; the cat wins on reaching one. Each cell starts blocked with a
// 10% chance, the cat starts at the centre, the fence player moves first.
//
// In this demo the fence player is Jev. Code computes candidate walls and their
// consequences; the model chooses among them.

/** Direction names in the same order as the original game's neighbour table. */
export const DIRS = ["up-right", "right", "down-right", "down-left", "left", "up-left"];

// [dx, dy] per direction, for even and odd rows.
const EVEN = [[0, -1], [1, 0], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
const ODD = [[1, -1], [1, 0], [1, 1], [0, 1], [-1, 0], [0, -1]];

export const SIZES = [11]; // the original desktop board
export const HINT_LEVELS = ["analyzed", "local"];
export const MAX_CANDIDATES = 8;
// Lookahead plies. 1 = one-ply: rank walls by their immediate effect. 2 = two-ply:
// let the cat reply and the fence answer with its best wall, then measure.
// While the cat is still far from the edge a wrong wall costs little and the
// candidate pool is huge, so one-ply is used there and two-ply once the cat is
// within SEARCH_TWO_PLY_WITHIN steps of escaping.
export const SEARCH_TWO_PLY_WITHIN = 3;
export const SEARCH_BEAM = 8;
const LETTERS = "ABCDEFGHIJKLMNOP";

export function idx(size, x, y) {
  return y * size + x;
}

export function xy(size, i) {
  return { x: i % size, y: Math.floor(i / size) };
}

export function isEdge(size, i) {
  const { x, y } = xy(size, i);
  return x === 0 || y === 0 || x === size - 1 || y === size - 1;
}

/** Neighbour index in a direction, or -1 when off the board. */
export function step(size, i, dir) {
  const { x, y } = xy(size, i);
  const [dx, dy] = (y % 2 === 0 ? EVEN : ODD)[dir];
  const nx = x + dx;
  const ny = y + dy;
  if (nx < 0 || ny < 0 || nx >= size || ny >= size) return -1;
  return idx(size, nx, ny);
}

/** All six neighbours as { dir, name, to } with to = -1 off the board. */
export function neighbors(size, i) {
  return DIRS.map((name, dir) => ({ dir, name, to: step(size, i, dir) }));
}

/** Human-readable cell label, 1-based like a board game. */
export function cellLabel(size, i) {
  const { x, y } = xy(size, i);
  return `row ${y + 1}, column ${x + 1}`;
}

/** Rough compass phrase for where `i` lies relative to `from`. */
export function relativeDirection(size, from, i) {
  const a = xy(size, from);
  const b = xy(size, i);
  // Odd rows sit half a cell to the right.
  const ax = a.x + (a.y % 2) * 0.5;
  const bx = b.x + (b.y % 2) * 0.5;
  const dx = bx - ax;
  const dy = b.y - a.y;
  const vert = dy < 0 ? "above" : dy > 0 ? "below" : "";
  const horiz = dx < -0.25 ? "left" : dx > 0.25 ? "right" : "";
  if (vert && horiz) return `${vert} and to the ${horiz} of the cat`;
  if (vert) return `directly ${vert} the cat`;
  if (horiz) return `directly ${horiz} of the cat`;
  return "at the cat";
}

/**
 * Create a new game. Each cell starts blocked with probability wallProb,
 * matching the original's 10% rule. The cat sits at the centre.
 */
export function newGame(size = 11, rng = Math.random, wallProb = 0.1) {
  if (!SIZES.includes(size)) throw new Error(`size must be one of ${SIZES.join(", ")}`);
  const n = size * size;
  const blocked = new Array(n).fill(false);
  for (let i = 0; i < n; i++) if (rng() * 10 < wallProb * 10) blocked[i] = true;
  const cat = Math.floor(n / 2);
  blocked[cat] = false;
  return { size, blocked, cat, turn: 0, status: "playing", catDir: 2 };
}

/** Validate a game object that arrived over the wire. Throws on bad shape. */
export function validateGame(g) {
  if (!g || typeof g !== "object") throw new Error("game must be an object");
  if (!SIZES.includes(g.size)) throw new Error("bad size");
  const n = g.size * g.size;
  if (!Array.isArray(g.blocked) || g.blocked.length !== n) throw new Error("bad blocked array");
  if (!g.blocked.every((b) => typeof b === "boolean")) throw new Error("blocked must be booleans");
  if (!Number.isInteger(g.cat) || g.cat < 0 || g.cat >= n) throw new Error("bad cat index");
  if (g.blocked[g.cat]) throw new Error("cat stands on a blocked cell");
  return { size: g.size, blocked: g.blocked.slice(), cat: g.cat, turn: g.turn | 0, status: "playing", catDir: g.catDir | 0 };
}

/** Free cells the cat could step to right now. */
export function legalMoves(game) {
  return neighbors(game.size, game.cat).filter((n) => n.to >= 0 && !game.blocked[n.to]);
}

/**
 * Breadth-first search over free cells from `from`, treating `extraFree`
 * cells as free. Returns dist array (-1 = unreachable), nearest edge distance
 * (null if none), number of reachable edge cells, and the reachable region size.
 */
export function bfs(game, from, extraFree = []) {
  const { size, blocked } = game;
  const n = size * size;
  const free = (i) => !blocked[i] || extraFree.includes(i);
  const dist = new Array(n).fill(-1);
  const queue = [from];
  dist[from] = 0;
  let head = 0;
  let nearestEdge = null;
  let edgeCount = 0;
  let region = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    region++;
    if (isEdge(size, cur)) {
      edgeCount++;
      if (nearestEdge === null) nearestEdge = dist[cur];
    }
    for (let d = 0; d < 6; d++) {
      const to = step(size, cur, d);
      if (to < 0 || dist[to] >= 0 || !free(to)) continue;
      dist[to] = dist[cur] + 1;
      queue.push(to);
    }
  }
  return { dist, nearestEdge, edgeCount, region };
}

/** Edge cells at exactly the shortest distance: the cat's "shortest exits". */
export function shortestExits(game, search) {
  if (search.nearestEdge === null) return 0;
  let c = 0;
  for (let i = 0; i < game.size * game.size; i++) if (search.dist[i] === search.nearestEdge && isEdge(game.size, i)) c++;
  return c;
}

// ---------------------------------------------------------------------------
// The cat: a port of the original's set_step / walk_out / walk_random.
// ---------------------------------------------------------------------------

/**
 * Decide the cat's move exactly as the original does: if any edge cell is
 * reachable, pick one of the nearest edge cells at random, trace a random
 * shortest path back to the cat, and step along it. Otherwise step to a
 * random free neighbour. Returns { dir, name, to } or null when stuck.
 */
export function catMove(game, rng = Math.random) {
  const { size, cat } = game;
  const moves = legalMoves(game);
  if (moves.length === 0) return null;
  const search = bfs(game, cat);
  if (search.nearestEdge !== null && search.nearestEdge > 0) {
    const min = search.nearestEdge;
    const targets = [];
    for (let i = 0; i < size * size; i++) if (isEdge(size, i) && search.dist[i] === min) targets.push(i);
    let cn = targets[Math.floor(rng() * targets.length)];
    // Walk back downhill until we reach a cell adjacent to the cat (dist 1).
    while (search.dist[cn] > 1) {
      const lower = neighbors(size, cn).filter((n) => n.to >= 0 && search.dist[n.to] >= 0 && search.dist[n.to] < search.dist[cn]);
      cn = lower[Math.floor(rng() * lower.length)].to;
    }
    const m = moves.find((x) => x.to === cn);
    if (m) return m;
  }
  return moves[Math.floor(rng() * moves.length)];
}

/**
 * Move the cat to an adjacent free cell. Returns a new game. As in the
 * original, reaching an edge cell does not end the game by itself: the cat
 * escapes at the start of its next turn (see resolveEscape), after the fence
 * player has placed one more wall.
 */
export function applyCatMove(game, move) {
  if (!legalMoves(game).some((m) => m.to === move.to)) throw new Error("illegal cat move");
  return { ...game, cat: move.to, catDir: move.dir };
}

/**
 * Direction the cat walks off the board from an edge cell, as the original's
 * start_escape picks it: keep the current facing if it already points off the
 * board, otherwise the last direction (in table order) that leads off.
 */
export function escapeDirection(game) {
  const { size, cat, catDir } = game;
  if (step(size, cat, catDir) < 0) return catDir;
  let d = -1;
  for (let k = 0; k < 6; k++) if (step(size, cat, k) < 0) d = k;
  return d;
}

/**
 * At the start of the cat's turn: a cat standing on an edge cell escapes,
 * whatever the walls around it. Mirrors the original's start_cat check.
 */
export function resolveEscape(game) {
  if (game.status === "playing" && isEdge(game.size, game.cat)) {
    return { ...game, status: "escaped", catDir: escapeDirection(game) };
  }
  return game;
}

/** Block a cell. Returns a new game. */
export function applyBlock(game, i) {
  if (game.status !== "playing") throw new Error("game over");
  if (i === game.cat || game.blocked[i]) throw new Error("cell not free");
  const blocked = game.blocked.slice();
  blocked[i] = true;
  return { ...game, blocked, turn: game.turn + 1 };
}

/** After a wall, is the cat already stuck? */
export function resolveTrapped(game) {
  if (game.status === "playing" && legalMoves(game).length === 0) return { ...game, status: "trapped" };
  return game;
}

// ---------------------------------------------------------------------------
// The fence player: candidate walls and their consequences, computed in code.
// ---------------------------------------------------------------------------

/**
 * Distance from every free cell to the nearest free edge cell, over free cells
 * (multi-source BFS from the edge). -1 where no edge is reachable.
 */
export function distanceToEdge(game) {
  const { size, blocked } = game;
  const n = size * size;
  const dist = new Array(n).fill(-1);
  const queue = [];
  for (let i = 0; i < n; i++) if (isEdge(size, i) && !blocked[i]) { dist[i] = 0; queue.push(i); }
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    for (let d = 0; d < 6; d++) {
      const to = step(size, cur, d);
      if (to < 0 || blocked[to] || dist[to] >= 0) continue;
      dist[to] = dist[cur] + 1;
      queue.push(to);
    }
  }
  return dist;
}

// Values of a position for the fence player, used by the lookahead.
const V_TRAPPED = 1000; // the cat has no free neighbour
const V_SEALED = 500;   // the cat has no route to any edge: the fence wins by walling the pocket
const V_LOST = -1;      // the cat stands on an edge cell and walks off next turn

/** Free cells the fence would consider walling: near the cat or on a current shortest route. */
function wallPool(game, here, toEdge, reach) {
  const { size, cat } = game;
  const pool = [];
  for (let c = 0; c < size * size; c++) {
    if (c === cat || game.blocked[c] || here.dist[c] < 1) continue;
    const onRoute = here.nearestEdge !== null && toEdge[c] >= 0 && here.dist[c] + toEdge[c] === here.nearestEdge;
    if (here.dist[c] <= reach || onRoute) pool.push({ cell: c, onRoute });
  }
  return pool;
}

function withWall(game, c) {
  const blocked = game.blocked.slice();
  blocked[c] = true;
  return { ...game, blocked };
}

/** Terminal value of a position after a wall, or null when the game goes on. */
function terminalValue(search) {
  if (search.region === 1) return V_TRAPPED;
  if (search.nearestEdge === null) return V_SEALED;
  if (search.nearestEdge === 1) return V_LOST;
  return null;
}

/**
 * Fence-side value of a position where the fence is to move: the best wall's
 * value, searching `depth` more exchanges (depth 0 is the immediate effect on
 * the cat's shortest escape). Deeper levels expand only the `beam` walls that
 * look best immediately.
 */
function fenceValue(game, depth, reach, beam) {
  const { size, cat } = game;
  if (isEdge(size, cat)) return V_LOST;
  const here = bfs(game, cat);
  if (here.region === 1) return V_TRAPPED;
  if (here.nearestEdge === null) return V_SEALED;
  const toEdge = distanceToEdge(game);
  const pool = wallPool(game, here, toEdge, reach);
  const immediate = pool.map(({ cell }) => {
    const after = withWall(game, cell);
    const s = bfs(after, cat);
    return { after, s, v: terminalValue(s) ?? s.nearestEdge };
  });
  if (depth === 0) return Math.max(-Infinity, ...immediate.map((x) => x.v));
  immediate.sort((a, b) => b.v - a.v);
  let best = -Infinity;
  for (const x of immediate.slice(0, beam)) {
    const v = terminalValue(x.s) ?? catValue(x.after, depth - 1, reach, beam);
    if (v > best) best = v;
  }
  return best;
}

/** Cat-side value: the cat replies with any shortest-route step; take the worst case for the fence. */
function catValue(game, depth, reach, beam) {
  let worst = Infinity;
  for (const reply of catReplies(game)) {
    const v = fenceValue({ ...game, cat: reply }, depth, reach, beam);
    if (v < worst) worst = v;
  }
  return worst === Infinity ? V_TRAPPED : worst;
}

/** The cat's possible replies as the original plays them: any first step of a shortest route. */
function catReplies(game) {
  const { cat } = game;
  const moves = legalMoves(game);
  const s = bfs(game, cat);
  if (s.nearestEdge === null) return moves.map((m) => m.to);
  const toEdge = distanceToEdge(game);
  return moves.filter((m) => toEdge[m.to] === s.nearestEdge - 1).map((m) => m.to);
}

/**
 * Enumerate candidate walls for this turn. The pool is every free cell within
 * `reach` steps of the cat plus every free cell on one of the cat's current
 * shortest routes to the edge (that is where fences get built). Each wall is
 * scored by a two-ply lookahead: the cat answers with any shortest-route step,
 * the fence answers with its best single wall, and the value is the cat's
 * shortest escape after that exchange in the worst case for the fence. The
 * best `k` are kept, then relabelled A, B, C in reading order so the letter
 * carries no ranking hint.
 */
export function wallCandidates(game, k = MAX_CANDIDATES, reach = 3, plies = null, beam = SEARCH_BEAM) {
  const { size, cat } = game;
  const here = bfs(game, cat);
  if (plies === null) plies = here.nearestEdge !== null && here.nearestEdge <= SEARCH_TWO_PLY_WITHIN ? 2 : 1;
  const now = { stepsToEdge: here.nearestEdge, exits: shortestExits(game, here), edgeCells: here.edgeCount, region: here.region };
  const toEdge = distanceToEdge(game);
  const pool = wallPool(game, here, toEdge, reach);
  if (pool.length === 0) return { now, candidates: [] };

  const scored = pool.map(({ cell: c, onRoute }) => {
    const after = withWall(game, c);
    const s = bfs(after, cat);
    const trapsNow = s.region === 1;
    // plies - 2 exchanges remain to be searched after the cat's reply (depth 0 = greedy).
    const value = terminalValue(s) ?? (plies <= 1 ? s.nearestEdge : catValue(after, plies - 2, reach, beam));
    const adjacentWalls = neighbors(size, c).filter((n) => n.to < 0 || game.blocked[n.to]).length;
    return {
      cell: c,
      label: cellLabel(size, c),
      direction: relativeDirection(size, cat, c),
      distanceFromCat: here.dist[c],
      onShortestRoute: onRoute,
      adjacentWalls,
      trapsNow,
      stepsToEdgeAfter: s.nearestEdge,
      exitsAfter: shortestExits(after, s),
      edgeCellsAfter: s.edgeCount,
      regionAfter: s.region,
      lookahead: value,
      plies,
    };
  });
  const inf = (v) => (v === null ? Infinity : v);
  scored.sort(
    (a, b) =>
      b.lookahead - a.lookahead ||
      inf(b.stepsToEdgeAfter) - inf(a.stepsToEdgeAfter) ||
      a.exitsAfter - b.exitsAfter ||
      a.edgeCellsAfter - b.edgeCellsAfter ||
      b.adjacentWalls - a.adjacentWalls,
  );
  const top = scored.slice(0, k);
  top.forEach((c) => { c.codeRank = scored.indexOf(c) + 1; });
  top.sort((a, b) => a.cell - b.cell);
  top.forEach((c, i) => { c.letter = LETTERS[i]; });
  return { now, candidates: top };
}

/** Plain-language reading of a lookahead value, for state and criteria text. */
export function describeLookahead(v) {
  if (v >= V_TRAPPED) return "the cat is trapped";
  if (v >= V_SEALED) return "the cat is sealed off from every edge";
  if (v <= V_LOST) return "the cat reaches the edge and escapes";
  return `the cat's shortest escape is ${v} steps`;
}

/** ASCII map. Odd rows are indented to show the hex offset; marks override cells. */
export function renderMap(game, marks = {}) {
  const { size, blocked, cat } = game;
  const header = "    " + Array.from({ length: size }, (_, c) => String(c + 1).padStart(3)).join("");
  const rows = [];
  for (let y = 0; y < size; y++) {
    let line = `r${String(y + 1).padEnd(3)}` + (y % 2 === 1 ? " " : "");
    for (let x = 0; x < size; x++) {
      const i = idx(size, x, y);
      line += "  " + (marks[i] ?? (i === cat ? "C" : blocked[i] ? "#" : "."));
    }
    rows.push(line);
  }
  return [header, ...rows].join("\n");
}

const RULES =
  "Chat Noir. A cat stands on a hexagonal grid where odd rows are shifted half a cell to the right, so every cell touches six neighbours. " +
  "Each turn you wall one free cell, then the cat moves one cell along its shortest route to the edge of the board. " +
  "The cat wins by reaching any cell on the outer edge: once it stands there it walks off the board on its next turn and nothing can stop it. You win when every cell next to the cat is walled.";

/**
 * Build the state sent to Jev for the wall decision.
 *   analyzed: includes what each wall does to the cat's escape (BFS results)
 *   local:    only geometry: where the wall is relative to the cat and the map
 */
export function buildWallState(game, plan, hintLevel = "analyzed") {
  const { size } = game;
  const marks = {};
  for (const c of plan.candidates) marks[c.cell] = c.letter;
  const candidates = {};
  for (const c of plan.candidates) {
    const e = {
      cell: c.label,
      position: c.direction,
      steps_from_cat: c.distanceFromCat,
      existing_walls_or_board_edge_touching_it: c.adjacentWalls,
    };
    if (hintLevel === "analyzed") {
      e.on_cats_current_shortest_route = c.onShortestRoute;
      e.cat_trapped_immediately = c.trapsNow;
      e.cats_shortest_escape_after_this_wall = c.stepsToEdgeAfter === null ? "no route to any edge" : `${c.stepsToEdgeAfter} steps`;
      e.cats_shortest_exits_after_this_wall = c.exitsAfter;
      e.edge_cells_cat_can_still_reach = c.edgeCellsAfter;
      if (c.plies >= 2) e.after_cat_replies_and_your_best_next_wall = describeLookahead(c.lookahead);
    }
    candidates[c.letter] = e;
  }
  const state = {
    game_rules: RULES,
    board: {
      size: `${size} by ${size}`,
      legend:
        "C is the cat, . is a free cell, # is a wall. Letters mark the candidate cells you may wall this turn. " +
        `Rows are labelled r1..r${size}; the top and bottom rows and the leftmost and rightmost columns are edge cells where the cat escapes.`,
      map: renderMap(game, marks),
    },
    cat: { position: cellLabel(size, game.cat) },
    candidate_walls: candidates,
  };
  if (hintLevel === "analyzed") {
    state.cat.shortest_escape_now = plan.now.stepsToEdge === null ? "no route to any edge" : `${plan.now.stepsToEdge} steps`;
    state.cat.shortest_exits_now = plan.now.exits;
    state.cat.edge_cells_reachable_now = plan.now.edgeCells;
  }
  return state;
}

function describeWall(c, hintLevel) {
  const parts = [`Wall ${c.letter} at ${c.label}, ${c.distanceFromCat} step${c.distanceFromCat === 1 ? "" : "s"} from the cat, ${c.direction}, touching ${c.adjacentWalls} existing wall${c.adjacentWalls === 1 ? "" : "s"} or board edge.`];
  if (hintLevel !== "analyzed") return parts.join(" ");
  if (c.trapsNow) {
    parts.push("This wall leaves the cat no free neighbour: the cat is trapped immediately and you win.");
    return parts.join(" ");
  }
  parts.push(c.onShortestRoute ? "It lies on the cat's current shortest escape route." : "It is not on the cat's current shortest route.");
  if (c.stepsToEdgeAfter === null) parts.push("After it the cat has no route to any edge cell.");
  else {
    parts.push(`After it the cat's shortest escape is ${c.stepsToEdgeAfter} steps with ${c.exitsAfter} shortest exit${c.exitsAfter === 1 ? "" : "s"} and ${c.edgeCellsAfter} edge cells still reachable.`);
    if (c.plies >= 2) parts.push(`Looking one exchange ahead, after the cat's reply and your best next wall, ${describeLookahead(c.lookahead)}.`);
  }
  return parts.join(" ");
}

/** The questions asked over the state: one Choice decides the wall, one Score reads the game. */
export function buildWallQuestions(plan, hintLevel = "analyzed") {
  const criteria = {};
  for (const c of plan.candidates) criteria[c.letter] = describeWall(c, hintLevel);
  const guidance =
    hintLevel === "analyzed"
      ? [
          "If a wall traps the cat immediately, take it.",
          "If a wall leaves the cat no route to any edge cell, take it.",
          "Otherwise, when a one-exchange lookahead is given, prefer the wall whose lookahead is best for you: sealed off beats a long escape, and a longer escape beats a shorter one. A wall after which the cat reaches the edge is a loss.",
          "Then prefer the wall that makes the cat's immediate shortest escape longest, then the one that leaves the fewest shortest exits.",
          "Among similar walls prefer one that touches existing walls or the board edge, so the fence closes into a ring rather than leaving gaps.",
          "Do not spend a wall far from the cat's routes.",
        ]
      : [
          "Read `board.map`. The cat runs toward the nearest edge along free cells.",
          "Wall the cell that stands in front of the cat's most open direction, about two cells ahead of it, so the fence gets built before the cat arrives.",
          "Prefer cells that connect existing walls into a continuous ring around the cat.",
          "Do not wall directly behind the cat or far from its routes.",
        ];
  return {
    wall: {
      type: "choice",
      instructions: {
        role: "You are the fence player trying to trap the cat.",
        task: "Choose which one candidate cell to wall this turn. Candidates are the lettered cells in `board.map`, described in `candidate_walls`.",
        goal: "Enclose the cat so it can never reach an edge cell.",
        guidance,
      },
      criteria,
    },
    outlook: {
      type: "score",
      instructions: "Judging from `board.map` and `candidate_walls` before you place this wall, how is the game going for you, the fence player?",
      criteria: [
        "Lost: the cat is one or two steps from an open edge and no single wall can stop it",
        "Behind: the cat has several open routes and the fence has wide gaps",
        "Even: the cat still has routes but each wall is closing one",
        "Winning: the fence is nearly a closed ring and the cat has one or two moves left",
      ],
    },
  };
}
