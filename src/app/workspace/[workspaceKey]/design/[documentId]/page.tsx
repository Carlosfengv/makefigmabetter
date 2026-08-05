import { WorkspaceEditor } from "@/components/workspace/workspace-editor";

export default async function DesignPage({ params }: { params: Promise<{ workspaceKey: string; documentId: string }> }) {
  const { workspaceKey, documentId } = await params;
  return <WorkspaceEditor workspaceKey={workspaceKey} documentId={documentId} />;
}
