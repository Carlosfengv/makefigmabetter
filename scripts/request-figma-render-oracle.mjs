#!/usr/bin/env node

const values = new Map();
for (let index = 2; index < process.argv.length; index += 2) values.set(process.argv[index], process.argv[index + 1]);
const fileKey = values.get("--file");
const nodeIds = values.get("--nodes")?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
const format = values.get("--format") ?? "png";
const scale = Number(values.get("--scale") ?? "1");
const token = process.env.FIGMA_ACCESS_TOKEN;
if (!fileKey || !nodeIds.length || !token || !["png", "jpg", "svg"].includes(format) || !Number.isFinite(scale) || scale <= 0 || scale > 4) {
  console.error("Usage: FIGMA_ACCESS_TOKEN=… pnpm oracle:figma-render --file <file-key> --nodes <id,id> [--format png|jpg|svg] [--scale 1]");
  process.exitCode = 2;
} else {
  const params = new URLSearchParams({ ids: [...new Set(nodeIds)].sort().join(","), format, scale: String(scale) });
  const endpoint = `https://api.figma.com/v1/images/${encodeURIComponent(fileKey)}?${params}`;
  const response = await fetch(endpoint, { headers: { "X-Figma-Token": token } });
  if (!response.ok) {
    console.error(JSON.stringify({ status: response.status, endpoint }));
    process.exitCode = 1;
  } else {
    const payload = await response.json();
    const images = Object.fromEntries(Object.entries(payload.images ?? {}).filter(([nodeId, url]) => nodeIds.includes(nodeId) && typeof url === "string" && url.startsWith("https://")).sort(([left], [right]) => left.localeCompare(right)));
    if (!Object.keys(images).length) {
      console.error(JSON.stringify({ status: "INVALID_RESPONSE", endpoint }));
      process.exitCode = 1;
    } else console.log(JSON.stringify({ request: { fileKey, nodeIds: [...new Set(nodeIds)].sort(), format, scale, endpoint }, images }, null, 2));
  }
}
