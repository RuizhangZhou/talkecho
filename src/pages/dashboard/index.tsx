import { PageLayout } from "@/layouts";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const Dashboard = () => {
  return (
    <PageLayout
      title="Dashboard"
      description="TalkEcho Alpha - free for personal use. Bring your own AI/STT keys, no license key required."
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
              Configure TalkEcho for "German meeting -> Chinese/English
              translation" using Groq&apos;s API.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground space-y-2">
            <ol className="list-decimal space-y-2 pl-5 text-foreground">
              <li>Create a Groq account and generate an API key.</li>
              <li>
                In TalkEcho Settings -> AI Providers, add Groq Llama-3.1 as the
                completion model and paste your API key.
              </li>
              <li>
                In Speech-to-Text providers, pick Groq Whisper for real-time
                transcription.
              </li>
              <li>
                Start your meeting, press <strong>Ctrl+Shift+M</strong> +
                <strong>Ctrl+Shift+A</strong>, then choose the DE -> ZH/EN prompt
                preset to stream live captions.
              </li>
            </ol>
            <p>
              Need another provider? Use the same flow to plug in OpenAI,
              Anthropic, local Ollama endpoints, or any custom curl template.
            </p>
          </CardContent>
        </Card>
      </div>
    </PageLayout>
  );
};

export default Dashboard;
