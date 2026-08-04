import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { compatibilityMatrixViolations } from "./compatibility-matrix.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceRoot = join(root, "src");
const extensions = new Set([".ts", ".tsx", ".js", ".jsx"]);
const violations = [];
const files = walk(sourceRoot);

if (existsSync(join(sourceRoot, "pages"))) violations.push("Pages Router is forbidden; use src/app only.");
if (existsSync(join(sourceRoot, "app", "api"))) violations.push("Next business API routes are forbidden; web and backend remain independently deployable.");
if (files.some((file) => relative(sourceRoot, file).replaceAll("\\", "/").startsWith("app/") && file.endsWith("/route.ts"))) violations.push("Next Route Handlers are forbidden; web and backend remain independently deployable.");

for (const file of files) {
  const relativePath = relative(root, file).replaceAll("\\", "/");
  const source = readFileSync(file, "utf8");
  const imports = [...source.matchAll(/\bimport(?:[\s\S]*?\sfrom\s*)?["']([^"']+)["']/g)].map((match) => match[1]);
  const isPrimitive = relativePath.startsWith("src/components/ui/");
  for (const specifier of imports) {
    if (!isPrimitive && isExternalUiLibrary(specifier)) violations.push(`${relativePath}: business code must import local primitives from @/components/ui, not ${specifier}.`);
    if (isPrimitive && isUiImplementationDependency(specifier)) violations.push(`${relativePath}: components/ui cannot depend on ${specifier}.`);
  }
}

const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
for (const dependency of Object.keys({ ...packageJson.dependencies, ...packageJson.devDependencies })) {
  if (isAdditionalUiLibrary(dependency)) violations.push(`package.json: additional UI library ${dependency} is not allowlisted.`);
}
verifyShadcnBaseConfiguration(packageJson);
verifyIndependentBackendContract();
violations.push(...compatibilityMatrixViolations(root));

if (violations.length) {
  console.error("Frontend boundary check failed:\n" + violations.map((message) => `- ${message}`).join("\n"));
  process.exit(1);
}

console.log(`Frontend boundaries verified across ${files.length} source files.`);

function walk(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "wasm" ? [] : walk(path);
    return extensions.has(entry.name.slice(entry.name.lastIndexOf("."))) ? [path] : [];
  });
}

function isExternalUiLibrary(specifier) {
  return specifier === "@base-ui/react" || specifier.startsWith("@radix-ui/") || specifier === "react-aria" || specifier.startsWith("@react-aria/") || specifier.startsWith("@mui/") || specifier === "antd";
}

function isUiImplementationDependency(specifier) {
  return specifier.startsWith("@/workers/") || specifier === "@/lib/local-document" || specifier === "@/lib/transaction-batch" || specifier === "@/lib/diagnostics" || specifier === "@/lib/performance-sampling";
}

function isAdditionalUiLibrary(dependency) {
  return dependency.startsWith("@radix-ui/") || dependency === "react-aria" || dependency.startsWith("@react-aria/") || dependency.startsWith("@mui/") || dependency === "antd" || dependency.startsWith("@chakra-ui/");
}

function verifyShadcnBaseConfiguration(packageJson) {
  let config;
  try { config = JSON.parse(readFileSync(join(root, "components.json"), "utf8")); } catch { violations.push("components.json must be present and valid JSON."); return; }
  let baseline;
  try { baseline = JSON.parse(readFileSync(join(root, "verification", "phase0", "0.14", "shadcn-info-baseline.json"), "utf8")); } catch { violations.push("Phase 0.14 shadcn info baseline must be present and valid JSON."); }
  if (typeof config.style !== "string" || !config.style.startsWith("base-")) violations.push("components.json must freeze a shadcn Base UI style (base-*). ");
  if (config.rsc !== true || config.tsx !== true || config.tailwind?.cssVariables !== true) violations.push("components.json must keep RSC, TSX, and Tailwind CSS variables enabled.");
  const aliases = config.aliases ?? {};
  for (const [key, value] of Object.entries({ components: "@/components", ui: "@/components/ui", lib: "@/lib", hooks: "@/hooks", utils: "@/lib/utils" })) {
    if (aliases[key] !== value) violations.push(`components.json aliases.${key} must equal ${value}.`);
  }
  if (!(packageJson.dependencies?.["@base-ui/react"] || packageJson.devDependencies?.["@base-ui/react"])) violations.push("package.json must pin @base-ui/react for the configured Base UI primitives.");
  if (!files.some((file) => relative(root, file).replaceAll("\\", "/").startsWith("src/components/ui/") && readFileSync(file, "utf8").includes("@base-ui/react/"))) violations.push("components/ui must contain a local Base UI primitive implementation.");
  if (baseline) {
    if (baseline.format !== "makefigma-shadcn-info-baseline-v1" || baseline.config?.base !== "base") violations.push("Phase 0.14 shadcn info baseline must record the Base UI adapter.");
    if (baseline.config?.style !== config.style) violations.push("components.json style must match the reviewed Phase 0.14 shadcn baseline.");
    if (baseline.config?.rsc !== config.rsc || baseline.config?.typescript !== config.tsx) violations.push("components.json RSC/TSX settings must match the reviewed Phase 0.14 shadcn baseline.");
  }
}

function verifyIndependentBackendContract() {
  if (!existsSync(join(root, "services", "mock-backend", "server.mjs"))) violations.push("services/mock-backend/server.mjs must provide the independently deployable backend boundary.");
  if (!packageJson.scripts?.["mock:backend"] || !packageJson.scripts?.["mock:backend:check"]) violations.push("package.json must provide independent mock-backend run and check scripts.");
  for (const file of files) {
    if (readFileSync(file, "utf8").includes("services/mock-backend")) violations.push(`${relative(root, file)}: the web source must not import the independent backend process.`);
  }
}
