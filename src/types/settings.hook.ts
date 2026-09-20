import { ProviderSelection, TYPE_PROVIDER } from "./provider.type";
import { ScreenshotConfig, ScreenshotMode } from "./settings";

export interface UseSettingsReturn {
  screenshotConfiguration: ScreenshotConfig;
  setScreenshotConfiguration: React.Dispatch<
    React.SetStateAction<ScreenshotConfig>
  >;
  handleScreenshotModeChange: (value: ScreenshotMode) => void;
  handleScreenshotPromptChange: (value: string) => void;
  handleScreenshotEnabledChange: (enabled: boolean) => void;
  allAiProviders: TYPE_PROVIDER[];
  allSttProviders: TYPE_PROVIDER[];
  selectedAIProvider: ProviderSelection;
  selectedSttProvider: ProviderSelection;
  selectedDictationSttProvider: ProviderSelection;
  onSetSelectedAIProvider: (provider: ProviderSelection) => void;
  onSetSelectedSttProvider: (provider: ProviderSelection) => void;
  onSetSelectedDictationSttProvider: (provider: ProviderSelection) => void;
  sttLanguage: string;
  onSetSttLanguage: (language: string) => void;
  dictationSttLanguage: string;
  onSetDictationSttLanguage: (language: string) => void;
  handleDeleteAllChatsConfirm: () => void;
  showDeleteConfirmDialog: boolean;
  setShowDeleteConfirmDialog: React.Dispatch<React.SetStateAction<boolean>>;
  variables: { key: string; value: string }[];
  sttVariables: { key: string; value: string }[];
  dictationSttVariables: { key: string; value: string }[];
  hasActiveLicense: boolean;
}
