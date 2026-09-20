import { useState } from "react";
import { PageLayout } from "@/layouts";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button, SecretInput } from "@/components";
import { useSettings } from "@/hooks";
import { providerSecretRef } from "@/lib";

const Dashboard = () => {
  const { onSetSelectedAIProvider, onSetSelectedSttProvider } = useSettings();

  const [status, setStatus] = useState<"idle" | "success">("idle");

  const handleGroqCredentialChange = (configured: boolean) => {
    if (configured) {
      onSetSelectedAIProvider({
        provider: "groq",
        variables: {
          model: "llama-3.1-8b-instant",
        },
        secretRef: providerSecretRef("ai", "groq"),
      });
      onSetSelectedSttProvider({
        provider: "groq",
        variables: {
          model: "whisper-large-v3-turbo",
        },
        secretRef: providerSecretRef("stt", "groq"),
      });
      setStatus("success");
    } else {
      setStatus("idle");
    }
  };

  return (
    <PageLayout
      title="Dashboard"
      description="TalkEcho Alpha - free for personal use. Bring your own Groq API key and start captioning instantly."
    >
      <div className="grid gap-4">
        <Card className="shadow-none border border-border/70 rounded-xl">
          <CardHeader>
            <CardTitle>Alpha Access</CardTitle>
            <CardDescription>
              TalkEcho runs entirely on your device. Audio never leaves your
              machine unless you explicitly send it to the STT/LLM provider you
              configure.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>
              Overlay defaults: translucent, always-on-top window that captures
              both microphone and system audio for stealth subtitles.
            </p>
            <p>
              Shortcut cheatsheet: <strong>Ctrl+Shift+M</strong> toggles system
              audio, <strong>Ctrl+Shift+A</strong> toggles mic capture, and
              <strong>Ctrl+Shift+D</strong> opens this dashboard.
            </p>
          </CardContent>
        </Card>

        <Card className="shadow-none border border-border/70 rounded-xl">
          <CardHeader>
            <CardTitle>Groq Quickstart</CardTitle>
            <CardDescription>
              Connect your Groq account once—we’ll wire Groq Whisper + Llama
              3.1 automatically.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground space-y-4">
            <ol className="list-decimal space-y-2 pl-5 text-foreground">
              <li>
                Visit{" "}
                <Button
                  variant="link"
                  className="px-0 text-primary"
                  onClick={() =>
                    window.open("https://console.groq.com/keys", "_blank")
                  }
                >
                  console.groq.com/keys
                </Button>{" "}
                and generate an API key.
              </li>
              <li>Paste it below and click “Save & Enable”.</li>
              <li>
                Optional: tweak your system prompt under Settings → Context if
                you need a custom workflow.
              </li>
            </ol>

            <div className="space-y-2">
              <SecretInput
                secretRef={providerSecretRef("ai", "groq")}
                additionalSecretRefs={[providerSecretRef("stt", "groq")]}
                onConfiguredChange={handleGroqCredentialChange}
              />
              <p className="text-xs text-muted-foreground">
                Stored in your operating system's credential manager. Used for
                Groq Whisper + Llama 3.1 automatically.
              </p>
            </div>

            {status === "success" && (
              <p className="text-xs text-green-600 bg-green-500/10 p-2 rounded-md">
                ✓ Groq is ready! TalkEcho will use Whisper + Llama 3.1 with your
                key.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </PageLayout>
  );
};

export default Dashboard;
