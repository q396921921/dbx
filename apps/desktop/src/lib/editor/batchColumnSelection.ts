export type BatchColumnSelectionMode = "select" | "insert";

export function batchColumnSelectionColumnList(candidates: string[], mode: BatchColumnSelectionMode, qualifier?: string): string {
  return candidates.map((candidate, index) => (mode === "select" && qualifier && index > 0 ? `${qualifier}.${candidate}` : candidate)).join(", ");
}

export function shouldResolveSqlColumnCompletion(options: { suggestColumns: boolean; hasReferencedTables: boolean; prefix: string; typedActivation: boolean; selectListColumnContext: boolean }): boolean {
  return options.suggestColumns && options.hasReferencedTables && (options.prefix.length > 0 || options.typedActivation || options.selectListColumnContext);
}

/**
 * A completion accepted with nothing typed (`from === to`) right before a
 * lone `*` is always the SELECT wildcard token, never multiplication —
 * multiplication requires an operand immediately before the cursor, which
 * makes `from` trail behind `to` instead. Swallowing that `*` here is what
 * turns `SELECT |* FROM t` into `SELECT id, name FROM t` instead of leaving
 * the stale `*` behind as `SELECT id, name* FROM t`.
 */
export function shouldSwallowSelectStar(from: number, to: number, nextCharacter: string): boolean {
  return from === to && nextCharacter === "*";
}

/**
 * The INSERT batch action writes its own closing parenthesis before VALUES.
 * Consume an existing one (normally inserted by CodeMirror's auto-close
 * brackets extension) so the resulting statement has exactly one `)`.
 */
export function batchColumnSelectionReplaceTo(options: { from: number; to: number; mode: BatchColumnSelectionMode; nextCharacter: string; replaceClosingQuote?: string }): number {
  const { from, to, mode, nextCharacter, replaceClosingQuote } = options;
  const swallowNext = replaceClosingQuote === nextCharacter || (mode === "insert" && nextCharacter === ")") || shouldSwallowSelectStar(from, to, nextCharacter);
  return swallowNext ? to + 1 : to;
}

export function batchColumnSelectionInsertReplacement(options: { document: string; to: number; columns: string; valuesKeyword: "values" | "VALUES"; valueCount: number }): { replaceTo: number; insert: string } {
  const suffix = options.document.slice(options.to);
  const closingParenthesis = suffix.match(/^\s*\)/);
  const replaceTo = closingParenthesis ? options.to + closingParenthesis[0].length : options.to;
  const hasExistingValues = /^\s*\)\s*VALUES\b/i.test(suffix);
  if (hasExistingValues) return { replaceTo, insert: `${options.columns})` };

  const values = Array.from({ length: options.valueCount }, (_, index) => `\${${index + 1}:value}`).join(", ");
  return { replaceTo, insert: `${options.columns}) ${options.valuesKeyword} (${values})` };
}

export function isBatchColumnSelectionCompletionActive(status: "active" | "pending" | null): boolean {
  return status === "active";
}
