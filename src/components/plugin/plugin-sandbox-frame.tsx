"use client";

import { useEffect, useRef } from "react";
import {
  pluginSandboxContentSecurityPolicy,
  validatePluginManifest,
  type PluginManifest,
} from "../../runtime/plugin-sandbox";
import { PluginSandboxBridge } from "../../runtime/plugin-sandbox-bridge";
import type { PluginSandboxSession } from "../../runtime/plugin-sandbox";
import {
  pluginBundleBootstrap,
  validatePluginBundle,
  type PluginBundle,
} from "../../runtime/plugin-bundle";

/** No same-origin token: an untrusted plugin keeps an opaque origin. */
export const PLUGIN_SANDBOX_ATTRIBUTE = "allow-scripts";
export const DEFAULT_PLUGIN_SANDBOX_MANIFEST = validatePluginManifest({
  id: "com.makefigma.sandbox-fixture",
  name: "Plugin isolation fixture",
  apiVersion: 1,
  permissions: [],
});

export function pluginSandboxSrcDoc(
  label: string,
  manifest: PluginManifest = DEFAULT_PLUGIN_SANDBOX_MANIFEST,
  bundle?: PluginBundle,
): string {
  const safeLabel = JSON.stringify(label).replaceAll("<", "\\u003c");
  const csp = pluginSandboxContentSecurityPolicy(manifest);
  const bootstrap = bundle
    ? pluginBundleBootstrap(validatePluginBundle(bundle, manifest))
    : "";
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Plugin isolation fixture</title>
<style>body{margin:0;padding:16px;background:#fbfbf8;color:#292c24;font:13px system-ui,sans-serif}main{border:1px solid #d4d5cb;border-radius:8px;padding:14px}p{margin:6px 0 0;color:#6b6e65}</style>
</head><body><main><strong id="plugin-name"></strong><p>Opaque-origin plugin UI fixture. No host capability is granted.</p></main>
<script>document.getElementById('plugin-name').textContent=${safeLabel};document.documentElement.dataset.parentReadable=String((()=>{try{return Boolean(window.parent.document)}catch{return false}})());</script>
${bootstrap}
</body></html>`;
}

export function PluginSandboxFrame({
  label = "Plugin isolation fixture",
  manifest = DEFAULT_PLUGIN_SANDBOX_MANIFEST,
  session,
  bundle,
}: {
  label?: string;
  manifest?: PluginManifest;
  session?: PluginSandboxSession;
  bundle?: PluginBundle;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const pluginWindow = frame.current?.contentWindow;
    if (!session || !pluginWindow || session.manifest.id !== manifest.id)
      return;
    const bridge = new PluginSandboxBridge(session, pluginWindow);
    const receive = (event: MessageEvent) => {
      void bridge.handleMessage(event);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [manifest.id, session]);
  return (
    <iframe
      ref={frame}
      className="block h-40 w-full rounded-lg border bg-background"
      title={manifest.name}
      sandbox={PLUGIN_SANDBOX_ATTRIBUTE}
      referrerPolicy="no-referrer"
      srcDoc={pluginSandboxSrcDoc(label, manifest, bundle)}
    />
  );
}
