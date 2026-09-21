import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DIRS,
  applyBlock,
  applyCatMove,
  bfs,
  buildWallQuestions,
  buildWallState,
  catMove,
  distanceToEdge,
  escapeDirection,
  idx,
  isEdge,
  legalMoves,
  neighbors,
  newGame,
  relativeDirection,
  renderMap,
  resolveEscape,
  resolveTrapped,
  step,
  validateGame,
  wallCandidates,
} from "../public/game.js";

const SIZE = 11;
const empty = () => newGame(SIZE, () => 1); // rng of 1 never places a wall
const seeded = (seed) => () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };

test("every on-board neighbour relation is symmetric", () => {
  for (let i = 0; i < SIZE * SIZE; i++) {
    for (let d = 0; d < 6; d++) {
      const j = step(SIZE, i, d);
      if (j < 0) continue;
      assert.ok(neighbors(SIZE, j).some((n) => n.to === i), `cell ${i} dir ${DIRS[d]} -> ${j} has no way back`);
    }
  }
});

test("edge cells are exactly the outer ring", () => {
  let count = 0;
  for (let i = 0; i < SIZE * SIZE; i++) if (isEdge(SIZE, i)) count++;
  assert.equal(count, 4 * SIZE - 4);
});

test("new game is 11 by 11 with the cat in the centre on a free cell", () => {
  const g = newGame(SIZE, () => 0); // every other cell becomes a wall
  assert.equal(g.cat, 60);
  assert.equal(g.blocked[g.cat], false);
  assert.equal(g.blocked.filter(Boolean).length, 120);
  assert.throws(() => newGame(9), /size must be/);
});

test("bfs from the centre of an empty board reaches the edge in 5 steps", () => {
  const g = empty();
  const s = bfs(g, g.cat);
  assert.equal(s.nearestEdge, 5);
  assert.equal(s.edgeCount, 4 * SIZE - 4);
});

test("the cat follows a shortest route, reaches the edge in 5 moves, and escapes only at its next turn", () => {
  let g = empty();
  const rng = seeded(7);
  for (let i = 0; i < 5; i++) {
    const before = bfs(g, g.cat).nearestEdge;
    g = applyCatMove(g, catMove(g, rng));
    assert.equal(g.status, "playing", "reaching the edge must not end the game by itself");
    if (i < 4) assert.equal(bfs(g, g.cat).nearestEdge, before - 1, "each step shortens the route by one");
  }
  assert.ok(isEdge(SIZE, g.cat));
  // The fence player gets one more wall; then the cat walks off regardless.
  const free = legalMoves(g)[0].to;
  g = applyBlock(g, free);
  g = resolveEscape(g);
  assert.equal(g.status, "escaped");
  assert.equal(step(SIZE, g.cat, g.catDir), -1, "escape direction must point off the board");
});

test("resolveEscape leaves a cat in the interior alone", () => {
  const g = empty();
  assert.equal(resolveEscape(g).status, "playing");
});

test("escapeDirection keeps the current facing when it already points off the board", () => {
  const g = { ...empty(), cat: idx(SIZE, 0, 5), catDir: DIRS.indexOf("left") };
  assert.equal(escapeDirection(g), DIRS.indexOf("left"));
  const g2 = { ...g, catDir: DIRS.indexOf("right") };
  assert.equal(step(SIZE, g2.cat, escapeDirection(g2)), -1);
});

test("a cat with no route still moves to a random free neighbour", () => {
  let g = empty();
  const inner = new Set([g.cat, ...neighbors(SIZE, g.cat).map((n) => n.to)]);
  for (const c of inner) for (const n of neighbors(SIZE, c)) if (n.to >= 0 && !inner.has(n.to) && !g.blocked[n.to]) g = applyBlock(g, n.to);
  assert.equal(bfs(g, g.cat).nearestEdge, null);
  const m = catMove(g, seeded(3));
  assert.ok(m && legalMoves(g).some((x) => x.to === m.to));
});

test("a fully walled cat is trapped and catMove returns null", () => {
  let g = empty();
  for (const n of neighbors(SIZE, g.cat)) g = applyBlock(g, n.to);
  g = resolveTrapped(g);
  assert.equal(g.status, "trapped");
  assert.equal(catMove(g), null);
});

test("wall candidates are free cells near the cat, relabelled in reading order, and include the code's best", () => {
  const g = newGame(SIZE, seeded(42));
  const plan = wallCandidates(g);
  assert.ok(plan.candidates.length > 0 && plan.candidates.length <= 8);
  const here = bfs(g, g.cat);
  const toEdge = distanceToEdge(g);
  for (const c of plan.candidates) {
    assert.ok(!g.blocked[c.cell] && c.cell !== g.cat);
    const near = here.dist[c.cell] >= 1 && here.dist[c.cell] <= 3;
    const onRoute = here.dist[c.cell] + toEdge[c.cell] === here.nearestEdge;
    assert.ok(near || onRoute, `candidate ${c.label} is neither near the cat nor on a shortest route`);
    assert.equal(c.onShortestRoute, onRoute);
    assert.ok(typeof c.lookahead === "number");
  }
  const letters = plan.candidates.map((c) => c.letter).join("");
  assert.equal(letters, "ABCDEFGH".slice(0, plan.candidates.length));
  const cells = plan.candidates.map((c) => c.cell);
  assert.deepEqual(cells, cells.slice().sort((a, b) => a - b));
  assert.ok(plan.candidates.some((c) => c.codeRank === 1));
});

test("a wall that traps the cat is flagged and ranked first", () => {
  let g = empty();
  const ns = neighbors(SIZE, g.cat).map((n) => n.to);
  for (const c of ns.slice(0, 5)) g = applyBlock(g, c);
  const plan = wallCandidates(g);
  const trap = plan.candidates.find((c) => c.cell === ns[5]);
  assert.ok(trap, "the last free neighbour must be a candidate");
  assert.equal(trap.trapsNow, true);
  assert.equal(trap.codeRank, 1);
  const q = buildWallQuestions(plan, "analyzed");
  assert.match(q.wall.criteria[trap.letter], /trapped immediately/);
});

test("state and questions use the same letters and hints appear only in analyzed mode", () => {
  const g = newGame(SIZE, seeded(9));
  const plan = wallCandidates(g);
  const full = buildWallState(g, plan, "analyzed");
  const local = buildWallState(g, plan, "local");
  const q = buildWallQuestions(plan, "analyzed");
  assert.deepEqual(Object.keys(full.candidate_walls).sort(), Object.keys(q.wall.criteria).sort());
  const any = Object.values(full.candidate_walls)[0];
  assert.ok("cats_shortest_escape_after_this_wall" in any);
  assert.ok(!("cats_shortest_escape_after_this_wall" in Object.values(local.candidate_walls)[0]));
  for (const c of plan.candidates) assert.ok(full.board.map.includes(` ${c.letter}`), `map must mark ${c.letter}`);
  assert.equal(q.outlook.type, "score");
  assert.equal(q.outlook.criteria.length, 4);
});

test("renderMap marks the cat and relativeDirection reads sensibly", () => {
  const g = empty();
  assert.ok(renderMap(g).includes("C"));
  const up = step(SIZE, g.cat, DIRS.indexOf("up-left"));
  assert.match(relativeDirection(SIZE, g.cat, up), /above/);
  const right = step(SIZE, g.cat, DIRS.indexOf("right"));
  assert.equal(relativeDirection(SIZE, g.cat, right), "directly right of the cat");
});

test("validateGame rejects malformed input", () => {
  assert.throws(() => validateGame(null));
  assert.throws(() => validateGame({ size: 9, blocked: new Array(81).fill(false), cat: 40 }), /bad size/);
  assert.throws(() => validateGame({ size: SIZE, blocked: new Array(121).fill(0), cat: 60 }));
  const g = empty();
  assert.throws(() => validateGame({ ...g, blocked: g.blocked.map((_, i) => i === g.cat) }));
  assert.equal(validateGame(g).cat, 60);
});

test("lookahead prefers a wall that seals the cat over one that merely lengthens the route", () => {
  // Cat in a pocket with a single one-cell gap to the outside: walling the gap seals it.
  let g = empty();
  const inner = new Set([g.cat, ...neighbors(SIZE, g.cat).map((n) => n.to)]);
  const ring = [];
  for (const c of inner) for (const n of neighbors(SIZE, c)) if (n.to >= 0 && !inner.has(n.to) && !ring.includes(n.to)) ring.push(n.to);
  const gap = ring[0];
  for (const c of ring) if (c !== gap) g = applyBlock(g, c);
  const plan = wallCandidates(g);
  const best = plan.candidates.find((c) => c.codeRank === 1);
  assert.equal(best.cell, gap);
  assert.equal(best.stepsToEdgeAfter, null);
});
