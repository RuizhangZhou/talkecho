import {
  Card,
  Updater,
  DragButton,
  CustomCursor,
  Button,
  Input,
} from "@/components";
import { SystemAudio, AudioVisualizer } from "./components";
import { MessageSquareIcon } from "lucide-react";
import { useApp } from "@/hooks";
import { useApp as useAppContext } from "@/contexts";
import { invoke } from "@tauri-apps/api/core";
import { ErrorBoundary } from "react-error-boundary";
import { ErrorLayout } from "@/layouts";
import { getPlatform } from "@/lib";

const App = () => {
  const { systemAudio } = useApp();
  const { customizable } = useAppContext();
  const platform = getPlatform();

  const openDashboard = async () => {
    try {
      await invoke("open_dashboard");
    } catch (error) {
      console.error("Failed to open dashboard:", error);
    }
  };

  return (
    <ErrorBoundary
      fallbackRender={() => {
        return <ErrorLayout isCompact />;
      }}
      resetKeys={["app-error"]}
      onReset={() => {
        console.log("Reset");
      }}
    >
      <div className="w-screen h-screen flex overflow-hidden justify-center items-start">
        <Card className="w-[calc(100vw-40px)] max-w-[780px] !flex-row !items-center !gap-2 px-1 py-1">
          <SystemAudio {...systemAudio} />

          <div className="flex flex-1 flex-col sm:flex-row items-center gap-3 w-full">
            {systemAudio?.capturing ? (
              <div className="hidden sm:flex flex-none w-[200px]">
                <AudioVisualizer
                  stream={systemAudio?.stream}
                  isRecording={systemAudio?.capturing}
                />
              </div>
            ) : null}

            <div className="flex w-full flex-wrap items-center gap-2 justify-end">
              <form
                className="flex flex-1 items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  const formData = new FormData(event.currentTarget);
                  const value = (formData.get("barPrompt") as string)?.trim();
                  if (!value) return;
                  systemAudio?.openConversationPopover();
                  systemAudio?.sendManualPrompt(value);
                  event.currentTarget.reset();
                }}
              >
                <Input
                  name="barPrompt"
                  placeholder="Ask anything about the current meeting..."
                  className="flex-1"
                  disabled={systemAudio?.isAIProcessing}
                />
                <button type="submit" className="hidden" aria-hidden="true" />
              </form>
              <Button
                size="icon"
                variant={systemAudio?.isPopoverOpen ? "default" : "outline"}
                className="cursor-pointer"
                title="Toggle conversation panel"
                onClick={() => systemAudio?.toggleConversationPopover()}
              >
                <MessageSquareIcon className="h-4 w-4" />
              </Button>
              <Button
                size={"icon"}
                className="cursor-pointer"
                title="Open Dev Space"
                onClick={openDashboard}
              >
                <img
                  src="/images/talkecho.png"
                  alt="TalkEcho"
                  className="h-4 w-4"
                />
              </Button>
            </div>
          </div>

          <Updater />
          <DragButton />
        </Card>
        {customizable.cursor.type === "invisible" && platform !== "linux" ? (
          <CustomCursor />
        ) : null}
      </div>
    </ErrorBoundary>
  );
};

export default App;
