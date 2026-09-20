import { Header, SecretInput, Selection, TextInput } from "@/components";
import {
  extractVariables,
  isSecretVariableKey,
  providerSecretRef,
} from "@/lib";
import { UseSettingsReturn } from "@/types";
import curl2Json, { ResultJSON } from "@bany/curl-to-json";
import { useMemo } from "react";

type ProviderSelection = UseSettingsReturn["selectedSttProvider"];

type ProviderEditorProps = {
  title: string;
  description: string;
  allSttProviders: UseSettingsReturn["allSttProviders"];
  selectedProvider: ProviderSelection;
  onSetSelectedProvider: UseSettingsReturn["onSetSelectedSttProvider"];
};

const ProviderEditor = ({
  title,
  description,
  allSttProviders,
  selectedProvider,
  onSetSelectedProvider,
}: ProviderEditorProps) => {
  const provider = allSttProviders.find(
    (item) => item.id === selectedProvider.provider
  );
  const parsedProvider = useMemo<ResultJSON | null>(() => {
    if (!provider?.curl) return null;
    return curl2Json(provider.curl) as ResultJSON;
  }, [provider?.curl]);
  const variables = provider?.curl ? extractVariables(provider.curl) : [];
  const apiKeyVariable = variables.find((variable) =>
    isSecretVariableKey(variable.key)
  );
  const providerLabel = provider?.isCustom
    ? parsedProvider?.url || "Custom Provider"
    : provider?.id || "STT provider";
  const setVariable = (key: string, value: string) => {
    onSetSelectedProvider({
      ...selectedProvider,
      variables: { ...selectedProvider.variables, [key]: value },
    });
  };

  if (!selectedProvider.provider || !provider) return null;

  return (
    <div className="space-y-3 rounded-xl border border-border/50 p-3">
      <Header title={title} description={description} />
      {parsedProvider ? (
        <Header
          title={`Method: ${parsedProvider.method || "Invalid"}, Endpoint: ${
            parsedProvider.url || "Invalid"
          }`}
          description="Provider settings are stored independently by provider ID, so the meeting and dictation paths can use different models."
        />
      ) : null}

      {apiKeyVariable ? (
        <div className="space-y-2">
          <Header
            title="API Key"
            description={`Enter your ${providerLabel} API key. TalkEcho stores it in your operating system's credential manager and never reads it back into this field.`}
          />
          <SecretInput
            secretRef={
              selectedProvider.secretRef ||
              providerSecretRef("stt", selectedProvider.provider)
            }
            onConfiguredChange={() =>
              onSetSelectedProvider({
                ...selectedProvider,
                secretRef: providerSecretRef(
                  "stt",
                  selectedProvider.provider
                ),
              })
            }
          />
        </div>
      ) : null}

      {variables
        .filter(
          (variable) =>
            !isSecretVariableKey(variable.key) &&
            variable.key.toUpperCase() !== "LANGUAGE"
        )
        .map((variable) => (
          <div className="space-y-1" key={variable.key}>
            <Header
              title={variable.value}
              description={`Set ${variable.key.replace(/_/g, " ")} for ${providerLabel}.`}
            />
            <TextInput
              placeholder={`Enter ${providerLabel} ${variable.key.replace(
                /_/g,
                " "
              )}`}
              value={selectedProvider.variables?.[variable.key] || ""}
              onChange={(value) => setVariable(variable.key, value)}
            />
          </div>
        ))}
    </div>
  );
};

export const Providers = ({
  allSttProviders,
  selectedSttProvider,
  selectedDictationSttProvider,
  onSetSelectedSttProvider,
  onSetSelectedDictationSttProvider,
  sttLanguage,
  onSetSttLanguage,
  dictationSttLanguage,
  onSetDictationSttLanguage,
}: UseSettingsReturn) => {
  const LANGUAGES = [
    { label: "🇺🇸 English", value: "en" },
    { label: "🇩🇪 German", value: "de" },
    { label: "🇨🇳 Chinese", value: "zh" },
    { label: "🇯🇵 Japanese", value: "ja" },
    { label: "🇷🇺 Russian", value: "ru" },
    { label: "🇰🇷 Korean", value: "ko" },
  ];
  const DICTATION_LANGUAGES = [
    { label: "✨ Auto detect", value: "auto" },
    ...LANGUAGES,
  ];
  const providerOptions = allSttProviders.map((provider) => {
    const json = curl2Json(provider.curl) as ResultJSON;
    return {
      label:
        provider.isCustom
          ? json?.url || "Custom Provider"
          : provider.id || "Custom Provider",
      value: provider.id || "",
      isCustom: provider.isCustom,
    };
  });

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Header
          title="Meeting / Live STT Provider"
          description="Used for real-time meeting transcription and captions. Prefer a fast model with low latency."
        />
        <Selection
          selected={selectedSttProvider.provider}
          options={providerOptions}
          placeholder="Choose the meeting / live STT provider"
          onChange={(provider) =>
            onSetSelectedSttProvider({ provider, variables: {} })
          }
        />
      </div>

      <ProviderEditor
        title="Meeting / Live STT Configuration"
        description="Configure the endpoint, model and credentials used by meeting transcription."
        allSttProviders={allSttProviders}
        selectedProvider={selectedSttProvider}
        onSetSelectedProvider={onSetSelectedSttProvider}
      />

      <div className="space-y-2">
        <Header
          title="Dictation STT Provider"
          description="Used only by Right Ctrl dictation. Choose a more accurate model if you prefer quality over latency. It can be different from the meeting / live model."
        />
        <Selection
          selected={selectedDictationSttProvider.provider}
          options={providerOptions}
          placeholder="Choose the dictation STT provider"
          onChange={(provider) =>
            onSetSelectedDictationSttProvider({ provider, variables: {} })
          }
        />
      </div>

      <ProviderEditor
        title="Dictation STT Configuration"
        description="Configure the endpoint, model and credentials used by Right Ctrl dictation."
        allSttProviders={allSttProviders}
        selectedProvider={selectedDictationSttProvider}
        onSetSelectedProvider={onSetSelectedDictationSttProvider}
      />

      <div className="space-y-2">
        <Header
          title="Meeting STT Language"
          description="Language hint for meeting captions and translation. Choose the meeting's main language for the best stability on short audio segments."
        />
        <Selection
          selected={sttLanguage}
          options={LANGUAGES}
          placeholder="Select language"
          onChange={onSetSttLanguage}
        />
      </div>

      <div className="space-y-2">
        <Header
          title="Dictation STT Language"
          description="Used only by Right Ctrl dictation. Auto detect is recommended for multilingual speech; your dictation provider must support omitting the language hint."
        />
        <Selection
          selected={dictationSttLanguage}
          options={DICTATION_LANGUAGES}
          placeholder="Select dictation language"
          onChange={onSetDictationSttLanguage}
        />
      </div>
    </div>
  );
};
