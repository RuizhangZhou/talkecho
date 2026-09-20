import { describe, expect, it } from "vitest";
import {
  stripSecretVariables,
  validateProviderCredentialTemplate,
} from "./provider-secrets";

describe("provider credential templates", () => {
  it("accepts credential placeholders", () => {
    expect(
      validateProviderCredentialTemplate(
        `curl https://example.test -H "Authorization: Bearer {{API_KEY}}" -d '{"model":"demo"}'`
      )
    ).toBeNull();
  });

  it.each([
    `curl https://example.test -H "Authorization: Bearer plaintext"`,
    `curl "https://example.test?api_key=plaintext"`,
    `curl https://example.test -d '{"access_token":"plaintext"}'`,
  ])("rejects plaintext credential locations", (template) => {
    expect(validateProviderCredentialTemplate(template)).toContain(
      "{{API_KEY}}"
    );
  });

  it("removes secret variables before persistence", () => {
    expect(
      stripSecretVariables({
        api_key: "plaintext",
        access_token: "plaintext",
        model: "demo",
      })
    ).toEqual({ model: "demo" });
  });
});
