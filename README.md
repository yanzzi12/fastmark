# fastmark

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/yanzzi12/fastmark/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/yanzzi12/fastmark/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

fastmark is a dependency-free Markdown renderer written from scratch: a line-oriented container parser builds the block tree, then a delimiter-stack parser resolves inline emphasis, links and code spans, with GFM tables, strikethrough, task lists and extended autolinks on top. It aims to produce exactly the HTML marked 18.1.3 produces, with less CPU time.

## Run it

```sh
node main.ts
```

The program reads every case from `/input/cases.json` (a JSON array of
`{"id", "markdown"}`) and writes the rendered HTML strings, in the same
order, to `/output/html.json`. Outside a container, the `MAKEFUN_INPUT_DIR`
and `MAKEFUN_OUTPUT_DIR` environment variables stand in for `/input` and
`/output`.

---
<sub>Entered on [make.fun](https://make.fun/?ref=kstqabqr&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
