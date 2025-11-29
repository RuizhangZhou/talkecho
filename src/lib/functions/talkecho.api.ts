import { invoke } from "@tauri-apps/api/core";
import { safeLocalStorage } from "../storage";
import { STORAGE_KEYS } from "@/config";

// Helper function to check if TalkEcho API should be used
export async function shouldUseTalkEchoAPI(): Promise<boolean> {
  try {
    // Check if TalkEcho API is enabled in localStorage
    const talkEchoApiEnabled =
      safeLocalStorage.getItem(STORAGE_KEYS.TALKECHO_API_ENABLED) === "true";
    if (!talkEchoApiEnabled) return false;

    // Check if license is available
    const hasLicense = await invoke<boolean>("check_license_status");
    return hasLicense;
  } catch (error) {
    console.warn("Failed to check TalkEcho API availability:", error);
    return false;
  }
}



