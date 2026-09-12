import { runtimeError } from "./runtime-errors";
import type { PluginManifest } from "./plugin-sandbox";

export const MAX_PLUGIN_BUNDLE_BYTES = 256 * 1024;
export type PluginBundle = Readonly<{ pluginId: string; uiJavaScript: string }>;

/**
 * Validates a self-contained UI bundle before it reaches `srcDoc`. The bundle
 * is never used as HTML: the frame bootstrap decodes base64 bytes into a
 * dynamically created script node, which prevents `</script>` injection while
 * retaining opaque-origin execution.
 */
export function validatePluginBundle(value: unknown, manifest: PluginManifest): PluginBundle {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw runtimeError("INVALID_ARGUMENT");
  const bundle = value as Record<string, unknown>;
  if (bundle.pluginId !== manifest.id || typeof bundle.uiJavaScript !== "string" || !bundle.uiJavaScript.trim() || bundle.uiJavaScript.includes("\0") || new TextEncoder().encode(bundle.uiJavaScript).byteLength > MAX_PLUGIN_BUNDLE_BYTES) throw runtimeError("INVALID_ARGUMENT");
  return { pluginId: manifest.id, uiJavaScript: bundle.uiJavaScript };
}

export function pluginBundleBootstrap(bundle: PluginBundle): string {
  const encoded = bytesToBase64(new TextEncoder().encode(bundle.uiJavaScript));
  return `<script>(()=>{const encoded="${encoded}";const binary=atob(encoded);const bytes=new Uint8Array(binary.length);for(let index=0;index<binary.length;index+=1)bytes[index]=binary.charCodeAt(index);const script=document.createElement("script");script.text=new TextDecoder().decode(bytes);document.head.append(script);})();</script>`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
