#!/usr/bin/env node

import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import sharp from "sharp";

const [evidenceDirectory, outputPath = `${evidenceDirectory}/pixel-verification.json`] = process.argv.slice(2);
if (!evidenceDirectory) {
  console.error("Usage: node scripts/verify-text-path-structured-pixels.mjs <evidence-directory> [output-json]");
  process.exit(64);
}

const runCount = Number(process.env.TEXT_PATH_STRUCTURED_RUNS ?? "2");
if (!Number.isInteger(runCount) || runCount < 1) throw new Error("TEXT_PATH_STRUCTURED_RUNS must be a positive integer");

const images = new Map();
for (let run = 1; run <= runCount; run += 1) {
  for (const renderer of ["auto", "canvas2d"]) {
    const path = `${evidenceDirectory}/run-${run}-${renderer}-canvas.png`;
    const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (info.channels !== 4) throw new Error(`${path} did not decode to RGBA`);
    images.set(`${run}:${renderer}`, { path, data, width: info.width, height: info.height });
  }
}

const dimensions = new Set([...images.values()].map((image) => `${image.width}x${image.height}`));
if (dimensions.size !== 1) throw new Error(`Canvas screenshots do not share one size: ${[...dimensions].join(", ")}`);
const first = images.values().next().value;
if (!first || first.width < 1_300 || first.height < 900)
  throw new Error(`Expected the fixed large viewport canvas, received ${first?.width ?? 0}x${first?.height ?? 0}`);

const origin = { x: Math.floor(first.width / 2), y: Math.floor(first.height / 2) };
const regions = {
  clip: region(origin.x - 548, origin.y - 158, 336, 256, { changedPixels: 1, maxChannelDelta: 1 }),
  mask: region(origin.x - 168, origin.y - 158, 336, 256),
  effect: region(origin.x + 160, origin.y - 210, 460, 390),
};
for (const [name, value] of Object.entries(regions)) {
  if (value.left < 0 || value.top < 0 || value.left + value.width > first.width || value.top + value.height > first.height)
    throw new Error(`${name} region falls outside the captured Canvas`);
}

const comparisons = [];
for (let run = 1; run <= runCount; run += 1) {
  for (const [name, value] of Object.entries(regions))
    comparisons.push(compare(`run-${run}:auto-vs-canvas2d:${name}`, images.get(`${run}:auto`), images.get(`${run}:canvas2d`), value));
}
for (let run = 2; run <= runCount; run += 1) {
  for (const renderer of ["auto", "canvas2d"]) {
    for (const [name, value] of Object.entries(regions))
      comparisons.push(compare(`run-1-vs-run-${run}:${renderer}:${name}`, images.get(`1:${renderer}`), images.get(`${run}:${renderer}`), value));
  }
}

const failed = comparisons.filter((entry) => !entry.passed);
const report = {
  format: "makefigma-text-path-structured-pixel-verification-v1",
  dimensions: { width: first.width, height: first.height },
  origin,
  regions,
  comparisons,
  result: failed.length === 0 ? "passed" : "failed",
};
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
if (failed.length) {
  console.error(JSON.stringify({ result: report.result, failed }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ result: report.result, comparisons: comparisons.length, outputPath }));

function region(left, top, width, height, tolerance = {}) {
  return {
    left,
    top,
    width,
    height,
    tolerance: {
      changedPixels: tolerance.changedPixels ?? 0,
      maxChannelDelta: tolerance.maxChannelDelta ?? 0,
    },
  };
}

function compare(label, leftImage, rightImage, selectedRegion) {
  if (!leftImage || !rightImage) throw new Error(`Missing image for ${label}`);
  const left = pixelsForRegion(leftImage, selectedRegion);
  const right = pixelsForRegion(rightImage, selectedRegion);
  let changedPixels = 0;
  let maxChannelDelta = 0;
  for (let index = 0; index < left.length; index += 4) {
    let changed = false;
    for (let channel = 0; channel < 4; channel += 1) {
      const delta = Math.abs(left[index + channel] - right[index + channel]);
      maxChannelDelta = Math.max(maxChannelDelta, delta);
      changed ||= delta > 0;
    }
    if (changed) changedPixels += 1;
  }
  const passed = changedPixels <= selectedRegion.tolerance.changedPixels
    && maxChannelDelta <= selectedRegion.tolerance.maxChannelDelta;
  return {
    label,
    leftSha256: sha256(left),
    rightSha256: sha256(right),
    changedPixels,
    maxChannelDelta,
    passed,
  };
}

function pixelsForRegion(image, selectedRegion) {
  const output = Buffer.alloc(selectedRegion.width * selectedRegion.height * 4);
  for (let row = 0; row < selectedRegion.height; row += 1) {
    const sourceStart = ((selectedRegion.top + row) * image.width + selectedRegion.left) * 4;
    image.data.copy(output, row * selectedRegion.width * 4, sourceStart, sourceStart + selectedRegion.width * 4);
  }
  return output;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
