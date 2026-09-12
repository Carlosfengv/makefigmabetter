#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: pnpm baseline:figma-visual -- (--oracle <oracle.json> | --mcp-url <figma-design-url>) --references <node-paths.json> --out <baseline.json> --fixture <id> --browser <name> --dpr <number> [--format png] [--scale 1] [--figma-api-version v1] [--typings-version 1.134.0] [--color-profile srgb] [--normalization decode-png,premultiply-rgba] [--max-channel-delta 0] [--max-mismatched-pixels 0] [--max-mean-channel-delta 0]");
  } else {
    try {
      const output = await createBaseline(args);
      console.log(JSON.stringify(output, null, 2));
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Could not create Figma visual baseline.");
      process.exitCode = 2;
    }
  }
}

export async function createBaseline(args, cwd = process.cwd()) {
  const required = ["references", "out", "fixture", "browser", "dpr"];
  if (required.some((key) => !args[key])) throw new Error("Missing required baseline argument.");
  const paths = JSON.parse(await readFile(resolve(cwd, args.references), "utf8"));
  if (Boolean(args.oracle) === Boolean(args.mcpUrl)) throw new Error("Provide exactly one of Oracle provenance or a Figma MCP design URL.");
  const source = args.oracle ? await readOracleSource(args.oracle, cwd) : readMcpSource(args.mcpUrl, args);
  const request = source;
  if (!paths || typeof paths !== "object" || Array.isArray(paths)) throw new Error("Invalid reference path map.");
  const nodeIds = [...new Set(request.nodeIds)].sort();
  if (Object.keys(paths).length !== nodeIds.length || nodeIds.some((id) => typeof paths[id] !== "string")) throw new Error("Reference paths must cover every Oracle node exactly once.");
  const references = Object.fromEntries(await Promise.all(nodeIds.map(async (nodeId) => {
    const referencePath = paths[nodeId];
    const absolute = resolve(cwd, referencePath);
    const goldenRoot = resolve(cwd, "fixtures/golden-images");
    if (!inside(goldenRoot, absolute) || !/^fixtures\/golden-images\/[A-Za-z0-9._/-]+\.(?:png|jpg|svg)$/u.test(referencePath)) throw new Error(`Unsafe reference path for ${nodeId}.`);
    const bytes = await readFile(absolute);
    return [nodeId, { path: referencePath, sha256: createHash("sha256").update(bytes).digest("hex") }];
  })));
  const dpr = Number(args.dpr);
  const threshold = {
    maxChannelDelta: numberInRange(args.maxChannelDelta ?? "0", 0, 255, true),
    maxMismatchedPixels: numberInRange(args.maxMismatchedPixels ?? "0", 0, Number.MAX_SAFE_INTEGER, true),
    maxMeanChannelDelta: numberInRange(args.maxMeanChannelDelta ?? "0", 0, 255, false),
  };
  const colorProfile = args.colorProfile ?? "srgb";
  if (!Number.isFinite(dpr) || dpr < .5 || dpr > 8 || !["srgb", "display-p3"].includes(colorProfile)) throw new Error("Invalid baseline environment.");
  const normalization = String(args.normalization ?? "decode-png,premultiply-rgba").split(",").map((value) => value.trim()).filter(Boolean);
  if (!normalization.length) throw new Error("Baseline normalization must be non-empty.");
  const baseline = {
    format: "makefigma-figma-visual-baseline-v1",
    fixtureId: args.fixture,
    capturedAt: args.capturedAt ?? new Date().toISOString(),
    source: source.provider === "figma-images-rest"
      ? { provider: source.provider, fileKey: request.fileKey, nodeIds, endpoint: source.endpoint, format: request.format, scale: request.scale, figmaApiVersion: args.figmaApiVersion ?? "v1", pluginTypingsVersion: args.typingsVersion ?? "1.134.0" }
      : { provider: source.provider, fileKey: request.fileKey, nodeIds, designUrl: source.designUrl, format: request.format, scale: request.scale, figmaApiVersion: args.figmaApiVersion ?? "not-disclosed-by-mcp", pluginTypingsVersion: args.typingsVersion ?? "1.134.0" },
    environment: { browser: args.browser, dpr, colorProfile, normalization },
    references,
    threshold,
  };
  const out = resolve(cwd, args.out);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(baseline, null, 2)}\n`);
  return baseline;
}

async function readOracleSource(oraclePath, cwd) {
  const oracle = JSON.parse(await readFile(resolve(cwd, oraclePath), "utf8"));
  const request = oracle?.request;
  if (!request || typeof request.fileKey !== "string" || !Array.isArray(request.nodeIds) || !request.nodeIds.length || !["png", "jpg", "svg"].includes(request.format) || !Number.isFinite(request.scale) || typeof request.endpoint !== "string") throw new Error("Invalid Oracle provenance.");
  return { provider: "figma-images-rest", ...request };
}

function readMcpSource(value, args) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Invalid Figma MCP design URL."); }
  const match = /^\/design\/([^/]+)\/[^/]+/u.exec(url.pathname);
  const sourceNodeId = url.searchParams.get("node-id");
  const nodeId = sourceNodeId?.replace("-", ":");
  const format = args.format ?? "png";
  const scale = Number(args.scale ?? "1");
  if (url.protocol !== "https:" || !/(^|\.)figma\.com$/u.test(url.hostname) || !match || !nodeId || !["png", "jpg", "svg"].includes(format) || !Number.isFinite(scale) || scale <= 0 || scale > 4) throw new Error("Invalid Figma MCP design URL.");
  url.search = new URLSearchParams({ "node-id": sourceNodeId }).toString();
  url.hash = "";
  return { provider: "figma-mcp", fileKey: decodeURIComponent(match[1]), nodeIds: [nodeId], designUrl: url.toString(), format, scale };
}

function parseArgs(values) {
  const args = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--") continue;
    if (value === "--help") { args.help = true; continue; }
    if (!value.startsWith("--") || index + 1 >= values.length) throw new Error("Invalid baseline argument.");
    args[value.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = values[++index];
  }
  return args;
}
function numberInRange(value, min, max, integer) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max || integer && !Number.isSafeInteger(parsed)) throw new Error("Invalid visual threshold.");
  return parsed;
}
function inside(root, value) { const path = relative(root, value); return path && !path.startsWith(`..${sep}`) && path !== ".." && !path.includes(`${sep}..${sep}`); }
