import { Project, SyntaxKind, Node } from "ts-morph";
import * as path from "path";
import { CleanseAction, CleanseResult } from "./types.js";
import { getDefinedNames } from "./scanner.js";

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
          // Remove import specifier (named, default, or namespace)
          const imp = sf.getImportDeclarations().find((d) => {
            const named = d.getNamedImports().find((n) => (n.getAliasNode()?.getText() ?? n.getName()) === item.name);
            const def = d.getDefaultImport();
            const ns = d.getNamespaceImport();
            return named !== undefined || def?.getText() === item.name || ns?.getText() === item.name;
          });

          if (!imp) {
            skipped.push({
              file: relFile,
              kind: "remove-import",
              name: item.name,
              line: item.line,
              description: "Import declaration not found",
            });
            continue;
          }

          const namedToRemove = imp
            .getNamedImports()
            .find((n) => (n.getAliasNode()?.getText() ?? n.getName()) === item.name);
          const namespaceImp = imp.getNamespaceImport();
          const defaultImp = imp.getDefaultImport();

          if (namedToRemove) {
            const allNamed = imp.getNamedImports();
            if (allNamed.length === 1 && !defaultImp && !namespaceImp) {
              // Only import in statement — remove entire declaration
              imp.remove();
            } else {
              namedToRemove.remove();
            }
          } else if (namespaceImp && namespaceImp.getText() === item.name) {
            if (!defaultImp && imp.getNamedImports().length === 0) {
              imp.remove();
            } else {
              imp.removeNamespaceImport();
            }
          } else if (defaultImp && defaultImp.getText() === item.name) {
            if (!namespaceImp && imp.getNamedImports().length === 0) {
              imp.remove();
            } else {
              imp.removeDefaultImport();
            }
          }

          applied.push({
            file: relFile,
            kind: "remove-import",
            name: item.name,
            line: item.line,
            description: `Removed unused import '${item.name}'`,
          });
          modifiedFiles.add(relFile);

        } else if (item.kind === "variable" && item.name.includes(".")) {
          // Class private member (e.g. MyClass.unusedProp)
          const [className, memberName] = item.name.split(".");
          const classes = sf.getClasses();
          const cls = classes.find((c) => c.getName() === className);
          if (cls) {
            const prop = cls.getProperty(memberName);
            const method = cls.getMethod(memberName);
            const target = prop ?? method;

            if (target) {
              let hasSideEffects = false;
              if (prop) {
                const init = prop.getInitializer();
                hasSideEffects =
                  !!(init &&
                  (init.getDescendantsOfKind(SyntaxKind.CallExpression).length > 0 ||
                    init.getDescendantsOfKind(SyntaxKind.NewExpression).length > 0));
              }

              if (hasSideEffects) {
                skipped.push({
                  file: relFile,
                  kind: "remove-variable",
                  name: item.name,
                  line: item.line,
                  description: `Private member initializer may have side effects — skipping`,
                });
              } else {
                target.remove();
                applied.push({
                  file: relFile,
                  kind: "remove-variable",
                  name: item.name,
                  line: item.line,
                  description: `Removed unused private member '${item.name}'`,
                });
                modifiedFiles.add(relFile);
              }
            } else {
              skipped.push({
                file: relFile,
                kind: "remove-variable",
                name: item.name,
                line: item.line,
                description: `Private member '${memberName}' not found in class '${className}'`,
              });
            }
          } else {
            skipped.push({
              file: relFile,
              kind: "remove-variable",
              name: item.name,
              line: item.line,
              description: `Class '${className}' not found for private member '${memberName}'`,
            });
          }

        } else if (item.kind === "variable") {
          // Find the variable declaration (supports destructuring)
          const varDecls = sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration);
          const target = varDecls.find(
            (v) =>
              getDefinedNames(v.getNameNode()).some((n) => n.name === item.name) &&
              v.getStartLineNumber() === item.line
          );

          if (!target) {
            skipped.push({
              file: relFile,
              kind: "remove-variable",
              name: item.name,
              line: item.line,
              description: "Variable declaration not found at expected line",
            });
            continue;
          }

          // Check if the initializer has side effects (function calls)
          const init = target.getInitializer();
          const hasSideEffects =
            !!(init &&
            (init.getDescendantsOfKind(SyntaxKind.CallExpression).length > 0 ||
              init.getDescendantsOfKind(SyntaxKind.NewExpression).length > 0));

          if (hasSideEffects) {
            skipped.push({
              file: relFile,
              kind: "remove-variable",
              name: item.name,
              line: item.line,
              description: `Initializer may have side effects — skipping`,
                });
            continue;
          }

          const names = getDefinedNames(target.getNameNode());
          if (names.length === 1) {
            // Single variable declaration — safe to remove
            target.remove();
            applied.push({
              file: relFile,
              kind: "remove-variable",
              name: item.name,
              line: item.line,
              description: `Removed unused variable '${item.name}'`,
            });
            modifiedFiles.add(relFile);
          } else {
            // Destructured variable declaration — only remove if all variables in it are unused
            const unusedInThisFile = items
              .filter((i) => i.kind === "variable" && i.line === item.line)
              .map((i) => i.name);
            const allUnused = names.every((n) => unusedInThisFile.includes(n.name));

            if (allUnused) {
              target.remove();
              applied.push({
                file: relFile,
                kind: "remove-variable",
                name: item.name,
                line: item.line,
                description: `Removed unused destructuring declaration (all variables unused)`,
              });
              modifiedFiles.add(relFile);
            } else {
              skipped.push({
                file: relFile,
                kind: "remove-variable",
                name: item.name,
                line: item.line,
                description: `Skipped: part of a multi-variable destructuring statement - please remove manually`,
              });
            }
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
        skipped.push({
          file: relFile,
          kind: "note",
          name: item.name,
          line: item.line,
          description: `Error: ${err.message}`,
        });
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
