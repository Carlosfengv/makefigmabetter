import { runtimeError } from "./runtime-errors";

export type RuntimeStyleDocumentationLink = Readonly<{ uri: string }>;

export function validRuntimeStyleDocumentationLinks(value: unknown): value is readonly RuntimeStyleDocumentationLink[] {
  return Array.isArray(value)
    && value.length <= 1
    && value.every((link) => link && typeof link === "object"
      && "uri" in link
      && typeof link.uri === "string"
      && /^https?:\/\/[^\s]+$/u.test(link.uri)
      && new TextEncoder().encode(link.uri).byteLength <= 2_048);
}

export function runtimeStyleDocumentationLinks(value: unknown): Array<{ uri: string }> {
  if (!validRuntimeStyleDocumentationLinks(value)) throw runtimeError("INVALID_ARGUMENT");
  return value.map((link) => ({ uri: link.uri }));
}
