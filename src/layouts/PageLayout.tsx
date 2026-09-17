import { Header, ScrollArea } from "@/components";
import Promote from "@/components/Promote";

export const PageLayout = ({
  children,
  title,
  description,
  rightSlot,
  allowBackButton = false,
  isMainTitle = true,
}: {
  children: React.ReactNode;
  title: string;
  description: string;
  rightSlot?: React.ReactNode;
  allowBackButton?: boolean;
  isMainTitle?: boolean;
}) => {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="shrink-0 pt-8">
        <Header
          isMainTitle={isMainTitle}
          showBorder={true}
          title={title}
          description={description}
          rightSlot={rightSlot}
          allowBackButton={allowBackButton}
        />
      </header>

      <ScrollArea
        className="min-h-0 min-w-0 flex-1 pr-6"
        scrollbars="both"
        type="always"
      >
        <div className="flex min-w-0 flex-col gap-6 px-1 pb-12 pt-4">
          <Promote />
          {children}
        </div>
      </ScrollArea>
    </div>
  );
};
