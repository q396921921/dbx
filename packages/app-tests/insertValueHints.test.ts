import { strict as assert } from "node:assert";
import { test } from "vitest";
import { buildInsertValueHints, expandToSqlStatementWindow, parseInsertValueHints, parseInsertValueHintsInRanges, parseInsertValuesClauses } from "../../apps/desktop/src/lib/sql/insertValueHints.ts";
import { insertValueHintColumnNames } from "../../apps/desktop/src/lib/sql/insertValueHintColumns.ts";

test("maps explicit column list to single-row VALUES", () => {
  const sql = "INSERT INTO auth_user (id, password, last_login) VALUES (5, 'hash', NULL)";
  const hints = parseInsertValueHints(sql);
  assert.deepEqual(
    hints.map((hint) => ({ column: hint.column, text: sql.slice(hint.from, hint.from + 1) })),
    [
      { column: "id", text: "5" },
      { column: "password", text: "'" },
      { column: "last_login", text: "N" },
    ],
  );
});

test("supports multi-row VALUES", () => {
  const sql = "INSERT INTO users (id, name) VALUES (1, 'a'), (2, 'b')";
  const hints = parseInsertValueHints(sql);
  assert.deepEqual(
    hints.map((hint) => hint.column),
    ["id", "name", "id", "name"],
  );
  assert.equal(sql.slice(hints[0]!.from, hints[0]!.from + 1), "1");
  assert.equal(sql.slice(hints[2]!.from, hints[2]!.from + 1), "2");
});

test("does not split nested parentheses inside a value", () => {
  const sql = "INSERT INTO t (a, b) VALUES (COALESCE(x, y), NOW())";
  const hints = parseInsertValueHints(sql);
  assert.deepEqual(
    hints.map((hint) => hint.column),
    ["a", "b"],
  );
  assert.ok(sql.slice(hints[0]!.from).startsWith("COALESCE(x, y)"));
  assert.ok(sql.slice(hints[1]!.from).startsWith("NOW()"));
});

test("does not split PostgreSQL dollar-quoted values", () => {
  const sql = "INSERT INTO t (body, count) VALUES ($tag$hello,(world),again$tag$, 2)";
  const hints = parseInsertValueHints(sql);
  assert.deepEqual(
    hints.map((hint) => hint.column),
    ["body", "count"],
  );
  assert.ok(sql.slice(hints[0]!.from).startsWith("$tag$hello,(world),again$tag$"));
  assert.equal(sql.slice(hints[1]!.from, hints[1]!.from + 1), "2");
});

test("skips SQL Server table hints before the INSERT column list", () => {
  const sql = "INSERT INTO dbo.Users WITH (TABLOCK) (id, name) VALUES (1, 'alice')";
  const hints = parseInsertValueHints(sql);
  assert.deepEqual(
    hints.map((hint) => hint.column),
    ["id", "name"],
  );
});

test("resolves columns from table metadata when column list is omitted", () => {
  const sql = "INSERT INTO users VALUES (1, 'alice')";
  const hints = parseInsertValueHints(sql, {
    resolveTableColumns: (table) => (table === "users" ? ["id", "name"] : undefined),
  });
  assert.deepEqual(
    hints.map((hint) => hint.column),
    ["id", "name"],
  );
});

test("skips SQL Server identity columns when mapping multi-row VALUES without a column list", () => {
  const sql = "INSERT INTO dbo.users VALUES (N'A', 1), (N'B', 2)";
  const columns = insertValueHintColumnNames("sqlserver", [
    { name: "id", is_identity: true },
    { name: "name" },
    { name: "status" },
  ]);
  const hints = parseInsertValueHints(sql, {
    resolveTableColumns: () => columns,
  });
  assert.deepEqual(
    hints.map((hint) => hint.column),
    ["name", "status", "name", "status"],
  );
});

test("skips SQL Server computed and temporal generated columns in positional hints", () => {
  const columns = insertValueHintColumnNames("sqlserver", [
    { name: "id", is_identity: true },
    { name: "quantity" },
    { name: "doubled", is_computed: true },
    { name: "note" },
    { name: "valid_from", is_hidden: true, generated_always_type: 1 },
    { name: "valid_to", is_hidden: true, generated_always_type: 2 },
  ]);

  assert.deepEqual(columns, ["quantity", "note"]);
});

test("skips visible SQL Server generated columns in positional hints", () => {
  assert.deepEqual(
    insertValueHintColumnNames("sqlserver", [
      { name: "name" },
      { name: "valid_from", generated_always_type: 1 },
      { name: "valid_to", generated_always_type: 2 },
    ]),
    ["name"],
  );
});

test("keeps identity columns in positional hints for databases other than SQL Server", () => {
  assert.deepEqual(
    insertValueHintColumnNames("postgres", [
      { name: "id", is_identity: true },
      { name: "name" },
    ]),
    ["id", "name"],
  );
});

test("returns no hints for INSERT ... SELECT", () => {
  const sql = "INSERT INTO users (id, name) SELECT id, name FROM staging";
  assert.deepEqual(parseInsertValueHints(sql), []);
  assert.deepEqual(parseInsertValuesClauses(sql), []);
});

test("caps hints when value count exceeds column count", () => {
  const sql = "INSERT INTO t (a, b) VALUES (1, 2, 3)";
  const hints = parseInsertValueHints(sql);
  assert.deepEqual(
    hints.map((hint) => hint.column),
    ["a", "b"],
  );
});

test("caps hints when column count exceeds value count", () => {
  const sql = "INSERT INTO t (a, b, c) VALUES (1, 2)";
  const hints = parseInsertValueHints(sql);
  assert.deepEqual(
    hints.map((hint) => hint.column),
    ["a", "b"],
  );
});

test("handles quoted identifiers in column list", () => {
  const sql = 'INSERT INTO "User" ("Id", "Name") VALUES (1, \'x\')';
  const hints = parseInsertValueHints(sql);
  assert.deepEqual(
    hints.map((hint) => hint.column),
    ["Id", "Name"],
  );
});

test("parses schema-qualified table without column list", () => {
  const clauses = parseInsertValuesClauses("INSERT INTO dbo.Users VALUES (1)");
  assert.equal(clauses.length, 1);
  assert.equal(clauses[0]?.table, "Users");
  assert.equal(clauses[0]?.schema, "dbo");
  assert.equal(clauses[0]?.database, undefined);
  assert.equal(clauses[0]?.columns, null);
});

test("preserves three-part database.schema.table qualifiers", () => {
  const clauses = parseInsertValuesClauses("INSERT INTO OtherDb.dbo.Users VALUES (1, 'a')");
  assert.equal(clauses.length, 1);
  assert.equal(clauses[0]?.database, "OtherDb");
  assert.equal(clauses[0]?.schema, "dbo");
  assert.equal(clauses[0]?.table, "Users");
});

test("preserves quoted three-part database.schema.table qualifiers", () => {
  const clauses = parseInsertValuesClauses('INSERT INTO "OtherDb"."dbo"."Users" VALUES (1)');
  assert.equal(clauses[0]?.database, "OtherDb");
  assert.equal(clauses[0]?.schema, "dbo");
  assert.equal(clauses[0]?.table, "Users");
});

test("routes three-part names through resolveTableColumns database argument", () => {
  const sql = "INSERT INTO OtherDb.dbo.Users VALUES (1, 'a')";
  const calls: Array<{ table: string; schema?: string; database?: string }> = [];
  const hints = parseInsertValueHints(sql, {
    resolveTableColumns: (table, schema, database) => {
      calls.push({ table, schema, database });
      if (database === "OtherDb" && schema === "dbo" && table === "Users") return ["id", "name"];
      return ["wrong_id"];
    },
  });
  assert.deepEqual(calls, [{ table: "Users", schema: "dbo", database: "OtherDb" }]);
  assert.deepEqual(
    hints.map((hint) => hint.column),
    ["id", "name"],
  );
});

test("parses only statement windows covering provided ranges", () => {
  const prefix = `${"SELECT 1;\n".repeat(200)}`;
  const insert = "INSERT INTO t (id, name) VALUES (1, 'x');";
  const suffix = `\n${"SELECT 2;\n".repeat(200)}`;
  const sql = `${prefix}${insert}${suffix}`;
  const insertFrom = prefix.length;
  const hints = parseInsertValueHintsInRanges(sql, [{ from: insertFrom, to: insertFrom + 10 }]);
  assert.deepEqual(
    hints.map((hint) => hint.column),
    ["id", "name"],
  );
  assert.equal(sql.slice(hints[0]!.from, hints[0]!.from + 1), "1");
});

test("expandToSqlStatementWindow stops at neighboring statements", () => {
  const sql = "SELECT 1; INSERT INTO t (a) VALUES (1); SELECT 2;";
  const insertAt = sql.indexOf("INSERT");
  const window = expandToSqlStatementWindow(sql, insertAt, insertAt + 6);
  assert.equal(sql.slice(window.from, window.to), "INSERT INTO t (a) VALUES (1)");
});

test("expandToSqlStatementWindow proves clean state when the cursor is more than 32KiB into an unterminated single-quoted string", () => {
  const body = "x".repeat(60_000);
  const sql = `SELECT '${body}', 'end';`;
  const cursor = sql.indexOf(body) + 40_000;
  const window = expandToSqlStatementWindow(sql, cursor, cursor);
  assert.equal(window.from, 0, "the backward scan must not land mid-string and mistake it for a statement boundary");
});

test("expandToSqlStatementWindow proves clean state when the cursor is more than 32KiB into an unterminated block comment", () => {
  const body = "chatter ".repeat(8_000);
  const sql = `SELECT /* ${body} */ 1;`;
  const cursor = sql.indexOf(body) + 40_000;
  const window = expandToSqlStatementWindow(sql, cursor, cursor);
  assert.equal(window.from, 0, "the backward scan must not land mid-comment and mistake it for a statement boundary");
});

test("expandToSqlStatementWindow proves clean state when the cursor is more than 32KiB into a dollar-quoted body full of semicolons", () => {
  const body = "SELECT 1; SELECT 2; ".repeat(3_000);
  const sql = `CREATE FUNCTION f() RETURNS void AS $$ ${body} $$ LANGUAGE sql;`;
  const cursor = sql.indexOf(body) + 40_000;
  const window = expandToSqlStatementWindow(sql, cursor, cursor);
  assert.equal(
    window.from,
    0,
    "semicolons inside a dollar-quoted function body are not statement boundaries, even past the lookback window",
  );
});

test("expandToSqlStatementWindow proves clean state when the cursor is more than 32KiB into deeply nested parens", () => {
  const opens = "(".repeat(2_000);
  const junk = `${"z".repeat(40_000)};${"z".repeat(2_000)}`;
  const closes = ")".repeat(2_000);
  const sql = `SELECT ${opens}${junk}${closes};`;
  const cursor = sql.indexOf(junk) + junk.length - 100;
  const window = expandToSqlStatementWindow(sql, cursor, cursor);
  assert.equal(
    window.from,
    0,
    "a ';' more than 32KiB past unclosed '(' characters is still nested, not a top-level statement boundary",
  );
});

test("expandToSqlStatementWindow stays bounded (fast path) for many small statements even far into the document", () => {
  const sql = Array.from({ length: 20_000 }, (_, index) => `SELECT ${index};`).join("\n");
  const cursor = sql.length - 10;
  const startedAt = performance.now();
  const window = expandToSqlStatementWindow(sql, cursor, cursor);
  const elapsedMs = performance.now() - startedAt;
  assert.ok(elapsedMs < 100, `expandToSqlStatementWindow took ${elapsedMs.toFixed(1)}ms`);
  assert.notEqual(window.from, 0, "should resolve via the bounded backward scan, not fall back to a full-document scan");
});

test("expandToSqlStatementWindow treats '#' as a dialect-sensitive operator/comment, matching tokenizeSqlSemantic", () => {
  const sql = "SELECT 5 # 3; SELECT 1;";
  const cursor = sql.indexOf("SELECT 1") + 4;
  // PostgreSQL: '#' is an operator (e.g. #, #>, #>>, #-), so this is two statements and the
  // window around the cursor must not include the unrelated first one.
  const postgresWindow = expandToSqlStatementWindow(sql, cursor, cursor, "postgres");
  assert.equal(sql.slice(postgresWindow.from, postgresWindow.to), "SELECT 1");
  // MySQL (and the default, unspecified dialect): '#' starts a line comment that never closes
  // (no trailing newline), so the ';' after it is inside the comment, not a real boundary -- the
  // whole input is one statement, matching tokenizeSqlSemantic's own MySQL tokenization.
  const mysqlWindow = expandToSqlStatementWindow(sql, cursor, cursor, "mysql");
  assert.equal(mysqlWindow.from, 0);
  const defaultWindow = expandToSqlStatementWindow(sql, cursor, cursor);
  assert.equal(defaultWindow.from, 0, "omitting dialectId must keep the prior default (mysql-like) behavior");
});

test("expandToSqlStatementWindow does not reallocate per '$' for many dollar-quote-marker lookalikes", () => {
  const placeholders = Array.from({ length: 20_000 }, (_, index) => `$${index}`).join(", ");
  const sql = `SELECT ${placeholders};`;
  const cursor = sql.length - 5;
  const startedAt = performance.now();
  expandToSqlStatementWindow(sql, cursor, cursor);
  const elapsedMs = performance.now() - startedAt;
  assert.ok(elapsedMs < 50, `expandToSqlStatementWindow took ${elapsedMs.toFixed(1)}ms scanning many '$' markers`);
});

test("expandToSqlStatementWindow reuses the cached result for identical (sql, from, to, dialectId) calls", () => {
  const sql = "SELECT 5 # 3; SELECT 1;";
  const cursor = sql.indexOf("SELECT 1") + 4;
  const first = expandToSqlStatementWindow(sql, cursor, cursor, "postgres");
  const second = expandToSqlStatementWindow(sql, cursor, cursor, "postgres");
  assert.equal(first, second, "identical args should return the memoized object, not a freshly computed one");
  const third = expandToSqlStatementWindow(sql, cursor, cursor);
  assert.notEqual(third, first, "a different dialectId must not reuse another dialect's cached window");
});

test("ignores statements that are not INSERT VALUES", () => {
  const sql = "SELECT 1; UPDATE users SET name = 'a' WHERE id = 1;";
  assert.deepEqual(parseInsertValueHints(sql), []);
});

test("scans large procedural sources without repeatedly filtering all tokens", () => {
  const sql = Array.from({ length: 6000 }, (_, index) => `v_value := v_value + ${index % 10};`).join("\n");
  const startedAt = performance.now();
  const hints = parseInsertValueHints(sql);
  const elapsedMs = performance.now() - startedAt;

  assert.deepEqual(hints, []);
  assert.ok(elapsedMs < 1000, `insert hint scan took ${elapsedMs.toFixed(1)}ms`);
});

test("buildInsertValueHints skips unresolved tables without metadata", () => {
  const clauses = parseInsertValuesClauses("INSERT INTO mystery VALUES (1, 2)");
  assert.deepEqual(buildInsertValueHints(clauses), []);
});
