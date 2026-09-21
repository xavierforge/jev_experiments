# Chat Noir with Jev

Taro Ito's [Chat Noir](https://www.gamedesign.jp/sp/cat/), with the fence player's
role taken by [TypeSafe](https://docs.typesafe.ai)'s Jev, a System One model that
returns typed judgments and calibrated probabilities instead of text. The cat runs
the original game's own algorithm: a random shortest route to the nearest edge.

Press Step (or turn on Auto play). Each turn the server asks Jev which cell to wall,
the page places it, the cat replies. The page shows the board in the original's look,
Jev's full probability distribution over the candidate walls, its confidence, a
speculative "outlook" reading, the exact request and response, and how long the
model took.

## Run

Node 20 or newer.

```sh
npm install
export TYPESAFE_API_KEY=...        # from console.typesafe.ai
export ANTHROPIC_API_KEY=...       # only for the Claude provider (or `ant auth login`)
npm start                          # http://localhost:8787
```

Optional environment: `PORT` (default 8787), `TYPESAFE_DEFAULT_MODEL` (default
`jev-latest`), `TYPESAFE_BASE_URL`, `CLAUDE_DEFAULT_MODEL` (default
`claude-haiku-4-5`), `ANTHROPIC_BASE_URL`.

### Claude provider

The Provider selector switches the fence player from Jev to the Claude API, for a
speed and behaviour comparison. The default model is Claude Haiku 4.5; any Claude
model ID can be typed into the Model box. The request is built from the same state
and per-candidate criteria Jev gets, sent as a system prompt plus one user message,
with a structured output schema that constrains the answer to one candidate letter,
an outlook level, and a one-sentence reason. No extended thinking is requested and
the output is a few dozen tokens, so the measured latency is the model's fastest path. Claude
returns a single choice rather than a probability distribution, so the decision
panel shows the chosen candidate and the reason instead of bars.

### Without an API key

A heuristic mock of both endpoints lets you exercise the UI and server end to
end. Its answers are not Jev's or Claude's and say nothing about either model.

```sh
node mock/mock-typesafe.mjs &                                    # :8788
TYPESAFE_API_KEY=mock TYPESAFE_BASE_URL=http://localhost:8788 \
ANTHROPIC_API_KEY=mock ANTHROPIC_BASE_URL=http://localhost:8788 npm start
```

### Tests

```sh
npm test
```

## How the wall decision is designed

The design follows the TypeSafe guidance: code owns rules, search, and arithmetic,
and the model supplies the judgment. Jev 1.13 is documented as weak at counting,
spatial arithmetic, and long distractor-filled state, so none of that is asked of it.
Asking it to pick one of 121 cells from an ASCII map would be asking it to run a
path search, which is not a System One task.

Each turn the server:

1. Builds the candidate pool: every free cell within three steps of the cat plus
   every free cell on one of the cat's current shortest routes to the edge (that is
   where fences get built).
2. Scores each candidate. While the cat is four or more steps from the edge a
   wrong wall costs little and the pool is huge, so the score is the immediate
   effect (one-ply). Once the cat is within three steps the score is a two-ply
   lookahead: wall it, let the cat answer with any shortest-route step, answer with
   the fence's best single wall, and take the cat's shortest escape after that
   exchange in the worst case. Trapping or sealing the cat outranks any distance; a
   wall after which the cat reaches the edge is a loss. Immediate effects (escape
   length, number of shortest exits, edge cells reachable, walls touched) break ties.
3. Keeps the best eight and relabels them A, B, C... in reading order, so the letter
   carries no ranking hint. The code's own rank is still returned and shown in the
   UI, so you can see when Jev agrees with the search and when it does not.
4. Asks two questions in one request over a `state` that holds the rules, an ASCII
   map with the candidate letters drawn on it, the cat's position, and one entry per
   candidate including the lookahead result:
   - `wall`, a **Choice** over the candidate letters. Each option's criteria is a
     full sentence describing the cell and its consequences. The instructions give
     the role, the goal, and an explicit priority order.
   - `outlook`, a **Score** over four levels from the fence player's view (Lost,
     Behind, Even, Winning). It is speculative, costs almost no extra latency, and
     the UI shows it next to the code's ground truth.
5. Applies the chosen wall in code, then runs the cat's turn with the original
   algorithm. If only one candidate exists the code walls it and marks the turn
   "forced".

Be clear about what this shows. The search does the heavy lifting; Jev's
contribution is the final selection among a shortlist whose consequences are
already spelled out. Over 300 simulated games against the original cat, the
search's own top pick wins about 68% (a pure one-ply version won 25%, and a random
pick among the eight candidates never wins). The search takes at most about 40 ms
per turn. A deeper search was considered and dropped as not worth the latency.
That is the intended System One shape and it is honest to say so in a demo. The **Hints** selector makes the point visible: `analyzed` sends
the consequences, `local` sends only geometry (where each candidate sits relative
to the cat, how many walls it touches, and the map) and asks Jev to read the board
itself. Expect `local` to lose more games.

## Timing

The Timing strip shows only how long Jev took to decide: this wall, the mean, the
min and max, and a bar per wall. It is measured on the server immediately around
the SDK call. The browser round trip and token usage are in the raw Answers block.

## Layout

```
server.mjs              Node http server: static files + POST /api/wall for both providers (holds the API keys)
public/game.js          Shared engine: hex geometry, BFS, the original cat algorithm, candidate walls, state and question builders
public/app.js           Browser UI: board, decision panel, timing, history, raw request view
public/index.html
public/style.css
mock/mock-typesafe.mjs  Heuristic stand-in for api.typesafe.ai and the Anthropic Messages API
test/game.test.mjs      Engine tests (node --test)
```

Board, rules, and the cat match the original 11 by 11 game: odd rows shift half a
cell right, each cell has six neighbours, each cell starts walled with 10%
probability, the cat starts at the centre, and the fence player moves first. The
cat is a port of the original's `set_step`, `walk_out`, and `walk_random`: it
searches for the nearest edge cells, picks one at random, follows a random shortest
path toward it, and wanders randomly when no edge is reachable. As in the original,
reaching the outer ring does not end the game by itself: the fence player places
one more wall, then the cat walks off the board at the start of its turn whatever
that wall was. Free cells are `#ccff00`, walls `#728501`, on white. The cat is the
system black-cat emoji (🐈‍⬛), which fits inside one cell. It slides between
cells with a short CSS transition, faces the direction of its last move, and slides
off the board on escape. The game is a vehicle for showing the model's decisions,
so the original's frame-by-frame jump animation is deliberately not reproduced. No
artwork from the original site is used; the game design credit belongs to Taro Ito.
