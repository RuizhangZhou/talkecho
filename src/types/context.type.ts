import { Dispatch, SetStateAction } from "react";
import { ProviderSelection, ScreenshotConfig, TYPE_PROVIDER } from "@/types";
import { CursorType, CustomizableState } from "@/lib/storage";

export type IContextType = {
  systemPrompt: string;
  setSystemPrompt: Dispatch<SetStateAction<string>>;
  allAiProviders: TYPE_PROVIDER[];
  customAiProviders: TYPE_PROVIDER[];
  selectedAIProvider: ProviderSelection;
  onSetSelectedAIProvider: (selection: ProviderSelection) => void;
  allSttProviders: TYPE_PROVIDER[];
  customSttProviders: TYPE_PROVIDER[];
  selectedSttProvider: ProviderSelection;
  selectedDictationSttProvider: ProviderSelection;
  onSetSelectedSttProvider: (selection: ProviderSelection) => void;
  onSetSelectedDictationSttProvider: (selection: ProviderSelection) => void;
  sttLanguage: string;
  onSetSttLanguage: (language: string) => void;
  dictationSttLanguage: string;
  onSetDictationSttLanguage: (language: string) => void;
  screenshotConfiguration: ScreenshotConfig;
  setScreenshotConfiguration: Dispatch<SetStateAction<ScreenshotConfig>>;
  customizable: CustomizableState;
  toggleAppIconVisibility: (isVisible: boolean) => Promise<void>;
  toggleAlwaysOnTop: (isEnabled: boolean) => Promise<void>;
  toggleAutostart: (isEnabled: boolean) => Promise<void>;
  loadData: () => void;
  talkEchoApiEnabled: boolean;
  setTalkEchoApiEnabled: (enabled: boolean) => void;
  hasActiveLicense: boolean;
  setHasActiveLicense: Dispatch<SetStateAction<boolean>>;
  getActiveLicenseStatus: () => Promise<void>;
  supportsImages: boolean;
  selectedAudioDevices: {
    input: string;
    output: string;
  };
  setSelectedAudioDevices: Dispatch<
    SetStateAction<{
      input: string;
      output: string;
    }>
  >;
  setCursorType: (type: CursorType) => void;
};

