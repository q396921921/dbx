// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const backend = vi.hoisted(() => ({
  documentFindDocuments: vi.fn(),
  documentCountDocuments: vi.fn(),
  cancelQuery: vi.fn(),
  ensureConnected: vi.fn(),
}));

const dataGrid = vi.hoisted(() => ({
  paginate: undefined as ((offset: number, limit: number) => Promise<void>) | undefined,
  rows: [] as unknown[],
  appendedFromRowCount: undefined as number | undefined,
}));

const settings = vi.hoisted(() => ({
  editorSettings: {
    pageSize: 2,
    infiniteScroll: true,
    mongoViewMode: "table" as "document" | "table",
    columnWidthDensity: "standard" as "compact" | "standard" | "comfortable",
    dataGridRenderMode: "canvas" as "canvas" | "dom",
    tableFontFamily: "system-ui",
    tableFontSize: 12,
    numericColumnRightAlign: true,
    confirmDangerousSqlExecution: true,
    exportBatchSize: 2,
    exportRowLimitEnabled: false,
    exportRowLimit: 100_000,
  },
  updateEditorSettings: vi.fn(),
}));

vi.mock("vue-i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vue-i18n")>()),
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("@/lib/backend/api", () => ({
  getColumns: vi.fn(),
  documentFindDocuments: backend.documentFindDocuments,
  documentCountDocuments: backend.documentCountDocuments,
  dynamodbDescribeTable: vi.fn(),
  cancelQuery: backend.cancelQuery,
  documentInsertDocument: vi.fn(),
  documentUpdateDocument: vi.fn(),
  documentDeleteDocument: vi.fn(),
  documentSaveMeilisearchBatch: vi.fn(),
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({ ensureConnected: backend.ensureConnected }),
}));

vi.mock("@/stores/settingsStore", () => ({
  TABLE_FONT_SIZE_MIN: 8,
  TABLE_FONT_SIZE_MAX: 16,
  useSettingsStore: () => settings,
}));

vi.mock("@/components/grid/DataGrid.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      name: "DataGridStub",
      inheritAttrs: false,
      props: {
        result: { type: Object, required: true },
      },
      setup(props, { attrs, expose }) {
        dataGrid.paginate = attrs.onPaginate as typeof dataGrid.paginate;
        expose({
          visibleColumnCount: 2,
          displayableColumnCount: 2,
          hiddenColumnCount: 0,
          orderedColumnLayoutOptions: [],
          filteredColumnLayoutOptions: () => [],
          toggleColumnVisibility: vi.fn(),
          showAllColumns: vi.fn(),
          invertColumnVisibility: vi.fn(),
          hasCustomColumnOrder: false,
          moveDisplayableColumn: vi.fn(),
          resetColumnOrder: vi.fn(),
          nullColumnsHidden: false,
          canToggleAllNullColumns: false,
          allNullColumnCount: 0,
          toggleAllNullColumns: vi.fn(),
          multiRowTranspose: false,
          setMultiRowTranspose: vi.fn(),
        });
        return () => {
          const result = props.result as { rows?: unknown[]; appended_from_row_count?: number };
          dataGrid.rows = result.rows ?? [];
          dataGrid.appendedFromRowCount = result.appended_from_row_count;
          return h("div", { "data-testid": "data-grid" });
        };
      },
    }),
  };
});

vi.mock("@/components/redis/RedisJsonEditor.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      props: { modelValue: { type: String, required: true } },
      setup(props) {
        return () => h("div", {}, props.modelValue);
      },
    }),
  };
});

vi.mock("@/components/ui/popover", async () => {
  const { defineComponent, h } = await import("vue");
  const passthrough = (name: string) =>
    defineComponent({
      name,
      setup(_, { slots }) {
        return () => h("div", slots.default?.());
      },
    });
  return { Popover: passthrough("PopoverStub"), PopoverTrigger: passthrough("PopoverTriggerStub"), PopoverContent: passthrough("PopoverContentStub") };
});

vi.mock("@/components/ui/select", async () => {
  const { defineComponent, h } = await import("vue");
  const passthrough = (name: string) =>
    defineComponent({
      name,
      setup(_, { slots }) {
        return () => h("div", slots.default?.());
      },
    });
  return { Select: passthrough("SelectStub"), SelectContent: passthrough("SelectContentStub"), SelectItem: passthrough("SelectItemStub"), SelectTrigger: passthrough("SelectTriggerStub"), SelectValue: passthrough("SelectValueStub") };
});

import DocumentBrowser from "@/components/document/DocumentBrowser.vue";

let app: App<Element> | null = null;
let root: HTMLDivElement | null = null;

async function flushUi() {
  for (let index = 0; index < 4; index++) {
    await Promise.resolve();
    await nextTick();
  }
}

beforeEach(async () => {
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  });
  backend.documentFindDocuments.mockReset();
  backend.documentCountDocuments.mockReset();
  backend.cancelQuery.mockReset();
  backend.ensureConnected.mockReset();
  backend.ensureConnected.mockResolvedValue(undefined);
  backend.documentCountDocuments.mockResolvedValue(0);
  dataGrid.paginate = undefined;
  dataGrid.rows = [];
  dataGrid.appendedFromRowCount = undefined;
  settings.editorSettings.pageSize = 2;
  settings.editorSettings.infiniteScroll = true;

  root = document.createElement("div");
  document.body.appendChild(root);
});

afterEach(() => {
  app?.unmount();
  root?.remove();
  app = null;
  root = null;
  vi.unstubAllGlobals();
});

describe("DocumentBrowser infinite scroll (issue #6455)", () => {
  it("appends the next segment onto the currently loaded documents instead of replacing them", async () => {
    backend.documentFindDocuments
      .mockResolvedValueOnce({
        documents: [
          { _id: "1", name: "row_1" },
          { _id: "2", name: "row_2" },
        ],
        total: 4,
        total_is_exact: true,
      })
      .mockResolvedValueOnce({
        documents: [
          { _id: "3", name: "row_3" },
          { _id: "4", name: "row_4" },
        ],
        total: 4,
        total_is_exact: true,
      });

    app = createApp(DocumentBrowser, {
      connectionId: "mongo-1",
      database: "test",
      collection: "docs",
      databaseType: "mongodb",
    });
    app.mount(root!);
    await flushUi();

    expect(dataGrid.rows).toHaveLength(2);
    expect(dataGrid.appendedFromRowCount).toBeUndefined();

    expect(dataGrid.paginate).toBeTypeOf("function");
    await dataGrid.paginate!(2, 2);
    await flushUi();

    expect(backend.documentFindDocuments.mock.calls[1]!.slice(0, 5)).toEqual(["mongo-1", "test", "docs", 2, 2]);
    // The second page must be grafted onto the first, not replace it —
    // otherwise scrolling past the first batch silently discards it (#6455).
    expect(dataGrid.rows).toHaveLength(4);
    expect(dataGrid.rows.map((row) => (row as unknown[])[1])).toEqual(["row_1", "row_2", "row_3", "row_4"]);
    expect(dataGrid.appendedFromRowCount).toBe(2);
  });

  it("replaces the documents instead of appending when infinite scroll is disabled", async () => {
    settings.editorSettings.infiniteScroll = false;
    backend.documentFindDocuments
      .mockResolvedValueOnce({
        documents: [
          { _id: "1", name: "row_1" },
          { _id: "2", name: "row_2" },
        ],
        total: 4,
        total_is_exact: true,
      })
      .mockResolvedValueOnce({
        documents: [
          { _id: "3", name: "row_3" },
          { _id: "4", name: "row_4" },
        ],
        total: 4,
        total_is_exact: true,
      });

    app = createApp(DocumentBrowser, {
      connectionId: "mongo-1",
      database: "test",
      collection: "docs",
      databaseType: "mongodb",
    });
    app.mount(root!);
    await flushUi();

    await dataGrid.paginate!(2, 2);
    await flushUi();

    // Classic next-page navigation must keep replacing the page, not accumulate rows.
    expect(dataGrid.rows).toHaveLength(2);
    expect(dataGrid.rows.map((row) => (row as unknown[])[1])).toEqual(["row_3", "row_4"]);
    expect(dataGrid.appendedFromRowCount).toBeUndefined();
  });
});
