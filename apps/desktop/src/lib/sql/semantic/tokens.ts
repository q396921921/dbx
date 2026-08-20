import type { SqlSemanticSpan, SqlSemanticToken } from "@/lib/sql/semantic/types";

const WORD_START = /[A-Za-z_@$#]/;
const WORD_PART = /[A-Za-z0-9_@$#]/;

function token(kind: SqlSemanticToken["kind"], text: string, start: number, end: number, depth: number, quote?: string): SqlSemanticToken {
  return {
    kind,
    text,
    normalized: kind === "word" ? text.toLowerCase() : text,
    span: { start, end },
    depth,
    quote,
  };
}

function readQuoted(input: string, start: number, open: string, close: string): number {
  let index = start + open.length;
  while (index < input.length) {
    if (input.startsWith(close, index)) {
      if (input.startsWith(close + close, index)) {
        index += close.length * 2;
        continue;
      }
      return index + close.length;
    }
    index += 1;
  }
  return input.length;
}

// Same doubled-quote escaping as readQuoted, plus (when allowBackslashEscape) MySQL-style `\x`
// escaping inside '...' strings. Backslash-escape recognition is NOT safe to apply
// unconditionally: a string that merely *ends* in a literal backslash right before the closing
// quote (e.g. a Windows path literal `'C:\Program Files\'` under Postgres, whose default
// standard_conforming_strings=on gives backslash no special meaning) would have its real closing
// quote misread as escaped, swallowing the rest of the query as a phantom string. So this is
// gated per-dialect by the caller (see tokenizeSqlSemantic's `mysqlBackslashEscape` option) rather
// than applied everywhere.
function readQuotedString(input: string, start: number, quote: string, allowBackslashEscape: boolean): number {
  let index = start + 1;
  while (index < input.length) {
    if (allowBackslashEscape && input[index] === "\\" && index + 1 < input.length) {
      index += 2;
      continue;
    }
    if (input[index] === quote) {
      if (input[index + 1] === quote) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return input.length;
}

const DOLLAR_QUOTE_TAG_PATTERN = /\$[A-Za-z_0-9]*\$/y;

/**
 * Matches a PostgreSQL dollar-quote tag (`$$` or `$tag$`) starting exactly at `index`, without
 * allocating a substring: a sticky ("y") regex anchors its match to `lastIndex` and scans the
 * original string in place, unlike `pattern.exec(input.slice(index))` which copies everything
 * from `index` to the end of `input` on every call.
 */
export function matchDollarQuoteTag(input: string, index: number): string | undefined {
  DOLLAR_QUOTE_TAG_PATTERN.lastIndex = index;
  return DOLLAR_QUOTE_TAG_PATTERN.exec(input)?.[0];
}

/**
 * options.mysqlDashCommentRequiresWhitespace opts into MySQL's rule that a bare "--" only starts
 * a line comment when followed by whitespace/EOL, since MySQL reserves unspaced "--" for
 * double-negation (e.g. `SELECT 1--1`). Defaults to false so every existing caller keeps today's
 * dialect-generic "-- always starts a comment" behavior; only callers targeting a confirmed
 * MySQL-family grammar should opt in.
 *
 * options.mysqlBackslashEscape opts into MySQL-style `\x` escaping inside '...' strings. Also
 * dialect-gated (not a global default -- see readQuotedString's doc comment for why an
 * unconditional default is unsafe): only dialects confirmed to actually use backslash escaping by
 * convention (MySQL and its close wire-protocol/grammar clones) should opt in.
 *
 * By default "..." is always identifier quoting (never a string literal), matching MySQL's own
 * dialect adapter (see semantic/dialect.ts), which lists '"' as one of its valid identifierQuotes
 * -- this is correct for every dialect where "..." unconditionally means identifier (Postgres,
 * SQL Server's ANSI mode, MySQL running with the ANSI_QUOTES sql_mode) and is what every existing
 * caller other than sqlCompletion.ts's literal-masking layer wants.
 *
 * options.mysqlDoubleQuoteIsString flips that for MySQL's actual default sql_mode (ANSI_QUOTES
 * *disabled*, which is the overwhelming majority of real MySQL/MySQL-protocol installs): under
 * that mode "..." is a string literal with exactly the same escaping rules as '...' (doubled-quote
 * and, per mysqlBackslashEscape, backslash escaping), unconditionally -- not just after an
 * operator. Whether ANSI_QUOTES is actually enabled on the connected server is runtime state this
 * tokenizer can't see, so callers opt into this only when they want the common-case default
 * (sqlCompletion.ts's maskSqlLiteralsAndComments); leaving it off keeps modeling the ANSI_QUOTES
 * (identifier) interpretation.
 */
export function tokenizeSqlSemantic(input: string, dialectId = "mysql", options?: { mysqlDashCommentRequiresWhitespace?: boolean; mysqlBackslashEscape?: boolean; mysqlDoubleQuoteIsString?: boolean }): SqlSemanticToken[] {
  const tokens: SqlSemanticToken[] = [];
  const mysqlDashCommentRequiresWhitespace = !!options?.mysqlDashCommentRequiresWhitespace;
  const mysqlBackslashEscape = !!options?.mysqlBackslashEscape;
  const mysqlDoubleQuoteIsString = !!options?.mysqlDoubleQuoteIsString;
  let index = 0;
  let depth = 0;

  while (index < input.length) {
    const start = index;
    const ch = input[index] ?? "";
    const next = input[index + 1] ?? "";

    if (/\s/.test(ch)) {
      index += 1;
      continue;
    }

    if (ch === "-" && next === "-" && (!mysqlDashCommentRequiresWhitespace || index + 2 >= input.length || /\s/.test(input[index + 2] ?? ""))) {
      index += 2;
      while (index < input.length && input[index] !== "\n" && input[index] !== "\r") index += 1;
      tokens.push(token("comment", input.slice(start, index), start, index, depth));
      continue;
    }

    if (ch === "#" && dialectId === "mysql") {
      index += 1;
      while (index < input.length && input[index] !== "\n" && input[index] !== "\r") index += 1;
      tokens.push(token("comment", input.slice(start, index), start, index, depth));
      continue;
    }

    if (ch === "#" && dialectId === "postgres") {
      index += 1;
      tokens.push(token("operator", ch, start, index, depth));
      continue;
    }

    if (ch === "/" && next === "*") {
      index += 2;
      while (index < input.length && !(input[index] === "*" && input[index + 1] === "/")) index += 1;
      index = Math.min(input.length, index + (index < input.length ? 2 : 0));
      tokens.push(token("comment", input.slice(start, index), start, index, depth));
      continue;
    }

    if (ch === "'") {
      index = readQuotedString(input, start, "'", mysqlBackslashEscape);
      tokens.push(token("string", input.slice(start, index), start, index, depth, "'"));
      continue;
    }

    if (ch === "$") {
      const marker = matchDollarQuoteTag(input, start);
      if (marker) {
        const closing = input.indexOf(marker, start + marker.length);
        index = closing < 0 ? input.length : closing + marker.length;
        tokens.push(token("string", input.slice(start, index), start, index, depth, marker));
        continue;
      }
    }

    if (ch === '"') {
      if (mysqlDoubleQuoteIsString) {
        index = readQuotedString(input, start, '"', mysqlBackslashEscape);
        tokens.push(token("string", input.slice(start, index), start, index, depth, '"'));
      } else {
        index = readQuoted(input, start, '"', '"');
        tokens.push(token("quoted_identifier", input.slice(start, index), start, index, depth, '"'));
      }
      continue;
    }

    if (ch === "`") {
      index = readQuoted(input, start, "`", "`");
      tokens.push(token("quoted_identifier", input.slice(start, index), start, index, depth, "`"));
      continue;
    }

    if (ch === "[") {
      index = readQuoted(input, start, "[", "]");
      tokens.push(token("quoted_identifier", input.slice(start, index), start, index, depth, "["));
      continue;
    }

    if (ch === ":" || ch === "?") {
      index += 1;
      while (index < input.length && WORD_PART.test(input[index] ?? "")) index += 1;
      tokens.push(token("parameter", input.slice(start, index), start, index, depth));
      continue;
    }

    if (/[0-9]/.test(ch)) {
      index += 1;
      while (index < input.length && /[0-9.]/.test(input[index] ?? "")) index += 1;
      tokens.push(token("number", input.slice(start, index), start, index, depth));
      continue;
    }

    if (WORD_START.test(ch)) {
      index += 1;
      while (index < input.length && WORD_PART.test(input[index] ?? "") && !(dialectId === "postgres" && input[index] === "#")) index += 1;
      tokens.push(token("word", input.slice(start, index), start, index, depth));
      continue;
    }

    if ("(),.;*".includes(ch)) {
      if (ch === ")") depth = Math.max(0, depth - 1);
      tokens.push(token("punctuation", ch, start, start + 1, depth));
      if (ch === "(") depth += 1;
      index += 1;
      continue;
    }

    index += 1;
    tokens.push(token("operator", ch, start, index, depth));
  }

  return tokens;
}

export function tokenContainsPosition(tokenValue: SqlSemanticToken, position: number): boolean {
  return tokenValue.span.start <= position && position <= tokenValue.span.end;
}

export function isSuppressedSqlSemanticContext(tokens: readonly SqlSemanticToken[], cursor: number): boolean {
  return tokens.some((item) => (item.kind === "comment" || item.kind === "string") && item.span.start < cursor && cursor <= item.span.end);
}

export function findActiveSqlStatementSpan(sql: string, tokens: readonly SqlSemanticToken[], cursor: number): SqlSemanticSpan {
  let start = 0;
  let end = sql.length;
  for (const item of tokens) {
    if (item.kind !== "punctuation" || item.text !== ";" || item.depth !== 0) continue;
    if (item.span.end <= cursor) start = item.span.end;
    if (item.span.start >= cursor) {
      end = item.span.start;
      break;
    }
  }

  while (start < end && /\s/.test(sql[start] ?? "")) start += 1;
  while (end > start && /\s/.test(sql[end - 1] ?? "")) end -= 1;
  return { start, end };
}

export function unquoteSqlSemanticIdentifier(tokenValue: SqlSemanticToken): string {
  if (tokenValue.kind !== "quoted_identifier") return tokenValue.text;
  if (tokenValue.quote === "[") return tokenValue.text.slice(1, -1).replaceAll("]]", "]");
  const quote = tokenValue.quote ?? tokenValue.text[0] ?? "";
  return tokenValue.text.slice(1, -1).replaceAll(quote + quote, quote);
}

export function tokenIsIdentifier(tokenValue: SqlSemanticToken | undefined): tokenValue is SqlSemanticToken {
  return !!tokenValue && (tokenValue.kind === "word" || tokenValue.kind === "quoted_identifier");
}
