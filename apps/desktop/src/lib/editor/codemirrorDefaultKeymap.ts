import type { KeyBinding } from "@codemirror/view";

/**
 * `@codemirror/commands` 的 `defaultKeymap` 内置硬编码了 `Mod-[` = `indentLess`、
 * `Mod-]` = `indentMore`，与 DBX 的可配置快捷键体系冲突（同 codemirrorSearchKeymap.ts
 * 修复 `Mod-d` 冲突的思路）：
 *
 * - `indentLess`/`indentMore` 在 DBX 中已经是可配置快捷键（见 shortcutRegistry.ts，
 *   默认分别是 Shift+Tab 和未绑定），不依赖这两个硬编码绑定也能正常工作；
 * - 但只要用户把任意一个 `scope: "global"` 的动作（例如「切换侧边栏」，issue #6418）
 *   配置成 `Mod+[`/`Mod+]`，defaultKeymap 的硬编码绑定会在编辑器聚焦时抢先匹配并
 *   `preventDefault`，事件冒泡到 window 时 `defaultPrevented` 已经是 true，
 *   App.vue 的全局 handleKeydown 直接返回，用户配置的全局快捷键永远不会触发。
 *
 * 这里移除 `Mod-[`/`Mod-]` 绑定，保证用户可配置的快捷键优先于 CodeMirror 内置硬编码键位。
 */
export function defaultKeymapWithoutIndentBrackets(defaultKeymap: readonly KeyBinding[]): KeyBinding[] {
  return defaultKeymap.filter((binding) => binding.key !== "Mod-[" && binding.key !== "Mod-]");
}
