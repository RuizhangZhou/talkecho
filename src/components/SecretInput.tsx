import { Button, Input } from "@/components/ui";
import {
  deleteProviderSecret,
  hasProviderSecret,
  setProviderSecret,
} from "@/lib";
import { useEffect, useState } from "react";

interface SecretInputProps {
  secretRef: string;
  additionalSecretRefs?: string[];
  onConfiguredChange?: (configured: boolean) => void;
}

export const SecretInput = ({
  secretRef,
  additionalSecretRefs = [],
  onConfiguredChange,
}: SecretInputProps) => {
  const [configured, setConfigured] = useState(false);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setValue("");
    setEditing(false);
    setError("");
    const refs = [...new Set([secretRef, ...additionalSecretRefs])];
    void Promise.all(refs.map(hasProviderSecret))
      .then((results) => {
        if (active) setConfigured(results.every(Boolean));
      })
      .catch(() => {
        if (active) setError("Could not access the system credential store.");
      });
    return () => {
      active = false;
    };
  }, [secretRef, additionalSecretRefs.join("\0")]);

  const references = [...new Set([secretRef, ...additionalSecretRefs])];

  const save = async () => {
    if (!value.trim()) return;
    setBusy(true);
    setError("");
    try {
      await Promise.all(
        references.map((reference) => setProviderSecret(reference, value))
      );
      setValue("");
      setConfigured(true);
      setEditing(false);
      onConfiguredChange?.(true);
    } catch {
      setError("Could not save the API key in the system credential store.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError("");
    try {
      await Promise.all(references.map(deleteProviderSecret));
      setValue("");
      setConfigured(false);
      setEditing(false);
      onConfiguredChange?.(false);
    } catch {
      setError("Could not delete the API key from the system credential store.");
    } finally {
      setBusy(false);
    }
  };

  if (configured && !editing) {
    return (
      <div className="space-y-2">
        <div className="flex gap-2">
          <Input
            type="password"
            value="••••••"
            readOnly
            aria-label="Configured API key"
            className="flex-1 h-11"
          />
          <Button variant="outline" disabled={busy} onClick={() => setEditing(true)}>
            Replace
          </Button>
          <Button variant="destructive" disabled={busy} onClick={remove}>
            Delete
          </Button>
        </div>
        {error ? <p className="text-xs text-red-500">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input
          type="password"
          placeholder="Enter API key"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          disabled={busy}
          className="flex-1 h-11"
        />
        <Button disabled={busy || !value.trim()} onClick={save}>
          Save
        </Button>
        {configured ? (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              setValue("");
              setEditing(false);
              setError("");
            }}
          >
            Cancel
          </Button>
        ) : null}
      </div>
      {error ? <p className="text-xs text-red-500">{error}</p> : null}
    </div>
  );
};
