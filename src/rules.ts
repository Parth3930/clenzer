import * as fs from "fs";
import * as path from "path";

const AGENTS_MD_NAMES = ["AGENTS.md", "CLAUDE.md", "agents.md", "claude.md"];

const CLENZER_RULES = `
## 🧹 Clenzer — Code Hygiene Rules

These rules are enforced by the **clenzer** MCP on every session.

> Run \`scan_dead_code\` and \`scan_complexity\` at the start of any significant
> editing session, then \`cleanse\` to auto-remove safe dead code before generating
> new code. This keeps the codebase lean and prevents token bloat.

### Rules
1. **No unused imports** — every import must be referenced in the file body.
2. **No unused variables** — variables must be read, not just declared.
3. **Max function length: 60 lines** — extract helpers if exceeded.
4. **Max nesting depth: 4** — flatten with early returns or helpers.
5. **Max file size: 400 lines** — split large files into modules.
6. **No duplicate code blocks** — extract shared logic into utilities.
7. **Prefix intentionally unused variables with \`_\`** — clenzer will skip them.

<!-- clenzer:end -->
`;

export function registerRules(projectRoot: string): {
  file: string;
  action: "appended" | "already-present" | "created";
} {
  // Find or create AGENTS.md
  let agentsFile: string | null = null;
  for (const name of AGENTS_MD_NAMES) {
    const candidate = path.join(projectRoot, name);
    if (fs.existsSync(candidate)) {
      agentsFile = candidate;
      break;
    }
  }

  const targetFile = agentsFile ?? path.join(projectRoot, "AGENTS.md");
  const relFile = path.relative(projectRoot, targetFile);

  // Check if rules already present
  if (fs.existsSync(targetFile)) {
    const existing = fs.readFileSync(targetFile, "utf-8");
    if (existing.includes("clenzer:end")) {
      return { file: relFile, action: "already-present" };
    }
    // Append rules
    fs.appendFileSync(targetFile, "\n" + CLENZER_RULES, "utf-8");
    return { file: relFile, action: "appended" };
  }

  // Create fresh AGENTS.md with just the rules
  fs.writeFileSync(targetFile, CLENZER_RULES.trimStart(), "utf-8");
  return { file: relFile, action: "created" };
}
