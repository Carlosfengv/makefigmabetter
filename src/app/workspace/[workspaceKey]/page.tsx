import { WorkspaceShell } from "@/components/workspace/workspace-shell";

export default async function WorkspacePage({ params }: { params: Promise<{ workspaceKey: string }> }) {
  const { workspaceKey } = await params;
  return <WorkspaceShell workspaceKey={workspaceKey} />;
}
