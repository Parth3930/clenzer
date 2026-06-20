#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Project } from "ts-morph";
import { z } from "zod";
import * as path from "path";
import * as fs from "fs";

import { scanDeadCode, scanComplexity } from "./scanner.js";
import { cleanse } from "./cleanser.js";
import { registerRules } from "./rules.js";
import { DeadCodeItem, ComplexityItem } from "./types.js";

// ─── State (per session) ──────────────────────────────────────────────────────
let lastScanResult: {
  rootDir: string;
  deadCode: DeadCodeItem[];
  complexity: ComplexityItem[];
  scannedFiles: number;
} | null = null;

// ─── MCP Server ───────────────────────────────────────────────────────────────
const server = new McpServer({
  name: "clenzer",
  version: "1.1.0",
});

// ─── Tool: register_rules ─────────────────────────────────────────────────────
server.tool(
  "register_rules",
  "Creates or updates AGENTS.md or CLAUDE.md in the project root with the hygiene ruleset so the AI agent enforces them in every session. Run this once on onboarding a project.",
  {
    project_root: z
      .string()
      .describe("Absolute path to the project root directory"),
  },
  async ({ project_root }) => {
    const result = registerRules(project_root);
    const msg =
      result.action === "already-present"
        ? `✅ Rules already present in ${result.file} — no changes made.`
        : result.action === "appended"
        ? `✅ Appended/Updated clenzer rules in ${result.file}.`
        : `✅ Created ${result.file} with clenzer rules.`;
    return { content: [{ type: "text", text: msg }] };
  }
);

// ─── Tool: scan_dead_code ─────────────────────────────────────────────────────
server.tool(
  "scan_dead_code",
  "Scans for dead code: unused imports (named, default, namespace), unused local variables/constants (destructuring aware), unused local declarations (functions, classes, interfaces, type aliases, enums), and class private members, plus exported functions/classes with no cross-file references. Run this before editing/finishing tasks.",
  {
    project_root: z
      .string()
      .describe("Absolute path to the project root directory"),
    include: z
      .array(z.string())
      .optional()
      .describe(
        "Glob patterns to include, e.g. ['src/**/*.ts']. Defaults to all TS/JS files."
      ),
    exclude: z
      .array(z.string())
      .optional()
      .describe(
        "Glob patterns to exclude, e.g. ['**/*.test.ts', 'node_modules/**']"
      ),
  },
  async ({ project_root, include, exclude }) => {
    const project = buildProject(project_root, include, exclude);
    const sourceFiles = project.getSourceFiles();

    if (sourceFiles.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `⚠️ No source files found in ${project_root}. Check your include/exclude patterns.`,
          },
        ],
      };
    }

    const deadCode = scanDeadCode(project, project_root);

    // Preserve complexity results if same root
    const prevComplexity =
      lastScanResult?.rootDir === project_root
        ? lastScanResult.complexity
        : [];
    lastScanResult = {
      rootDir: project_root,
      deadCode,
      complexity: prevComplexity,
      scannedFiles: sourceFiles.length,
    };

    if (deadCode.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `✅ No dead code found across ${sourceFiles.length} files.`,
          },
        ],
      };
    }

    const lines = [
      `🔍 Dead code scan — ${sourceFiles.length} files, ${deadCode.length} issue(s):`,
      "",
    ];

    const grouped = groupBy(deadCode, (i) => i.file);
    for (const [file, items] of grouped) {
      lines.push(`**${file}**`);
      for (const item of items) {
        lines.push(`  L${item.line} [${item.kind}] \`${item.name}\` — ${item.reason}`);
      }
    }

    lines.push("");
    lines.push(`Run \`cleanse\` to auto-remove safe items (imports, local variables, class private members).`);

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ─── Tool: scan_complexity ────────────────────────────────────────────────────
server.tool(
  "scan_complexity",
  "Scans for complexity hot-spots: overly long functions (>60 lines), deep block nesting (>4), large files (>600 lines), and duplicate code blocks (>=6 lines). Run this to identify files that need refactoring.",
  {
    project_root: z
      .string()
      .describe("Absolute path to the project root directory"),
    include: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional(),
  },
  async ({ project_root, include, exclude }) => {
    const project = buildProject(project_root, include, exclude);
    const sourceFiles = project.getSourceFiles();

    if (sourceFiles.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `⚠️ No source files found in ${project_root}.`,
          },
        ],
      };
    }

    const complexity = scanComplexity(project, project_root);

    const prevDeadCode =
      lastScanResult?.rootDir === project_root ? lastScanResult.deadCode : [];
    lastScanResult = {
      rootDir: project_root,
      deadCode: prevDeadCode,
      complexity,
      scannedFiles: sourceFiles.length,
    };

    if (complexity.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `✅ No complexity issues found across ${sourceFiles.length} files.`,
          },
        ],
      };
    }

    const severityIcon = (s: string) =>
      s === "high" ? "🔴" : s === "medium" ? "🟡" : "🟢";

    const lines = [
      `🧠 Complexity scan — ${sourceFiles.length} files, ${complexity.length} issue(s):`,
      "",
    ];

    const grouped = groupBy(complexity, (i) => i.file);
    for (const [file, items] of grouped) {
      lines.push(`**${file}**`);
      for (const item of items) {
        lines.push(
          `  ${severityIcon(item.severity)} L${item.line} [${item.kind}] \`${item.name}\` — ${item.detail}`
        );
      }
    }

    lines.push("");
    lines.push(
      `💡 Complexity issues require manual refactoring. Run \`report\` for a full summary.`
    );

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ─── Tool: cleanse ────────────────────────────────────────────────────────────
server.tool(
  "cleanse",
  "Safely auto-removes dead code found by the last `scan_dead_code`. Deletes unused default/named/namespace imports, unused variables/constants, and class private fields/methods. Risky items (functions, classes, variables with side effects, partial destructuring) are skipped for manual review.",
  {
    project_root: z
      .string()
      .describe("Absolute path to the project root directory"),
    dry_run: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "If true, shows what would be removed without modifying files."
      ),
  },
  async ({ project_root, dry_run }) => {
    if (!lastScanResult || lastScanResult.rootDir !== project_root) {
      return {
        content: [
          {
            type: "text",
            text: `⚠️ No scan results for ${project_root}. Run \`scan_dead_code\` first.`,
          },
        ],
      };
    }

    const { deadCode } = lastScanResult;
    if (deadCode.length === 0) {
      return {
        content: [{ type: "text", text: `✅ Nothing to cleanse — no dead code on record.` }],
      };
    }

    // Build fresh project for modification
    const project = buildProject(project_root);
    const result = await cleanse(project, project_root, deadCode);

    const lines: string[] = [
      dry_run ? `🧹 Cleanse (dry run) — no files modified:` : `🧹 Cleanse complete:`,
      "",
    ];

    if (result.applied.length > 0) {
      lines.push(`**Removed (${result.applied.length}):**`);
      for (const a of result.applied) {
        lines.push(`  ✓ ${a.file}:L${a.line} — ${a.description}`);
      }
      lines.push("");
    }

    if (result.skipped.length > 0) {
      lines.push(`**Skipped — manual review needed (${result.skipped.length}):**`);
      for (const s of result.skipped) {
        lines.push(`  ⚠ ${s.file}:L${s.line} \`${s.name}\` — ${s.description}`);
      }
      lines.push("");
    }

    if (!dry_run && result.filesModified.length > 0) {
      lines.push(`**Files modified:** ${result.filesModified.join(", ")}`);
    }

    // Clear scan state so next cleanse requires a fresh scan
    if (!dry_run) {
      lastScanResult = null;
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ─── Tool: report ────────────────────────────────────────────────────────────
server.tool(
  "report",
  "Returns a compact, token-efficient summary of all findings from the last scan. Includes dead code count, complexity hotspots, and actionable next steps.",
  {
    project_root: z
      .string()
      .describe("Absolute path to the project root directory"),
    top_n: z
      .number()
      .optional()
      .default(5)
      .describe("How many top issues to surface per category (default: 5)"),
  },
  async ({ project_root, top_n }) => {
    if (!lastScanResult || lastScanResult.rootDir !== project_root) {
      return {
        content: [
          {
            type: "text",
            text: `⚠️ No scan data for ${project_root}. Run \`scan_dead_code\` and/or \`scan_complexity\` first.`,
          },
        ],
      };
    }

    const { deadCode, complexity, scannedFiles } = lastScanResult;

    const deadByKind = countBy(deadCode, (i) => i.kind);
    const complexByKind = countBy(complexity, (i) => i.kind);

    const lines = [
      `## 📊 Clenzer Report`,
      `**Project:** ${project_root}`,
      `**Files scanned:** ${scannedFiles}`,
      "",
      `### Dead Code (${deadCode.length} total)`,
      ...Object.entries(deadByKind).map(
        ([k, v]) => `- ${v}x ${k}`
      ),
      "",
    ];

    if (deadCode.length > 0) {
      lines.push(`**Top issues:**`);
      for (const item of deadCode.slice(0, top_n)) {
        lines.push(`  • ${item.file}:L${item.line} [${item.kind}] \`${item.name}\``);
      }
      lines.push("");
    }

    lines.push(`### Complexity (${complexity.length} total)`);
    lines.push(...Object.entries(complexByKind).map(([k, v]) => `- ${v}x ${k}`));
    lines.push("");

    const highSeverity = complexity.filter((c) => c.severity === "high");
    if (highSeverity.length > 0) {
      lines.push(`**🔴 High severity hotspots:**`);
      for (const item of highSeverity.slice(0, top_n)) {
        lines.push(`  • ${item.file}:L${item.line} \`${item.name}\` — ${item.detail}`);
      }
      lines.push("");
    }

    lines.push(`### Recommended Actions`);
    if (deadCode.length > 0) {
      lines.push(`1. Run \`cleanse\` to auto-remove ${deadCode.filter((d) => d.kind === "import" || d.kind === "variable").length} safe items.`);
    }
    if (highSeverity.length > 0) {
      lines.push(`2. Manually refactor ${highSeverity.length} high-severity complexity hotspot(s).`);
    }
    if (deadCode.filter((d) => d.kind === "function" || d.kind === "export").length > 0) {
      lines.push(`3. Review ${deadCode.filter((d) => d.kind === "function" || d.kind === "export").length} unused exported function(s) — may be safe to delete.`);
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildProject(
  rootDir: string,
  include?: string[],
  exclude?: string[]
): Project {
  const defaultInclude = ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"];
  const defaultExclude = [
    "node_modules/**",
    "dist/**",
    "build/**",
    "**/*.d.ts",
    "**/*.test.ts",
    "**/*.spec.ts",
    "**/*.test.js",
    "**/*.spec.js",
  ];

  const project = new Project({
    tsConfigFilePath: findTsConfig(rootDir),
    skipAddingFilesFromTsConfig: true,
  });

  const patterns = include ?? defaultInclude;
  const ignorePatterns = exclude ?? defaultExclude;

  project.addSourceFilesAtPaths(
    patterns.map((p) => path.join(rootDir, p))
  );

  // Remove excluded files
  for (const sf of project.getSourceFiles()) {
    const rel = path.relative(rootDir, sf.getFilePath()).replace(/\\/g, "/");
    if (
      ignorePatterns.some((pat) => {
        // Simple glob matching for common patterns
        const regex = globToRegex(pat);
        return regex.test(rel);
      })
    ) {
      project.removeSourceFile(sf);
    }
  }

  return project;
}

function findTsConfig(rootDir: string): string | undefined {
  const candidate = path.join(rootDir, "tsconfig.json");
  return fs.existsSync(candidate) ? candidate : undefined;
}

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, "{{DOUBLE}}")
    .replace(/\*/g, "[^/]*")
    .replace(/{{DOUBLE}}/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function groupBy<T>(
  arr: T[],
  key: (item: T) => string
): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of arr) {
    const k = key(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(item);
  }
  return map;
}

function countBy<T>(arr: T[], key: (item: T) => string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const item of arr) {
    const k = key(item);
    result[k] = (result[k] ?? 0) + 1;
  }
  return result;
}

// ─── Start ────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("🧹 clenzer MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
