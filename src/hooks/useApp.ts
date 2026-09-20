import { useEffect } from "react";
import { useTitles, useAudioOverlay } from "@/hooks";
import { safeLocalStorage, migrateLocalStorageToSQLite } from "@/lib";

export const useApp = () => {
  const systemAudio = useAudioOverlay();
  // Initialize title management
  useTitles();

  // Migrate localStorage chat history to SQLite on app startup
  useEffect(() => {
    const runMigration = async () => {
      try {
        // Early exit: Check if migration already completed
        const migrationKey = "chat_history_migrated_to_sqlite";
        const alreadyMigrated =
          safeLocalStorage.getItem(migrationKey) === "true";

        if (alreadyMigrated) {
          return; // Migration already complete, skip
        }

        const result = await migrateLocalStorageToSQLite();

        if (result.success) {
          if (result.migratedCount > 0) {
            console.log(
              `Successfully migrated ${result.migratedCount} conversations to SQLite`
            );
          }
        } else if (result.error) {
          // Migration failed - log error
          console.error("Migration error:", result.error);
        }
      } catch (error) {
        // Critical error during migration
        console.error("Critical migration failure:", error);
      }
    };
    runMigration();
  }, []);

  const handleSelectConversation = (conversation: any) => {
    // useCompletion will fetch the full conversation from SQLite by id
    window.dispatchEvent(
      new CustomEvent("conversationSelected", {
        detail: { id: conversation.id },
      })
    );
  };

  const handleNewConversation = () => {
    // Trigger new conversation event
    window.dispatchEvent(new CustomEvent("newConversation"));
  };

  useEffect(() => {
    const handleShortcutRegistrationError = (
      event: Event | CustomEvent<Array<[string, string, string]>>
    ) => {
      const detail =
        (event as CustomEvent<Array<[string, string, string]>>)?.detail ?? [];

      if (!detail.length) {
        return;
      }

      const formatted = detail
        .map(([action, key, error]) => ({ action, key, error }))
        .filter(({ action, key }) => action && key);

      if (!formatted.length) {
        return;
      }

      console.warn(
        "Some shortcuts could not be registered:",
        formatted.map(({ action, key, error }) => ({
          action,
          key,
          error,
        }))
      );
    };

    window.addEventListener(
      "shortcutRegistrationError",
      handleShortcutRegistrationError as EventListener
    );

    return () => {
      window.removeEventListener(
        "shortcutRegistrationError",
        handleShortcutRegistrationError as EventListener
      );
    };
  }, []);

  return {
    handleSelectConversation,
    handleNewConversation,
    systemAudio,
  };
};
