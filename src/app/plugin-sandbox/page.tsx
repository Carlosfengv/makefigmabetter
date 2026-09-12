import { PluginSandboxFrame } from "@/components/plugin/plugin-sandbox-frame";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/** An explicit M7 isolation harness. Host capabilities remain manifest-gated. */
export default function PluginSandboxPage() {
  return (
    <main className="mx-auto min-h-svh max-w-3xl p-6 md:p-12">
      <Card>
        <CardHeader>
          <CardTitle>Plugin isolation harness</CardTitle>
          <CardDescription>
            This fixture proves the host can render opaque-origin plugin UI
            without granting host capabilities by default.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PluginSandboxFrame />
        </CardContent>
      </Card>
    </main>
  );
}
