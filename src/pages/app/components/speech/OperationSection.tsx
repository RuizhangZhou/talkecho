import type { ChatConversation } from "@/hooks/useSystemAudio";
import { Button, Card, Markdown } from "@/components";
import {
  BotIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  HeadphonesIcon,
  MicIcon,
} from "lucide-react";
import { useState, useRef, useEffect } from "react";

type Props = {
  lastTranscription: string;
  lastAIResponse: string;
  isAIProcessing: boolean;
  conversation: ChatConversation;
  startNewConversation: () => void;
  includeMicrophone?: boolean; // 是否启用双轨模式
  isMicProcessing?: boolean; // 麦克风是否正在处理
};

export const OperationSection = ({
  lastTranscription,
  lastAIResponse,
  isAIProcessing,
  conversation,
  startNewConversation,
  includeMicrophone = false,
  isMicProcessing = false,
}: Props) => {
  const [openConversation, setOpenConversation] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // 按时间排序所有消息（最新的在底部）
  const sortedMessages = [...conversation.messages].sort(
    (a, b) => a.timestamp - b.timestamp
  );

  // 自动滚动到底部
  useEffect(() => {
    if (messagesEndRef.current && openConversation) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [conversation.messages.length, openConversation]);

  return (
    <div className="space-y-3">
      {(lastAIResponse || isAIProcessing) && !includeMicrophone && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <BotIcon className="w-3 h-3" />
            <h3 className="font-semibold text-xs">{`AI Assistant - answering to "${lastTranscription}"`}</h3>
          </div>
          <Card className="px-3 py-2 bg-transparent">
            {isAIProcessing && !lastAIResponse ? (
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full animate-pulse" />
                <p className="text-xs italic">Generating response...</p>
              </div>
            ) : (
              <p className="text-sm leading-relaxed whitespace-pre-wrap">
                {lastAIResponse ? <Markdown>{lastAIResponse}</Markdown> : null}
                {isAIProcessing && (
                  <span className="inline-block w-2 h-4 animate-pulse ml-1" />
                )}
              </p>
            )}
          </Card>
        </div>
      )}

      {includeMicrophone && sortedMessages.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3
              className="font-semibold text-md w-full cursor-pointer"
              onClick={() => setOpenConversation(!openConversation)}
            >
              Conversation
            </h3>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="icon"
                onClick={() => setOpenConversation(!openConversation)}
              >
                {openConversation ? (
                  <ChevronDownIcon className="h-4 w-4" />
                ) : (
                  <ChevronUpIcon className="h-4 w-4" />
                )}
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  startNewConversation();
                  setOpenConversation(false);
                }}
              >
                Start New
              </Button>
            </div>
          </div>

          {openConversation && (
            <div className="space-y-2">
              {sortedMessages.map((message) => {
                const isManualSource = message.source === "manual";
                const isRightSide =
                  message.source === "microphone" ||
                  (isManualSource && message.role === "user");
                const isUser = message.role === "user";

                let icon;
                if (message.source === "microphone") {
                  icon = isUser ? (
                    <MicIcon className="h-2.5 w-2.5 text-primary-foreground" />
                  ) : (
                    <BotIcon className="h-2.5 w-2.5 text-primary-foreground" />
                  );
                    } else if (isManualSource) {
                      icon = (
                        <img
                          src="/images/talkecho.png"
                          alt="TalkEcho"
                          className="h-2.5 w-2.5 object-contain"
                        />
                      );
                } else {
                  icon = isUser ? (
                    <HeadphonesIcon className="h-2.5 w-2.5 text-muted-foreground" />
                  ) : (
                    <BotIcon className="h-2.5 w-2.5 text-muted-foreground" />
                  );
                }

                const bubbleClass = isManualSource
                  ? isRightSide
                    ? "bg-purple-600 text-white border-purple-600"
                    : "bg-purple-50 text-purple-900 border border-purple-100"
                  : isRightSide
                  ? "bg-primary text-white border-primary"
                  : "bg-muted/50 text-foreground";

                const avatarClass = isManualSource
                  ? isRightSide
                    ? "bg-purple-600"
                    : "bg-purple-100"
                  : isRightSide
                  ? "bg-primary"
                  : "bg-primary/10";

                return (
                  <div
                    key={message.id}
                    className={`flex gap-1.5 ${
                      isRightSide ? "justify-end" : "justify-start"
                    }`}
                  >
                    <div
                      className={`flex items-start gap-1.5 max-w-[95%] ${
                        isRightSide ? "flex-row-reverse" : "flex-row"
                      }`}
                    >
                      <div
                        className={`h-5 w-5 rounded-full ${avatarClass} flex items-center justify-center shrink-0`}
                      >
                        {icon}
                      </div>

                      <Card className={`px-3 py-2 ${bubbleClass}`}>
                        <div className="text-xs leading-relaxed whitespace-pre-wrap">
                          {message.content}
                        </div>
                      </Card>
                    </div>
                  </div>
                );
              })}

              {(isAIProcessing || isMicProcessing) && (
                <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground py-2">
                  <div className="w-2 h-2 rounded-full animate-pulse bg-primary" />
                  <span>Processing...</span>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>
          )}
        </div>
      )}

      {!includeMicrophone && conversation.messages.length > 2 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3
              className="font-semibold text-md w-full cursor-pointer"
              onClick={() => setOpenConversation(!openConversation)}
            >
              Conversations
            </h3>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="icon"
                onClick={() => setOpenConversation(!openConversation)}
              >
                {openConversation ? (
                  <ChevronDownIcon className="h-4 w-4" />
                ) : (
                  <ChevronUpIcon className="h-4 w-4" />
                )}
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  startNewConversation();
                  setOpenConversation(false);
                }}
              >
                Start New
              </Button>
            </div>
          </div>

          {openConversation &&
            conversation.messages
              .slice(2)
              .sort((a, b) => b.timestamp - a.timestamp)
              .map((message) => {
                const isManualSource = message.source === "manual";
                return (
                  <div key={message.id} className="space-y-3 flex flex-row gap-2">
                    <div className="flex items-start gap-2">
                      <div
                        className={`h-6 w-6 rounded-full flex items-center justify-center ${
                          isManualSource ? "bg-purple-100" : "bg-muted"
                        }`}
                      >
                            {isManualSource ? (
                              <img
                                src="/images/talkecho.png"
                                alt="TalkEcho"
                                className="h-4 w-4 object-contain"
                              />
                            ) : message.role === "user" ? (
                          <HeadphonesIcon className="h-4 w-4 text-muted-foreground" />
                        ) : (
                          <BotIcon className="h-4 w-4 text-muted-foreground" />
                        )}
                      </div>
                    </div>
                    <Card
                      className={`px-3 py-2 ${
                        isManualSource ? "bg-purple-50 border border-purple-100" : "bg-transparent"
                      }`}
                    >
                      <p className="text-xs leading-relaxed whitespace-pre-wrap">
                        <Markdown>{message.content}</Markdown>
                      </p>
                    </Card>
                  </div>
                );
              })}
        </div>
      )}
    </div>
  );
};
