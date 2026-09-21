# jev_experiments

Experiments with [TypeSafe](https://docs.typesafe.ai)'s Jev, a System One model that
returns typed judgments and calibrated probabilities instead of text. Each case lives
in its own folder with its own README, run instructions, and tests.

## Cases

| # | Case | What Jev does | Status |
|---|------|---------------|--------|
| 1 | [chat_noir](chat_noir/) | Plays the fence in Taro Ito's Chat Noir: code searches candidate walls and their consequences, Jev chooses one. Side-by-side Claude API provider (Haiku 4.5) for a speed comparison. | working demo |

Total cases: 1

## Conventions

- One folder per case, named in snake_case.
- Every case keeps rules, search, and arithmetic in code and gives the model only the
  judgment, following the TypeSafe guidance.
- API keys come from environment variables only (`TYPESAFE_API_KEY`,
  `ANTHROPIC_API_KEY`). Never commit a `.env`; each case ships a `.env.example`.
- Add a row to the table above and bump the total when a new case lands.
