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
        const aliasNode = named.getAliasNode();
        const alias = aliasNode?.getText() ?? name;
        const refs = sf
          .getDescendantsOfKind(SyntaxKind.Identifier)
          .filter(
            (id) =>
              id.getText() === alias &&
              id !== named.getNameNode() &&
              id !== aliasNode &&
              isIdentifierVariableReference(id)
          );
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
          .filter(
            (id) =>
              id.getText() === name &&
              id !== defaultImp &&
              isIdentifierVariableReference(id)
          );
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

      // Namespace import check
      const namespaceImp = imp.getNamespaceImport();
      if (namespaceImp) {
        const name = namespaceImp.getText();
        const refs = sf
          .getDescendantsOfKind(SyntaxKind.Identifier)
          .filter(
            (id) =>
              id.getText() === name &&
              id !== namespaceImp &&
              isIdentifierVariableReference(id)
          );
        if (refs.length === 0) {
          items.push({
            file: relPath,
            line: imp.getStartLineNumber(),
            kind: "import",
            name,
            reason: `Namespace import '${name}' never used in this file`,
          });
        }
      }
    }

    // ── Unused variables (handles destructuring) ───────────────────────────
    for (const varDecl of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
      const names = getDefinedNames(varDecl.getNameNode());
      const parent = varDecl.getParent()?.getParent();
      if (!parent) continue;

      for (const { nameNode, name } of names) {
        if (name.startsWith("_")) continue; // convention: _ prefix = intentionally unused
        const refs = sf
          .getDescendantsOfKind(SyntaxKind.Identifier)
          .filter(
            (id) =>
              id.getText() === name &&
              isIdentifierVariableReference(id) &&
              getDeclarationForId(id, name) === varDecl
          );
        if (refs.length === 0) {
          // Check if it's a destructured variable statement and note it
          const isMulti = names.length > 1;
          items.push({
            file: relPath,
            line: varDecl.getStartLineNumber(),
            kind: "variable",
            name,
            reason: isMulti
              ? `Variable '${name}' (destructured) declared but never read`
              : `Variable '${name}' declared but never read`,
          });
        }
      }
    }

    // ── Unused non-exported or exported functions ───────────────────────────
    for (const fn of sf.getFunctions()) {
      const name = fn.getName();
      if (!name) continue;

      if (fn.isExported()) {
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
      } else {
        const nameNode = fn.getNameNode();
        if (nameNode && !name.startsWith("_")) {
          const refs = sf
            .getDescendantsOfKind(SyntaxKind.Identifier)
            .filter(
              (id) =>
                id.getText() === name &&
                id !== nameNode &&
                isIdentifierVariableReference(id) &&
                getDeclarationForId(id, name) === fn
            );
          if (refs.length === 0) {
            items.push({
              file: relPath,
              line: fn.getStartLineNumber(),
              kind: "function",
              name,
              reason: `Local function '${name}' is declared but never referenced`,
            });
          }
        }
      }
    }

    // ── Unused classes ──────────────────────────────────────────────────────
    for (const cls of sf.getClasses()) {
      const name = cls.getName();
      if (!name) continue;

      if (cls.isExported()) {
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
            line: cls.getStartLineNumber(),
            kind: "class",
            name,
            reason: `Exported class '${name}' has no cross-file references`,
          });
        }
      } else {
        const nameNode = cls.getNameNode();
        if (nameNode && !name.startsWith("_")) {
          const refs = sf
            .getDescendantsOfKind(SyntaxKind.Identifier)
            .filter(
              (id) =>
                id.getText() === name &&
                id !== nameNode &&
                isIdentifierVariableReference(id) &&
                getDeclarationForId(id, name) === cls
            );
          if (refs.length === 0) {
            items.push({
              file: relPath,
              line: cls.getStartLineNumber(),
              kind: "class",
              name,
              reason: `Local class '${name}' is declared but never referenced`,
            });
          }
        }
      }

      // Check class private fields and methods
      const classMembers = [...cls.getProperties(), ...cls.getMethods()];
      for (const member of classMembers) {
        const isPrivate =
          member.hasModifier(SyntaxKind.PrivateKeyword) ||
          member.getName().startsWith("#");
        if (!isPrivate) continue;

        const mName = member.getName();
        const mNameNode = member.getNameNode();
        if (!mNameNode) continue;

        const refs = cls
          .getDescendantsOfKind(SyntaxKind.Identifier)
          .filter(
            (id) =>
              id.getText() === mName &&
              id !== mNameNode &&
              id.getParent()?.getKind() === SyntaxKind.PropertyAccessExpression &&
              (id.getParent() as any).getNameNode() === id
          );
        if (refs.length === 0) {
          items.push({
            file: relPath,
            line: member.getStartLineNumber(),
            kind: "variable",
            name: `${name}.${mName}`,
            reason: `Private member '${mName}' is never referenced in class '${name}'`,
          });
        }
      }
    }

    // ── Unused interfaces ───────────────────────────────────────────────────
    for (const intf of sf.getInterfaces()) {
      if (intf.isExported()) continue;
      const name = intf.getName();
      const nameNode = intf.getNameNode();
      if (name && nameNode && !name.startsWith("_")) {
        const refs = sf
          .getDescendantsOfKind(SyntaxKind.Identifier)
          .filter(
            (id) =>
              id.getText() === name &&
              id !== nameNode &&
              isIdentifierVariableReference(id) &&
              getDeclarationForId(id, name) === intf
          );
        if (refs.length === 0) {
          items.push({
            file: relPath,
            line: intf.getStartLineNumber(),
            kind: "type",
            name,
            reason: `Local interface '${name}' is declared but never referenced`,
          });
        }
      }
    }

    // ── Unused type aliases ─────────────────────────────────────────────────
    for (const ta of sf.getTypeAliases()) {
      if (ta.isExported()) continue;
      const name = ta.getName();
      const nameNode = ta.getNameNode();
      if (name && nameNode && !name.startsWith("_")) {
        const refs = sf
          .getDescendantsOfKind(SyntaxKind.Identifier)
          .filter(
            (id) =>
              id.getText() === name &&
              id !== nameNode &&
              isIdentifierVariableReference(id) &&
              getDeclarationForId(id, name) === ta
          );
        if (refs.length === 0) {
          items.push({
            file: relPath,
            line: ta.getStartLineNumber(),
            kind: "type",
            name,
            reason: `Local type alias '${name}' is declared but never referenced`,
          });
        }
      }
    }

    // ── Unused enums ────────────────────────────────────────────────────────
    for (const en of sf.getEnums()) {
      if (en.isExported()) continue;
      const name = en.getName();
      const nameNode = en.getNameNode();
      if (name && nameNode && !name.startsWith("_")) {
        const refs = sf
          .getDescendantsOfKind(SyntaxKind.Identifier)
          .filter(
            (id) =>
              id.getText() === name &&
              id !== nameNode &&
              isIdentifierVariableReference(id) &&
              getDeclarationForId(id, name) === en
          );
        if (refs.length === 0) {
          items.push({
            file: relPath,
            line: en.getStartLineNumber(),
            kind: "type",
            name,
            reason: `Local enum '${name}' is declared but never referenced`,
          });
        }
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

export function getDefinedNames(node: Node): { nameNode: Node; name: string }[] {
  if (Node.isIdentifier(node)) {
    return [{ nameNode: node, name: node.getText() }];
  }
  if (Node.isObjectBindingPattern(node) || Node.isArrayBindingPattern(node)) {
    const list: { nameNode: Node; name: string }[] = [];
    for (const element of node.getElements()) {
      if (Node.isBindingElement(element)) {
        list.push(...getDefinedNames(element.getNameNode()));
      }
    }
    return list;
  }
  return [];
}

function isIdentifierVariableReference(id: Node): boolean {
  const parent = id.getParent();
  if (!parent) return true;

  if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === id) {
    return false;
  }

  if (Node.isBindingElement(parent) && parent.getPropertyNameNode() === id) {
    return false;
  }

  if (Node.isPropertyAssignment(parent) && parent.getNameNode() === id) {
    return false;
  }

  if (Node.isExportSpecifier(parent) && parent.getAliasNode() === id) {
    return false;
  }

  if ("getNameNode" in parent && (parent as any).getNameNode() === id) {
    if (Node.isShorthandPropertyAssignment(parent)) {
      return true;
    }
    if (Node.isExportSpecifier(parent)) {
      return true;
    }
    return false;
  }

  return true;
}

function getDeclarationForId(id: Node, name: string): Node | null {
  let current: Node | null = id;
  while (current) {
    const parent: Node | undefined = current.getParent();
    if (!parent) break;

    if (
      Node.isBlock(parent) ||
      Node.isSourceFile(parent) ||
      Node.isCaseBlock(parent) ||
      Node.isModuleBlock(parent)
    ) {
      let statements: any[] = [];
      if (Node.isCaseBlock(parent)) {
        statements = parent.getClauses().flatMap((c) => c.getStatements());
      } else {
        statements = (parent as any).getStatements();
      }
      for (const stmt of statements) {
        if (Node.isVariableStatement(stmt)) {
          for (const decl of stmt.getDeclarations()) {
            const names = getDefinedNames(decl.getNameNode());
            if (names.some((n) => n.name === name)) return decl;
          }
        }
        if (Node.isFunctionDeclaration(stmt) && stmt.getName() === name) return stmt;
        if (Node.isClassDeclaration(stmt) && stmt.getName() === name) return stmt;
        if (Node.isInterfaceDeclaration(stmt) && stmt.getName() === name) return stmt;
        if (Node.isTypeAliasDeclaration(stmt) && stmt.getName() === name) return stmt;
        if (Node.isEnumDeclaration(stmt) && stmt.getName() === name) return stmt;
      }
    }

    if (
      Node.isFunctionDeclaration(parent) ||
      Node.isMethodDeclaration(parent) ||
      Node.isArrowFunction(parent) ||
      Node.isFunctionExpression(parent)
    ) {
      for (const param of parent.getParameters()) {
        const names = getDefinedNames(param.getNameNode());
        if (names.some((n) => n.name === name)) return param;
      }
      if ("getName" in parent && (parent as any).getName() === name) return parent;
    }

    if (Node.isCatchClause(parent)) {
      const varDecl = parent.getVariableDeclaration();
      if (varDecl) {
        const names = getDefinedNames(varDecl.getNameNode());
        if (names.some((n) => n.name === name)) return varDecl;
      }
    }

    if (Node.isSourceFile(parent)) {
      for (const imp of parent.getImportDeclarations()) {
        const named = imp
          .getNamedImports()
          .find((n) => (n.getAliasNode()?.getText() ?? n.getName()) === name);
        if (named) return named;
        const def = imp.getDefaultImport();
        if (def && def.getText() === name) return def;
        const ns = imp.getNamespaceImport();
        if (ns && ns.getText() === name) return ns;
      }
    }

    current = parent;
  }
  return null;
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
