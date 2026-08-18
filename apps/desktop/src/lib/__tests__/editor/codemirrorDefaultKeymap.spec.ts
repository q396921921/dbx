// @vitest-environment happy-dom

import { defaultKeymap } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, runScopeHandlers } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { defaultKeymapWithoutIndentBrackets } from "@/lib/editor/codemirrorDefaultKeymap";

describe("defaultKeymapWithoutIndentBrackets", () => {
  it("drops the built-in Mod-[ and Mod-] bindings", () => {
    const filtered = defaultKeymapWithoutIndentBrackets(defaultKeymap);
    expect(filtered.find((binding) => binding.key === "Mod-[")).toBeUndefined();
    expect(filtered.find((binding) => binding.key === "Mod-]")).toBeUndefined();
  });

  it("keeps the other default bindings intact", () => {
    const filtered = defaultKeymapWithoutIndentBrackets(defaultKeymap);
    const keys = filtered.map((binding) => binding.key);
    expect(keys).toContain("Mod-a");
    expect(keys).toContain("Backspace");
    expect(keys).toContain("Mod-Home");
  });

  it("baseline: the stock defaultKeymap consumes Ctrl+[ (the bug being fixed, see #6418)", () => {
    const view = new EditorView({
      parent: document.createElement("div"),
      state: EditorState.create({
        extensions: [keymap.of([...defaultKeymap])],
      }),
    });

    expect(runScopeHandlers(view, new KeyboardEvent("keydown", { key: "[", ctrlKey: true }), "editor")).toBe(true);
    view.destroy();
  });

  it("no longer consumes Ctrl+[, letting the event bubble to the global shortcut handler", () => {
    const view = new EditorView({
      parent: document.createElement("div"),
      state: EditorState.create({
        extensions: [keymap.of([...defaultKeymapWithoutIndentBrackets(defaultKeymap)])],
      }),
    });

    expect(runScopeHandlers(view, new KeyboardEvent("keydown", { key: "[", ctrlKey: true }), "editor")).toBe(false);
    view.destroy();
  });

  it("no longer consumes Ctrl+], letting the event bubble to the global shortcut handler", () => {
    const view = new EditorView({
      parent: document.createElement("div"),
      state: EditorState.create({
        extensions: [keymap.of([...defaultKeymapWithoutIndentBrackets(defaultKeymap)])],
      }),
    });

    expect(runScopeHandlers(view, new KeyboardEvent("keydown", { key: "]", ctrlKey: true }), "editor")).toBe(false);
    view.destroy();
  });
});
