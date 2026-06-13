export interface DeadCodeItem {
  file: string;
  line: number;
  kind: "import" | "export" | "variable" | "function" | "class" | "type";
  name: string;
  reason: string;
}

export interface ComplexityItem {
  file: string;
  line: number;
  kind:
    | "deep-nesting"
    | "long-function"
    | "duplicate-block"
    | "large-file"
    | "god-function";
  name: string;
  detail: string;
  severity: "low" | "medium" | "high";
}

export interface CleanseAction {
  file: string;
  kind: "remove-import" | "remove-variable" | "remove-function" | "remove-export" | "note";
  name: string;
  line: number;
  description: string;
}

export interface ScanResult {
  scannedFiles: number;
  deadCode: DeadCodeItem[];
  complexity: ComplexityItem[];
}

export interface CleanseResult {
  applied: CleanseAction[];
  skipped: CleanseAction[];
  filesModified: string[];
}
