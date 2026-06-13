import { Project, SourceFile, Node, SyntaxKind } from "ts-morph";
import * as path from "path";
import { DeadCodeItem, ComplexityItem } from "./types.js";

// ─── Thresholds ──────────────────────────────────────────────────────────────
const MAX_FUNCTION_LINES = 60;
const MAX_NESTING_DEPTH = 4;
const MAX_FILE_LINES = 600;
const MIN_DUPLICATE_LINES = 6;

// ─── Dead Code Scanner ───────────────────────────────────────────────────────

export function scanDeadCode(
  project: Project,
  rootDir: string
): DeadCodeItem[] {
  const items: DeadCodeItem[] = [];
  const sourceFiles = project.getSourceFiles();

  for (const sf of sourceFiles) {
    const relPath = path.relative(rootDir, sf.getFilePath());

    // ── Unused imports ──────────────────────────────────────────────────────
    for (const imp of sf.getImportDeclarations()) {
      const namedImports = imp.getNamedImports();
      for (const named of namedImports) {
        const name = named.getName();
        const alias = named.getAliasNode()?.getText() ?? name;
        // Check if the alias/name is used elsewhere in the file (beyond the import itself)
        const refs = sf
          .getDescendantsOfKind(SyntaxKind.Identifier)
          .filter((id) => id.getText() === alias && id !== named.getNameNode());
        if (refs.length === 0) {
          items.push({
            file: relPath,
            line: imp.getStartLineNumber(),
            kind: "import",
            name: alias,
            reason: `'${alias}' imported but never used in this file`,
          });
        }
      }

      // Default import check
      const defaultImp = imp.getDefaultImport();
      if (defaultImp) {
        const name = defaultImp.getText();
        const refs = sf
          .getDescendantsOfKind(SyntaxKind.Identifier)
          .filter((id) => id.getText() === name && id !== defaultImp);
        if (refs.length === 0) {
          items.push({
            file: relPath,
            line: imp.getStartLineNumber(),
            kind: "import",
            name,
            reason: `Default import '${name}' never used in this file`,
          });
        }
      }
    }

    // ── Unused local variables ──────────────────────────────────────────────
    for (const varDecl of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
      const name = varDecl.getName();
      if (name.startsWith("_")) continue; // convention: _ prefix = intentionally unused
      const parent = varDecl.getParent()?.getParent();
      // Only top-level or function-scope vars
      if (!parent) continue;
      const refs = sf
        .getDescendantsOfKind(SyntaxKind.Identifier)
        .filter(
          (id) =>
            id.getText() === name &&
            id.getStart() !== varDecl.getNameNode().getStart()
        );
      if (refs.length === 0) {
        items.push({
          file: relPath,
          line: varDecl.getStartLineNumber(),
          kind: "variable",
          name,
          reason: `Variable '${name}' declared but never read`,
        });
      }
    }

    // ── Unused exported functions / variables (no cross-file reference) ─────
    for (const fn of sf.getFunctions()) {
      if (!fn.isExported()) continue;
      const name = fn.getName();
      if (!name) continue;
      const usedInOtherFiles = sourceFiles.some(
        (other) =>
          other !== sf &&
          other
            .getDescendantsOfKind(SyntaxKind.Identifier)
            .some((id) => id.getText() === name)
      );
      if (!usedInOtherFiles) {
        items.push({
          file: relPath,
          line: fn.getStartLineNumber(),
          kind: "function",
          name,
          reason: `Exported function '${name}' has no cross-file references`,
        });
      }
    }
  }

  return dedupItems(items);
}

// ─── Complexity Scanner ──────────────────────────────────────────────────────

export function scanComplexity(
  project: Project,
  rootDir: string
): ComplexityItem[] {
  const items: ComplexityItem[] = [];

  for (const sf of project.getSourceFiles()) {
    const relPath = path.relative(rootDir, sf.getFilePath());
    const lineCount = sf.getEndLineNumber();

    // ── Large file ──────────────────────────────────────────────────────────
    if (lineCount > MAX_FILE_LINES) {
      items.push({
        file: relPath,
        line: 1,
        kind: "large-file",
        name: path.basename(relPath),
        detail: `${lineCount} lines (threshold: ${MAX_FILE_LINES})`,
        severity: lineCount > MAX_FILE_LINES * 2 ? "high" : "medium",
      });
    }

    // ── Per-function checks ─────────────────────────────────────────────────
    const functions = [
      ...sf.getFunctions(),
      ...sf
        .getClasses()
        .flatMap((c) => c.getMethods()),
      ...sf
        .getDescendantsOfKind(SyntaxKind.ArrowFunction)
        .filter((af) => {
          const parent = af.getParent();
          return Node.isVariableDeclaration(parent);
        }),
    ];

    for (const fn of functions) {
      const start = fn.getStartLineNumber();
      const end = fn.getEndLineNumber();
      const fnLines = end - start;
      const fnName =
        "getName" in fn && typeof (fn as any).getName === "function"
          ? (fn as any).getName() ?? "<anonymous>"
          : "<arrow>";

      // Long function
      if (fnLines > MAX_FUNCTION_LINES) {
        items.push({
          file: relPath,
          line: start,
          kind: "long-function",
          name: fnName,
          detail: `${fnLines} lines (threshold: ${MAX_FUNCTION_LINES})`,
          severity: fnLines > MAX_FUNCTION_LINES * 2 ? "high" : "medium",
        });
      }

      // Deep nesting — count max block depth
      const maxDepth = getMaxNestingDepth(fn);
      if (maxDepth > MAX_NESTING_DEPTH) {
        items.push({
          file: relPath,
          line: start,
          kind: "deep-nesting",
          name: fnName,
          detail: `Nesting depth ${maxDepth} (threshold: ${MAX_NESTING_DEPTH})`,
          severity: maxDepth > MAX_NESTING_DEPTH + 2 ? "high" : "medium",
        });
      }
    }

    // ── Duplicate code blocks ───────────────────────────────────────────────
    const dupes = findDuplicateBlocks(sf, MIN_DUPLICATE_LINES);
    for (const dupe of dupes) {
      items.push({
        file: relPath,
        line: dupe.line,
        kind: "duplicate-block",
        name: `~${dupe.lines}L block`,
        detail: `Duplicated at lines ${dupe.line} and ${dupe.otherLine}`,
        severity: "low",
      });
    }
  }

  return items;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getMaxNestingDepth(node: Node): number {
  let maxDepth = 0;
  function walk(n: Node, depth: number) {
    if (
      Node.isBlock(n) ||
      Node.isIfStatement(n) ||
      Node.isForStatement(n) ||
      Node.isForInStatement(n) ||
      Node.isForOfStatement(n) ||
      Node.isWhileStatement(n) ||
      Node.isTryStatement(n) ||
      Node.isSwitchStatement(n)
    ) {
      depth++;
    }
    if (depth > maxDepth) maxDepth = depth;
    for (const child of n.getChildren()) {
      walk(child, depth);
    }
  }
  walk(node, 0);
  return maxDepth;
}

interface DupeResult {
  line: number;
  otherLine: number;
  lines: number;
}

function findDuplicateBlocks(
  sf: SourceFile,
  minLines: number
): DupeResult[] {
  const text = sf.getFullText();
  const lines = text.split("\n");
  const results: DupeResult[] = [];
  const seen = new Map<string, number>();

  for (let i = 0; i <= lines.length - minLines; i++) {
    const block = lines.slice(i, i + minLines).join("\n").trim();
    if (block.length < 80) continue; // skip trivial blocks
    if (seen.has(block)) {
      results.push({
        line: i + 1,
        otherLine: seen.get(block)! + 1,
        lines: minLines,
      });
    } else {
      seen.set(block, i);
    }
  }
  return results;
}

function dedupItems<T extends { file: string; line: number; name: string }>(
  items: T[]
): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.file}:${item.line}:${item.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
