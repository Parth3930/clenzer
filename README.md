# clenzer

> **MCP server that hunts dead code and complexity — then cleanses it.**  
> Add it to any CLI agent and your codebase stays lean on every session.

[![npm version](https://img.shields.io/npm/v/clenzer.svg)](https://www.npmjs.com/package/clenzer)
[![npm downloads](https://img.shields.io/npm/dm/clenzer.svg)](https://www.npmjs.com/package/clenzer)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-compatible-green)](https://modelcontextprotocol.io)

---

## What it does

**clenzer** is a [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that plugs into any MCP-compatible CLI agent (Claude Code, Antigravity, Cursor, etc.) and gives it five new tools:

| Tool | Description |
|---|---|
| `register_rules` | Writes hygiene rules into `AGENTS.md` / `CLAUDE.md` so the agent re-enforces them every session |
| `scan_dead_code` | Finds unused imports, unused variables, and exported functions with no cross-file references |
| `scan_complexity` | Flags long functions, deep nesting, large files, and duplicate code blocks |
| `cleanse` | Safely auto-removes dead imports and side-effect-free variables; flags riskier items for manual review |
| `report` | Token-efficient summary of all findings with prioritised action items |

### Design principles

- **Token-efficient** — compact output, no JSON blobs, grouped by file
- **Safe** — `cleanse` never removes code with potential side effects; it skips functions and anything with call expressions in initialisers
- **Non-destructive** — dry-run mode available; skipped items are always explained
- **Zero config** — works on any TS/JS project with or without `tsconfig.json`

---

## Installation

### Via npx (no install needed)

```bash
npx clenzer
```

### Global install

```bash
npm install -g clenzer
```

### Local project install

```bash
npm install --save-dev clenzer
```

---

## Adding to your CLI agent

### Claude Code / Antigravity CLI

Add to your `mcp_config.json` (usually `~/.gemini/antigravity/mcp_config.json` or `~/.claude/mcp_config.json`):

```json
{
  "mcpServers": {
    "clenzer": {
      "command": "npx",
      "args": ["-y", "clenzer"],
      "env": {}
    }
  }
}
```

Or if installed globally:

```json
{
  "mcpServers": {
    "clenzer": {
      "command": "clenzer",
      "args": [],
      "env": {}
    }
  }
}
```

### Cursor / other MCP hosts

Add the same block to your MCP host's server config. Refer to your host's documentation for the exact file location.

---

## Usage

Once clenzer is connected to your agent, use natural language or call the tools directly.

### Recommended workflow

```
1. register_rules   — run once per project to lock in hygiene rules
2. scan_dead_code   — before any significant editing session
3. scan_complexity  — identify hotspots
4. report           — get a prioritised action list
5. cleanse          — auto-remove safe dead code
```

### Tool reference

#### `register_rules`

```
project_root: string   # absolute path to project root
```

Appends clenzer's hygiene rules to `AGENTS.md` (or `CLAUDE.md` if it exists). The agent will re-read this file every session, ensuring the rules are always active.

#### `scan_dead_code`

```
project_root: string       # required
include?: string[]         # glob patterns, default: all TS/JS files
exclude?: string[]         # glob patterns, default: node_modules, dist, tests
```

Reports unused imports, unused variables, and exported functions with no cross-file references. Results are stored in session state for use by `cleanse`.

#### `scan_complexity`

```
project_root: string       # required
include?: string[]
exclude?: string[]
```

Thresholds (all configurable via future config file):
- Function length > 60 lines → `long-function`
- Nesting depth > 4 → `deep-nesting`
- File size > 600 lines → `large-file`
- Duplicate block ≥ 6 lines → `duplicate-block`

#### `cleanse`

```
project_root: string    # required
dry_run?: boolean       # default: false
```

Auto-removes items safe to delete (unused imports, variables with no side effects). Skips functions, exports, and anything with call expressions in the initialiser — those are flagged for manual review.

#### `report`

```
project_root: string    # required
top_n?: number          # default: 5 — how many issues to surface per category
```

Returns a compact markdown summary with dead code counts by kind, high-severity complexity hotspots, and recommended next steps.

---

## Hygiene rules enforced

When you run `register_rules`, the following are appended to your `AGENTS.md`:

1. No unused imports — every import must be referenced in the file body
2. No unused variables — variables must be read, not just declared
3. Max function length: **60 lines** — extract helpers if exceeded
4. Max nesting depth: **4** — flatten with early returns
5. Max file size: **600 lines** — split large files into modules
6. No duplicate code blocks — extract shared logic into utilities
7. Prefix intentionally unused variables with `_` — clenzer skips them

---

## Development

```bash
git clone https://github.com/Parth3930/clenzer.git
cd clenzer
npm install
npm run build     # compile TypeScript → dist/
npm run dev       # run with tsx (no compile step)
```

### Project structure

```
src/
├── index.ts      # MCP server, all 5 tools
├── scanner.ts    # AST-based dead code + complexity analysis (ts-morph)
├── cleanser.ts   # Safe removal engine
├── rules.ts      # AGENTS.md / CLAUDE.md rule injection
└── types.ts      # Shared interfaces
```

---

## Tech stack

- **[`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk)** — MCP server transport and tool registration
- **[`ts-morph`](https://ts-morph.com/)** — TypeScript AST analysis and safe code modification
- **[`zod`](https://zod.dev/)** — Runtime schema validation for tool inputs

---

## Keywords

mcp, mcp-server, dead-code, unused-imports, code-cleanup, refactor, typescript, javascript, code-quality, static-analysis, ast, ts-morph, claude-code, cursor, antigravity, model-context-protocol, linter, cleaner, unused-variables, complexity

---

## License

ISC © [Parth3930](https://github.com/Parth3930)
