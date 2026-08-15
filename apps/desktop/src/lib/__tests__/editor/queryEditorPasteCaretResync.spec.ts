import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { computePasteCaretResyncTarget } from "@/lib/editor/queryEditorPasteCaretResync";

const queryEditorSource = readFileSync(new URL("../../../components/editor/QueryEditor.vue", import.meta.url), "utf8");

describe("computePasteCaretResyncTarget", () => {
  it("nudges forward when there is room after the caret", () => {
    expect(computePasteCaretResyncTarget(3, 10)).toBe(4);
  });

  it("nudges backward when the caret is at the end of the document", () => {
    expect(computePasteCaretResyncTarget(10, 10)).toBe(9);
  });

  it("returns null for an empty document (nowhere to nudge to)", () => {
    expect(computePasteCaretResyncTarget(0, 0)).toBeNull();
  });
});

describe("QueryEditor paste caret resync wiring", () => {
  it("resyncs the caret after any input.paste transaction", () => {
    expect(queryEditorSource).toMatch(/update\.transactions\.some\(\(tr\) => tr\.isUserEvent\("input\.paste"\)\)[\s\S]*?resyncCaretAfterPaste\(update\.view\)/);
  });
});
