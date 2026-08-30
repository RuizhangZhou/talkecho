import { Header } from "@/components";
import { Badge } from "@/components/ui";
import { getPlatform } from "@/lib";

interface DictationInfoProps {
  className?: string;
}

export const DictationInfo = ({ className }: DictationInfoProps) => {
  const platform = getPlatform();
  const supported = platform === "windows";

  return (
    <div id="dictation" className={`space-y-2 ${className}`}>
      <Header
        title="Dictation"
        description="Speak anywhere — TalkEcho cleans up filler words and types the result for you"
        isMainTitle
        rightSlot={
          <Badge variant={supported ? "default" : "secondary"}>
            {supported ? "Windows · Beta" : "Windows only (for now)"}
          </Badge>
        }
      />
      <p className="text-sm text-muted-foreground leading-relaxed">
        Press <span className="font-medium text-foreground">Right Ctrl</span> anywhere on your
        system to start dictating, and press it again to stop. TalkEcho transcribes your speech,
        runs it through a fast cleanup pass to strip out "um"s, repetition, and false starts, and
        then types the result directly where your cursor is. A small floating window shows the
        cleaned text with a copy button as a fallback if direct insertion isn't possible.
      </p>
      <p className="text-xs text-muted-foreground">
        Uses the Speech-to-Text and AI providers configured in{" "}
        <span className="font-medium text-foreground">Dev Space</span>.
        {supported &&
          " Right Ctrl is reserved by TalkEcho while it is running; Right Alt remains available for Typeless and AltGr input."}
        {!supported && " Support for macOS and Linux is planned for a future release."}
      </p>
    </div>
  );
};
