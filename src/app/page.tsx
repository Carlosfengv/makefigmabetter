import { EditorShell } from "@/components/editor/editor-shell";
import { DEMO_WORKSPACE_KEY } from "@/lib/workspace-store";
import { redirect } from "next/navigation";

/** The normal entrypoint is the workspace catalogue. Fixture URLs deliberately
 * retain the direct canvas entrypoint so deterministic editor evidence can be
 * captured without creating or mutating a workspace document. */
export default async function Home({ searchParams }: { searchParams: Promise<{ fixture?: string }> }) {
  const { fixture } = await searchParams;
  if (fixture) return <EditorShell />;
  redirect(`/workspace/${DEMO_WORKSPACE_KEY}`);
}
