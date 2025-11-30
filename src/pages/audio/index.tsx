import { AudioSelection } from "./components";
import { PageLayout } from "@/layouts";
import { SystemAudioSettings } from "@/pages/settings/components";

const Audio = () => {
  return (
    <PageLayout
      title="Audio Settings"
      description="Configure your audio input and output devices for voice interaction and system audio capture."
    >
      <AudioSelection />
      <SystemAudioSettings />
    </PageLayout>
  );
};

export default Audio;
