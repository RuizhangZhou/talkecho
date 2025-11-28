import { ChatConversation } from "@/types";
import { Button, Card } from "@/components";
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
      {/* AI Response - Latest (Single Track Mode) */}
      {(lastAIResponse || isAIProcessing) && !includeMicrophone && (
        <>
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
                  {lastAIResponse ? (
                    <Markdown>{lastAIResponse}</Markdown>
                  ) : null}
                  {isAIProcessing && (
                    <span className="inline-block w-2 h-4 animate-pulse ml-1" />
                  )}
                </p>
              )}
            </Card>
          </div>
        </>
      )}

      {/* Dual-Track Mode: Chat-style display - Each message displayed independently */}
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
                // 决定左右位置：麦克风（我）= 右侧, 系统音频（对方）= 左侧
                const isRightSide = message.source === "microphone";

                // 决定图标和样式
                const isUser = message.role === "user";

                // 图标选择
                let icon;
                if (message.source === "microphone") {
                  icon = isUser ? (
                    <MicIcon className="h-2.5 w-2.5 text-primary-foreground" />
                  ) : (
                    <BotIcon className="h-2.5 w-2.5 text-primary-foreground" />
                  );
                } else {
                  // system_audio
                  icon = isUser ? (
                    <HeadphonesIcon className="h-2.5 w-2.5 text-muted-foreground" />
                  ) : (
                    <BotIcon className="h-2.5 w-2.5 text-muted-foreground" />
                  );
                }

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
                      {/* Icon */}
                      <div
                        className={`h-5 w-5 rounded-full ${
                          isRightSide ? "bg-primary" : "bg-primary/10"
                        } flex items-center justify-center shrink-0`}
                      >
                        {icon}
                      </div>

                      {/* Message bubble */}
                      <Card
                        className={`px-3 py-2 ${
                          isRightSide
                            ? "bg-primary text-white border-primary"
                            : "bg-muted/50 text-foreground"
                        }`}
                      >
                        <div className="text-xs leading-relaxed whitespace-pre-wrap">
                          {message.content}
                        </div>
                      </Card>
                    </div>
                  </div>
                );
              })}

              {/* Processing indicators */}
              {(isAIProcessing || isMicProcessing) && (
                <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground py-2">
                  <div className="w-2 h-2 rounded-full animate-pulse bg-primary" />
                  <span>Processing...</span>
                </div>
              )}

              {/* 自动滚动到底部的锚点 */}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>
      )}

      {/* Single Track Mode: Original display */}
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

          {openConversation ? (
            <>
              {conversation.messages.length > 2 &&
                conversation?.messages
                  ?.slice(2)
                  .sort((a, b) => b.timestamp - a.timestamp)
                  .map((message) => (
                    <div key={message.id} className="space-y-3 flex flex-row gap-2">
                      <div className="flex items-start gap-2">
                        <div className="h-6 w-6 rounded-full bg-muted flex items-center justify-center">
                          {message.role === "user" ? (
                            <HeadphonesIcon className="h-4 w-4 text-muted-foreground" />
                          ) : (
                            <BotIcon className="h-4 w-4 text-muted-foreground" />
                          )}
                        </div>
                      </div>
                      <Card className="px-3 py-2 bg-transparent">
                        <p className="text-xs leading-relaxed whitespace-pre-wrap">
                          <Markdown>{message.content}</Markdown>
                        </p>
                      </Card>
                    </div>
                  ))}
            </>
          ) : null}
        </div>
      )}
    </div>
  );
};
