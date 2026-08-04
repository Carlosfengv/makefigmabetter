import { PluginSandboxFrame } from "@/components/plugin/plugin-sandbox-frame";

/** An explicit Phase 0 isolation harness; it does not expose a plugin runtime. */
export default function PluginSandboxPage() {
  return <main className="plugin-sandbox-page"><h1>Plugin isolation harness</h1><p>This fixture proves the host can render opaque-origin plugin UI without granting host capabilities.</p><PluginSandboxFrame /></main>;
}
