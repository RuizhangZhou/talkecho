import { useEffect, useState } from "react";
import { GripVerticalIcon } from "lucide-react";
import { useApp } from "@/contexts";
import {
  GetLicense,
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components";
import { useWindowResize } from "@/hooks";

export const DragButton = () => {
  const { hasActiveLicense } = useApp();
  const [isOpen, setIsOpen] = useState(false);
  const { resizeWindow } = useWindowResize();

  useEffect(() => {
    if (!hasActiveLicense) {
      resizeWindow(isOpen);
    }
  }, [hasActiveLicense, isOpen, resizeWindow]);

  if (!hasActiveLicense) {
    return (
      <Popover open={isOpen} onOpenChange={setIsOpen}>
        <PopoverTrigger asChild className="border-none hover:bg-transparent">
          <Button
            variant="ghost"
            size="icon"
            className="-ml-[2px] w-fit"
          >
            <GripVerticalIcon className="h-4 w-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side="bottom"
          className="w-fit select-none p-4 border overflow-hidden border-input/50"
          sideOffset={8}
        >
          <div className="flex flex-col gap-2 w-116">
            <div className="flex flex-col gap-1 pb-2">
              <p className="text-md font-medium">
                TalkEcho Alpha unlocks every feature for free.
              </p>
              <p className="text-sm font-medium text-muted-foreground">
                Drag the overlay window anytime. Use Settings -&gt; TalkEcho Access
                to manage provider keys.
              </p>
            </div>
            <GetLicense setState={setIsOpen} />
          </div>
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      className="-ml-[2px] w-fit"
      data-tauri-drag-region={hasActiveLicense}
    >
      <GripVerticalIcon className="h-4 w-4" />
    </Button>
  );
};
