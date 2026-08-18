import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../DataGrid.vue", import.meta.url), "utf8");

describe("DataGrid context extractor lifecycle", () => {
  it("clears the right-click target after the context-menu action has started", () => {
    expect(source).toContain('@open="onGridContextMenuOpen"');
    expect(source).toContain('@close="onGridContextMenuClose"');
    expect(source).toContain("queueMicrotask(() => {");
    expect(source).toContain("invalidateSyntheticContextSelection();");
  });

  it("snapshots the context column before awaiting, so the close-menu microtask above can't null it out mid-build", () => {
    // contextFilterCondition ("Filter by This Value" etc.) awaits hydrateLargeValueCell
    // before building the request. onGridContextMenuClose's queueMicrotask (asserted
    // above) fires in that same window and nulls contextCell/contextColumn — so the
    // function must capture what it needs into locals up front instead of re-reading
    // the live refs afterward, or the built request silently gets a null columnName.
    const fn = source.slice(source.indexOf("async function contextFilterCondition"), source.indexOf("async function applyContextFilter"));
    expect(fn).toMatch(/const columnName = contextColumn\.value;/);
    expect(fn).toMatch(/await hydrateLargeValueCell/);
    const awaitIndex = fn.indexOf("await hydrateLargeValueCell");
    const afterAwait = fn.slice(awaitIndex);
    expect(afterAwait).not.toContain("contextColumn.value");
    expect(afterAwait).not.toContain("contextCellValue.value");
    expect(afterAwait).toContain("columnName,");
  });
});
