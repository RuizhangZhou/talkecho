import { useEffect, useState } from "react";
import { PageLayout } from "@/layouts";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button, Input } from "@/components";
import { useSettings } from "@/hooks";

const Dashboard = () => {
  const {
    selectedAIProvider,
    onSetSelectedAIProvider,
    onSetSelectedSttProvider,
  } = useSettings();

  const [groqApiKey, setGroqApiKey] = useState("");
  const [status, setStatus] = useState<"idle" | "success" | "error">("idle");
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (selectedAIProvider.provider === "groq") {
      setGroqApiKey(selectedAIProvider.variables?.api_key || "");
    }
  }, [selectedAIProvider.provider, selectedAIProvider.variables]);

  const handleSaveGroqKey = () => {
    if (!groqApiKey.trim()) {
      setStatus("error");
      return;
    }

    setIsSaving(true);
    setStatus("idle");

    try {
      const apiKeyValue = groqApiKey.trim();
      onSetSelectedAIProvider({
        provider: "groq",
        variables: {
          api_key: apiKeyValue,
          model: "llama-3.1-8b-instant",
        },
      });
      onSetSelectedSttProvider({
        provider: "groq",
        variables: {
          api_key: apiKeyValue,
          model: "whisper-large-v3-turbo",
        },
      });
      setStatus("success");
    } catch (error) {
      console.error("Failed to save Groq API key:", error);
      setStatus("error");
    } finally {
      setIsSaving(false);
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
              <Input
                type="password"
                placeholder="sk-********************************"
                value={groqApiKey}
                onChange={(e) => {
                  setGroqApiKey(e.target.value);
                  if (status !== "idle") setStatus("idle");
                }}
                className="h-11"
              />
              <p className="text-xs text-muted-foreground">
                Stored locally. Used for Groq Whisper + Llama 3.1 automatically.
              </p>
            </div>

            <Button
              onClick={handleSaveGroqKey}
              disabled={isSaving || !groqApiKey.trim()}
              className="w-full"
            >
              {isSaving ? "Saving..." : "Save & Enable Groq"}
            </Button>

            {status === "success" && (
              <p className="text-xs text-green-600 bg-green-500/10 p-2 rounded-md">
                ✓ Groq is ready! TalkEcho will use Whisper + Llama 3.1 with your
                key.
              </p>
            )}
            {status === "error" && (
              <p className="text-xs text-red-600 bg-red-500/10 p-2 rounded-md">
                Please paste a valid Groq API key and try again.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </PageLayout>
  );
};

export default Dashboard;
