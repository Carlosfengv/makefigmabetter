import { createNode, documentColorFromCssHex, type CanvasNode, type Viewport } from "./editor-protocol";

export const TEST_OPERATIONS_DASHBOARD_FIXTURE_NAME = "F-TEST-OPERATIONS-DASHBOARD";

export type TestOperationsDashboardFixture = {
  format: "makefigma-test-operations-dashboard-v1";
  name: typeof TEST_OPERATIONS_DASHBOARD_FIXTURE_NAME;
  viewport: Viewport;
  nodes: CanvasNode[];
};

const rootId = "00000000-0000-4000-8000-000000006001";
let sequence = 6001;

function node(kind: CanvasNode["kind"], name: string, x: number, y: number, width: number, height: number, fill: string, extras: Partial<CanvasNode> = {}): CanvasNode {
  sequence += 1;
  const draft = {
    ...createNode(kind, x, y),
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    parentId: rootId,
    name,
    width,
    height,
    fill,
    stroke: "transparent",
    strokeWidth: 0,
    radius: 0,
    ...extras,
  };
  // Dashboard layers are a real Frame subtree, not a legacy flat scene. The
  // explicit matrix keeps x/y as readable local values while making painting,
  // hit testing and Frame clipping resolve against the same parent space.
  return {
    ...draft,
    relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: draft.x, f: draft.y },
    // createNode materializes a paint for its preset. Replace it whenever the
    // fixture changes the CSS fallback so Rust/WASM and Canvas agree on color.
    fillColor: documentColorFromCssHex(draft.fill),
    fillGradient: undefined,
    strokeColor: documentColorFromCssHex(draft.stroke),
    strokeGradient: undefined,
  };
}

function text(name: string, value: string, x: number, y: number, width: number, height: number, color = "#1d2738", extras: Partial<CanvasNode> = {}) {
  return node("text", name, x, y, width, height, color, { text: value, ...extras });
}

/** A realistic, editable operations dashboard used for Canvas-layer testing.
 * Every visible item is a canonical Frame, Rectangle, or Text CanvasNode. */
export function createTestOperationsDashboardFixture(): TestOperationsDashboardFixture {
  sequence = 6001;
  const root = {
    ...createNode("frame", -640, -400),
    id: rootId,
    name: "测试运营后台 Dashboard · 1440",
    width: 1280,
    height: 800,
    fill: "#f5f7fb",
    stroke: "#cfd7e6",
    strokeWidth: 1,
    radius: 0,
    clipsContent: true,
    fillColor: documentColorFromCssHex("#f5f7fb"),
    strokeColor: documentColorFromCssHex("#cfd7e6"),
  };
  const nodes: CanvasNode[] = [
    root,
    node("rectangle", "Sidebar", 0, 0, 210, 800, "#172033"),
    node("rectangle", "Topbar", 210, 0, 1070, 58, "#ffffff"),
    node("rectangle", "Topbar divider", 210, 57, 1070, 1, "#dce3ee"),
    text("Product mark", "M/ops", 30, 30, 125, 26, "#ffffff"),
    text("Workspace badge", "TEST ENVIRONMENT", 30, 74, 145, 16, "#8fa0bd"),
    nav("▦", "测试总览", 30, 126, true),
    nav("⌁", "API 健康", 30, 170),
    nav("◷", "运行记录", 30, 214),
    nav("▧", "资源通道", 30, 258),
    node("rectangle", "Sidebar status divider", 28, 709, 154, 1, "#3a4963"),
    node("ellipse", "Healthy indicator", 30, 737, 8, 8, "#b9e76f"),
    text("Sidebar status", "测试数据 · 不连接生产", 46, 730, 144, 20, "#a9b6cb"),
    text("Document title", "测试运营后台 Dashboard", 238, 20, 330, 23, "#202a3b"),
    node("ellipse", "Topbar healthy dot", 1090, 24, 8, 8, "#8bcf53"),
    text("Topbar environment", "测试环境", 1105, 19, 66, 20, "#64748b"),
    node("ellipse", "User avatar", 1222, 14, 30, 30, "#27354c"),
    text("User initials", "WF", 1229, 20, 17, 16, "#ffffff"),
    text("Eyebrow", "QUALITY CONTROL / 01", 250, 101, 240, 17, "#3567c8"),
    text("Page heading", "测试运营总览", 250, 130, 390, 42, "#172033"),
    text("Page description", "聚合文档、资源和工作区 API 的可用性与回归信号", 250, 182, 470, 22, "#6b7a90"),
    range("24h", 968, false), range("7d", 1012, true), range("30d", 1056, false),
    text("Range label · 24h", "24h", 978, 171, 24, 15, "#63748b"),
    text("Range label · 7d", "7d", 1026, 171, 18, 15, "#ffffff"),
    text("Range label · 30d", "30d", 1064, 171, 27, 15, "#63748b"),
    node("rectangle", "Export button", 1118, 163, 126, 32, "#23324a", { radius: 4 }),
    text("Export label", "导出日报  ↗", 1137, 171, 89, 16, "#ffffff"),
    node("rectangle", "Live signal strip", 250, 226, 994, 37, "#edf3e5", { radius: 4 }),
    node("ellipse", "Live signal dot", 268, 241, 8, 8, "#83c846"),
    text("Live signal", "所有核心契约处于预期范围内", 286, 236, 220, 18, "#2a3d28"),
    text("Sampling time", "上次采样 10:32", 516, 236, 110, 18, "#718065"),
    text("Filter action", "仅看待跟进项", 1138, 236, 89, 18, "#3567c8"),
  ];

  const metrics = [
    ["运行通过率", "99.4%", "较昨日 +0.3%", "#eaf4d8"],
    ["已执行断言", "2,782", "4 条 API 契约", "#ffffff"],
    ["待处理回归", "03", "均为非阻断项", "#fff1d6"],
    ["P95 响应", "138ms", "阈值：≤ 200ms", "#edf2ff"],
  ] as const;
  metrics.forEach(([label, value, detail, fill], index) => {
    const x = 250 + index * 252;
    nodes.push(node("rectangle", `KPI card · ${label}`, x, 284, 238, 132, fill, { radius: 4, stroke: "#dce3ee", strokeWidth: 1 }));
    nodes.push(text(`KPI label · ${label}`, label, x + 16, 300, 160, 18, "#65748a"));
    nodes.push(text(`KPI value · ${label}`, value, x + 16, 328, 190, 35, index === 3 ? "#3567c8" : "#172033"));
    nodes.push(text(`KPI detail · ${label}`, detail, x + 16, 381, 178, 17, "#6b7a90"));
  });

  nodes.push(
    node("rectangle", "Trend panel", 250, 435, 634, 292, "#ffffff", { radius: 4, stroke: "#dce3ee", strokeWidth: 1 }),
    text("Trend eyebrow", "REQUEST STABILITY", 270, 453, 180, 15, "#3567c8"),
    text("Trend title", "契约检查趋势", 270, 477, 220, 26, "#172033"),
    text("Trend legend", "成功率", 808, 482, 56, 17, "#6b7a90"),
    node("rectangle", "Chart baseline", 272, 663, 576, 1, "#dce3ee"),
    text("Trend caption", "基于协议生成、Mock 接口和服务端适配器检查", 270, 688, 300, 17, "#6b7a90"),
    text("Trend action", "查看运行详情  →", 736, 688, 112, 17, "#3567c8"),
    node("rectangle", "Attention panel", 902, 435, 342, 292, "#ffffff", { radius: 4, stroke: "#dce3ee", strokeWidth: 1 }),
    text("Attention eyebrow", "ATTENTION QUEUE", 922, 453, 160, 15, "#3567c8"),
    text("Attention title", "待跟进项", 922, 477, 156, 26, "#172033"),
    node("ellipse", "Attention total", 1192, 459, 28, 28, "#f4cb78"),
    text("Attention total label", "03", 1200, 465, 13, 15, "#25334b"),
  );

  const bars = [55, 71, 64, 85, 78, 92, 83, 104, 89, 96, 112, 94];
  bars.forEach((height, index) => nodes.push(node("rectangle", `Trend bar ${index + 1}`, 286 + index * 43, 650 - height, 19, height, index % 4 === 1 ? "#9bd35b" : "#3567c8")));
  const followups = [["M", "慢查询波动", "Workspace API · 09:48", "+32ms", "#f4cb78"], ["L", "图片重复上传", "Asset API · 08:16", "2 cases", "#dce8ff"], ["L", "视觉回归待确认", "Canvas renderer · 昨日", "review", "#dce8ff"]] as const;
  followups.forEach(([level, title, source, value, chip], index) => {
    const y = 522 + index * 51;
    nodes.push(node("rectangle", `Followup divider ${index + 1}`, 922, y - 8, 302, 1, "#e5eaf2"));
    nodes.push(node("rectangle", `Severity ${level} ${index + 1}`, 922, y + 3, 20, 20, chip, { radius: 2 }));
    nodes.push(text(`Severity label ${index + 1}`, level, 928, y + 6, 8, 12, "#25334b"));
    nodes.push(text(`Followup title ${index + 1}`, title, 953, y, 142, 16, "#25334b"));
    nodes.push(text(`Followup source ${index + 1}`, source, 953, y + 19, 165, 14, "#6b7a90"));
    nodes.push(text(`Followup value ${index + 1}`, value, 1161, y + 6, 57, 14, "#6b7a90"));
  });
  return { format: "makefigma-test-operations-dashboard-v1", name: TEST_OPERATIONS_DASHBOARD_FIXTURE_NAME, viewport: { x: 0, y: 0, zoom: .78 }, nodes };
}

function nav(icon: string, label: string, x: number, y: number, active = false): CanvasNode {
  return text(`Navigation · ${label}`, `${icon}   ${label}`, x, y, 150, 24, active ? "#ffffff" : "#a9b6cb", active ? { fill: "#2d4161" } : {});
}

function range(label: string, x: number, active: boolean): CanvasNode {
  return node("rectangle", `Range control · ${label}`, x, 163, 44, 32, active ? "#23324a" : "#eef2f8", { radius: 0 });
}
