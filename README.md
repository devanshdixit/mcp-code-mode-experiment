# MCP vs Code Mode: token experiment

This script counts the tokens a model reads and writes when it calls MCP tools directly, compared with Code Mode (the model writes a script against a typed code interface). It uses the real tool schemas from GitHub's official MCP server.

Write-up: [devanshu.wiki/mcp-code-mode](https://devanshu.wiki/mcp-code-mode). Every number on that page comes from `results.json` in this repo.

## Run it

```bash
git clone https://github.com/github/github-mcp-server
cd github-mcp-server && git checkout 9a72d8d && cd ..
git clone https://github.com/devanshdixit/mcp-code-mode-experiment
cd mcp-code-mode-experiment
npm install
npm start        # writes results.json
```

`npm start` expects `github-mcp-server` to be cloned next to this repo. To use another location, run `node experiment.js <path-to>/pkg/github/__toolsnaps__ > results.json`.

## Notes

- Tokenizer: `cl100k_base` via `gpt-tokenizer`. Claude's tokenizer differs, so compare the ratios, not the absolute counts.
- Tool definitions: GitHub MCP server, commit `9a72d8d` (Nov 20, 2026).
- The customer and order data are made up, from a fixed random seed (42), so reruns give the same results.
- The generated script runs in Node's `vm` sandbox.

## Files

| File | What it is |
|---|---|
| `experiment.js` | The token-count script |
| `results.json` | Raw results the write-up uses |
| `package.json` | Dependency (`gpt-tokenizer`) and the `npm start` command |

## License

Apache 2.0. See `LICENSE`.
