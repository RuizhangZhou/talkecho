import {
  Button,
  Popover,
  PopoverTrigger,
  PopoverContent,
  ScrollArea,
} from "@/components";
import {
  AlertCircleIcon,
  LoaderIcon,
  AudioLinesIcon,
  PlayIcon,
  SquareIcon,
} from "lucide-react";
import { Header } from "./Header";
import { SetupInstructions } from "./SetupInstructions";
import { OperationSection } from "./OperationSection";
import { PermissionFlow } from "./PermissionFlow";
import { useAudioOverlayType } from "@/hooks";
import { useApp } from "@/contexts";
import { StatusIndicator } from "./StatusIndicator";

export const SystemAudio = (props: useAudioOverlayType) => {
  const {
    capturing,
    isProcessing,
    isAIProcessing,
    lastTranscription,
    lastAIResponse,
    error,
    setupRequired,
    startCapture,
    stopCapture,
    isPopoverOpen,
    setIsPopoverOpen,
    openConversationPopover,
    startNewConversation,
    conversation,
    resizeWindow,
    handleSetup,
    vadConfig,
    isContinuousMode,
    isRecordingInContinuousMode,
    recordingProgress,
    manualStopAndSend,
    startContinuousRecording,
    ignoreContinuousRecording,
    scrollAreaRef,
    includeMicrophone,
    isMicProcessing,
  } = props;
  useApp();

  // Get microphone device name
  const handleToggleCapture = async () => {
    if (capturing) {
      await stopCapture();
    } else {
      openConversationPopover();
      await startCapture();
    }
  };

  const getButtonIcon = () =>
    capturing ? (
      <SquareIcon className="w-4 h-4" />
    ) : (
      <PlayIcon className="w-4 h-4" />
    );

  const getButtonTitle = () =>
    capturing ? "Stop system audio capture" : "Start system audio capture";

  return (
    <Popover open={isPopoverOpen} onOpenChange={() => {}}>
      <PopoverTrigger asChild>
        <Button
          size="icon"
          variant={capturing ? "secondary" : "outline"}
          title={getButtonTitle()}
          onClick={handleToggleCapture}
          className="cursor-pointer"
        >
          {getButtonIcon()}
        </Button>
      </PopoverTrigger>

      {isPopoverOpen ? (
        <PopoverContent
          align="start"
          side="bottom"
          className="select-none w-[calc(100vw-50px)] max-w-[800px] p-0 border overflow-hidden border-input/50"
          sideOffset={8}
        >
          <ScrollArea className="h-[calc(100vh-3rem)]" ref={scrollAreaRef}>
            <div className="p-4 space-y-3">
              <StatusIndicator
                setupRequired={setupRequired}
                error={error}
                isProcessing={isProcessing}
                isAIProcessing={isAIProcessing}
                capturing={capturing}
              />

              {/* Header - Hide when there are messages to save space */}
              {!lastTranscription && !lastAIResponse && (
                <Header
                  setupRequired={setupRequired}
                  setIsPopoverOpen={setIsPopoverOpen}
                  resizeWindow={resizeWindow}
                  capturing={capturing}
                />
              )}

              {/* Continuous Recording UI - Show when in continuous mode */}
              {isContinuousMode && (
                <div className="space-y-3">
                  <div className="border rounded-lg p-4">
                    <div className="flex items-start gap-3 mb-3">
                      {isProcessing || isAIProcessing ? (
                        <LoaderIcon className="w-5 h-5 animate-spin mt-0.5" />
                      ) : isRecordingInContinuousMode ? (
                        <AudioLinesIcon className="w-5 h-5 animate-pulse mt-0.5" />
                      ) : (
                        <AudioLinesIcon className="w-5 h-5 mt-0.5 opacity-50" />
                      )}
                      <div className="flex-1">
                        <h4 className="font-medium text-sm mb-1">
                          {isProcessing || isAIProcessing
                            ? "Processing Your Audio..."
                            : isRecordingInContinuousMode
                            ? "Recording Audio (Continuous Mode)"
                            : "Continuous Mode (Not Recording)"}
                        </h4>
                        <p className="text-xs text-muted-foreground">
                          {isProcessing || isAIProcessing
                            ? "Transcribing and generating AI response..."
                            : isRecordingInContinuousMode
                            ? `Recording up to ${vadConfig.max_recording_duration_secs}s. You can stop anytime.`
                            : "Click Start to begin recording, or adjust settings below."}
                        </p>
                      </div>
                    </div>

                    {/* Progress Bar - Only show when actively recording */}
                    {isRecordingInContinuousMode &&
                      !isProcessing &&
                      !isAIProcessing && (
                        <div className="space-y-2 mb-3">
                          <div className="flex justify-between text-xs text-muted-foreground">
                            <span>Duration: {recordingProgress}s</span>
                            <span>
                              Max: {vadConfig.max_recording_duration_secs}s
                            </span>
                          </div>
                          <div className="w-full bg-muted rounded-full h-2">
                            <div
                              className="bg-primary h-2 rounded-full transition-all duration-500"
                              style={{
                                width: `${
                                  (recordingProgress /
                                    vadConfig.max_recording_duration_secs) *
                                  100
                                }%`,
                              }}
                            />
                          </div>
                        </div>
                      )}

                    {/* Control Buttons */}
                    {!isProcessing && !isAIProcessing && (
                      <div className="grid grid-cols-3 gap-2">
                        {!isRecordingInContinuousMode ? (
                          <Button
                            onClick={startContinuousRecording}
                            variant="default"
                            className="col-span-3"
                            size="lg"
                          >
                            <AudioLinesIcon className="w-4 h-4 mr-2" />
                            Start Recording
                          </Button>
                        ) : (
                          <>
                            <Button
                              onClick={ignoreContinuousRecording}
                              variant="outline"
                              className="col-span-1"
                            >
                              Ignore
                            </Button>
                            <Button
                              onClick={manualStopAndSend}
                              variant="default"
                              className="col-span-2"
                            >
                              Stop & Send
                            </Button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Error Display - Show simple error messages for non-setup issues */}
              {error && !setupRequired && (
                <div className="space-y-3">
                  <div className="flex items-start gap-3">
                    <AlertCircleIcon className="w-5 h-5 text-red-500 mt-1 flex-shrink-0" />
                    <div className="space-y-2 w-full">
                      <div>
                        <h3 className="font-semibold text-xs mb-1 text-red-700">
                          Audio Capture Error
                        </h3>
                      </div>
                      <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                        <p className="text-xs text-red-800">{error}</p>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {setupRequired ? (
                // Enhanced Permission Flow
                <div className="space-y-4">
                  <PermissionFlow
                    onPermissionGranted={() => {
                      startCapture();
                    }}
                    onPermissionDenied={() => {
                      // Permission was denied, keep showing setup instructions
                    }}
                  />
                  <SetupInstructions
                    setupRequired={setupRequired}
                    handleSetup={handleSetup}
                  />
                </div>
              ) : (
                <>
                  {/* Conversation Display Only */}
                  <OperationSection
                    lastTranscription={lastTranscription}
                    lastAIResponse={lastAIResponse}
                    isAIProcessing={isAIProcessing}
                    conversation={conversation}
                    startNewConversation={startNewConversation}
                    includeMicrophone={includeMicrophone}
                    isMicProcessing={isMicProcessing}
                  />
                </>
              )}
            </div>
          </ScrollArea>
        </PopoverContent>
      ) : null}
    </Popover>
  );
};
