"use client";

/** No same-origin token: an untrusted plugin keeps an opaque origin. */
export const PLUGIN_SANDBOX_ATTRIBUTE = "allow-scripts";

export function pluginSandboxSrcDoc(label: string): string {
  const safeLabel = JSON.stringify(label).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; connect-src 'none'; form-action 'none'; img-src data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
<title>Plugin isolation fixture</title>
<style>body{margin:0;padding:16px;background:#fbfbf8;color:#292c24;font:13px system-ui,sans-serif}main{border:1px solid #d4d5cb;border-radius:8px;padding:14px}p{margin:6px 0 0;color:#6b6e65}</style>
</head><body><main><strong id="plugin-name"></strong><p>Opaque-origin plugin UI fixture. No host capability is granted.</p></main>
<script>document.getElementById('plugin-name').textContent=${safeLabel};document.documentElement.dataset.parentReadable=String((()=>{try{return Boolean(window.parent.document)}catch{return false}})());</script>
</body></html>`;
}

export function PluginSandboxFrame({ label = "Phase 0 plugin isolation fixture" }: { label?: string }) {
  return <iframe
    className="plugin-sandbox-frame"
    title="Phase 0 plugin isolation fixture"
    sandbox={PLUGIN_SANDBOX_ATTRIBUTE}
    referrerPolicy="no-referrer"
    srcDoc={pluginSandboxSrcDoc(label)}
  />;
}
