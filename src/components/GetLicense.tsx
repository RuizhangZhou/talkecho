import { Dispatch, SetStateAction } from "react";
import { Button } from "@/components";

export const GetLicense = ({
  buttonText,
  buttonClassName = "",
}: {
  setState?: Dispatch<SetStateAction<boolean>>;
  buttonText?: string;
  buttonClassName?: string;
}) => {
  return (
    <Button disabled size="sm" className={buttonClassName}>
      {buttonText || "TalkEcho Alpha - Free for personal use"}
    </Button>
  );
};
