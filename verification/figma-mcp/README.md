# Figma MCP 参考工件

`untitled-node-1-90-reference.json` 是由 Figma MCP 对设计文件 `sOpexHz9cP8FTWJ8BvqBY2` 的节点 `1:90` 读取设计上下文、获取截图并导出 PNG 后生成的无凭据 provenance。对应的 1920×1080 RGBA PNG 存在于 `fixtures/golden-images/figma-mcp-untitled-node-1-90.png`；sidecar 固定其 SHA-256，同时只保存稳定的设计链接，不保存短期 MCP asset URL、会话参数或凭据。

该节点是一整套聊天工作台界面，不是实施方案规定的 `api-prototype-card-flow` 或 `F-M6-SPECIAL-NODES` fixture。因此它是 MCP 访问与本地参考工件链路的验收证据，**不是**这两个 Runtime/Render fixture 的 RGBA Gate 通过证据，也不可用来放宽它们的阈值。

要为真正对应的 fixture 建立 MCP 基线，选择其精确的 Figma 节点后执行：

```text
pnpm baseline:figma-visual -- --mcp-url <figma-design-node-url> --references <node-paths.json> --out <sidecar.json> --fixture <fixture-id> --browser "Figma MCP server export" --dpr <dpr>
```

在此之前必须先用 Figma MCP 获取该节点的设计上下文和截图，再将 MCP 导出的 PNG 审核后存入 `fixtures/golden-images/`。离线 RGBA 比较只接受这个固定本地引用和尺寸、色彩归一化完全相同的项目渲染输出。
