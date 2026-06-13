import { Project, SyntaxKind } from "ts-morph";
import * as path from "path";
import { CleanseAction, CleanseResult } from "./types.js";

/**
 * Safely removes dead code items from source files.
 * Only performs removals that are structurally safe (no runtime side effects).
 */
export async function cleanse(
  project: Project,
  rootDir: string,
  deadCodeItems: Array<{ file: string; line: number; kind: string; name: string }>
): Promise<CleanseResult> {
  const applied: CleanseAction[] = [];
  const skipped: CleanseAction[] = [];
  const modifiedFiles = new Set<string>();

  // Group by file
  const byFile = new Map<string, typeof deadCodeItems>();
  for (const item of deadCodeItems) {
    const key = item.file;
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key)!.push(item);
  }

  for (const [relFile, items] of byFile) {
    const absPath = path.join(rootDir, relFile);
    const sf = project.getSourceFile(absPath);
    if (!sf) {
      for (const item of items) {
        skipped.push({
          file: relFile,
          kind: "note",
          name: item.name,
          line: item.line,
          description: `Source file not loaded in project`,
        });
      }
      continue;
    }

    // Sort items by line descending so removals don't shift line numbers
    const sorted = [...items].sort((a, b) => b.line - a.line);

    for (const item of sorted) {
      try {
        if (item.kind === "import") {
          // Remove named import specifier
          const imp = sf.getImportDeclarations().find((d) => {
            const named = d.getNamedImports().find((n) => n.getName() === item.name);
            const def = d.getDefaultImport();
            return named !== undefined || def?.getText() === item.name;
          });

          if (!imp) {
            skipped.push({ file: relFile, kind: "remove-import", name: item.name, line: item.line, description: "Import declaration not found" });
            continue;
          }

          const namedToRemove = imp.getNamedImports().find((n) => n.getName() === item.name);
          if (namedToRemove) {
            const allNamed = imp.getNamedImports();
            if (allNamed.length === 1) {
              // Only import in statement — remove entire declaration
              imp.remove();
            } else {
              namedToRemove.remove();
            }
          } else {
            // Default import — remove it (if it's the only thing imported, remove whole decl)
            const hasNamespace = imp.getNamespaceImport();
            const hasNamed = imp.getNamedImports().length > 0;
            if (!hasNamespace && !hasNamed) {
              imp.remove();
            } else {
              imp.removeDefaultImport();
            }
          }

          applied.push({ file: relFile, kind: "remove-import", name: item.name, line: item.line, description: `Removed unused import '${item.name}'` });
          modifiedFiles.add(relFile);

        } else if (item.kind === "variable") {
          // Find and remove the variable declaration
          const varDecls = sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration);
          const target = varDecls.find(
            (v) => v.getName() === item.name && v.getStartLineNumber() === item.line
          );

          if (!target) {
            skipped.push({ file: relFile, kind: "remove-variable", name: item.name, line: item.line, description: "Variable declaration not found at expected line" });
            continue;
          }

          // Check if the initializer has side effects (function calls)
          const init = target.getInitializer();
          const hasSideEffects =
            init &&
            (init.getDescendantsOfKind(SyntaxKind.CallExpression).length > 0 ||
              init.getDescendantsOfKind(SyntaxKind.NewExpression).length > 0);

          if (hasSideEffects) {
            skipped.push({ file: relFile, kind: "remove-variable", name: item.name, line: item.line, description: `Initializer may have side effects — skipping` });
            continue;
          }

          const varStatement = target.getParent()?.getParent();
          if (varStatement && "remove" in varStatement) {
            (varStatement as any).remove();
            applied.push({ file: relFile, kind: "remove-variable", name: item.name, line: item.line, description: `Removed unused variable '${item.name}'` });
            modifiedFiles.add(relFile);
          } else {
            skipped.push({ file: relFile, kind: "remove-variable", name: item.name, line: item.line, description: "Could not determine statement boundary" });
          }
        } else {
          // For functions/exports: annotate as note (don't auto-remove, too risky)
          skipped.push({
            file: relFile,
            kind: "note",
            name: item.name,
            line: item.line,
            description: `'${item.kind}' items require manual review before removal`,
          });
        }
      } catch (err: any) {
        skipped.push({ file: relFile, kind: "note", name: item.name, line: item.line, description: `Error: ${err.message}` });
      }
    }
  }

  // Save modified files
  for (const relFile of modifiedFiles) {
    const absPath = path.join(rootDir, relFile);
    const sf = project.getSourceFile(absPath);
    if (sf) {
      sf.saveSync();
    }
  }

  return {
    applied,
    skipped,
    filesModified: [...modifiedFiles],
  };
}
