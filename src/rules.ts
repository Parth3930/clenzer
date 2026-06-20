import * as fs from "fs";
import * as path from "path";

const AGENTS_MD_NAMES = ["AGENTS.md", "CLAUDE.md", "agents.md", "claude.md"];

const CLENZER_RULES = `
## 🧹 Clenzer — Code Hygiene Rules

These rules are enforced by the **clenzer** MCP on every session.

> **IMPORTANT**: Run \`scan_dead_code\` and \`scan_complexity\` at the start of any significant editing session and BEFORE completing your task, then run \`cleanse\` to auto-remove safe dead code. This keeps the codebase lean and prevents token bloat.

### Mandatory Rules
1. **No Unused Imports** — Every import must be referenced in the file body. Namespace, default, and named imports must be used.
2. **No Unused Local Variables** — Variables must be read, not just declared. If a variable is intentionally unused, prefix its name with \`_\` (e.g. \`_temp\`) so Clenzer skips it.
3. **No Unused Private Members** — Class private properties and methods must be referenced within the class.
4. **No Unused Local Declarations** — Local (non-exported) functions, classes, interfaces, type aliases, and enums must be referenced.
5. **Max Function Length: 60 lines** — Extract helper functions if a method or function exceeds this length.
6. **Max Nesting Depth: 4** — Flatten nested logic with early returns, guard clauses, or helper methods.
7. **Max File Size: 600 lines** — Split large files into smaller, focused modules.
8. **No Duplicate Code Blocks** — Extract shared block patterns (6+ lines) into reusable utilities.

### Action Plan for the AI
1. **Onboarding**: Run \`register_rules\` once at project setup.
2. **On Task Start**: Run \`scan_dead_code\` and \`cleanse\` to clear existing debt so you don't inherit it.
3. **During Development**: Follow the code length and nesting constraints.
4. **On Task Completion**: Run \`scan_dead_code\` followed by \`cleanse\` to auto-clean your workspace. For any skipped items (e.g. unused exported functions/classes or destructured variables), review them manually and delete them if they are truly unused.

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
      // Overwrite the existing clenzer rules section if present, or update them
      // Let's replace the old clenzer rules section if it exists, to upgrade the rules
      const startIdx = existing.indexOf("## 🧹 Clenzer — Code Hygiene Rules");
      const endIdx = existing.indexOf("<!-- clenzer:end -->");
      if (startIdx !== -1 && endIdx !== -1) {
        const before = existing.substring(0, startIdx);
        const after = existing.substring(endIdx + "<!-- clenzer:end -->".length);
        const updated = before + CLENZER_RULES.trim() + after;
        fs.writeFileSync(targetFile, updated, "utf-8");
        return { file: relFile, action: "appended" };
      }
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
