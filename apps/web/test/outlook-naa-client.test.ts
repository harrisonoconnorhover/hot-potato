import { describe, expect, it, vi } from "vitest";
import {
  acquireOutlookNaaAccessToken,
  nestedAppAuthSupported,
  type OutlookAuthOfficeRuntime,
  type OutlookNaaClientDependencies,
} from "../components/outlook-naa-client";

const config = {
  clientId: "11111111-2222-4333-8444-555555555555",
  authority: "https://login.microsoftonline.com/common",
  audience: "11111111-2222-4333-8444-555555555555",
  scope:
    "api://schedule.example.com/11111111-2222-4333-8444-555555555555/access_as_user",
  redirectUri: "https://schedule.example.com/email/outlook/auth",
  dialogUrl: "https://schedule.example.com/email/outlook/auth-dialog",
  brokerRedirectUri: "brk-multihub://schedule.example.com",
};

function dependencies(input: {
  silent?: string | Error;
  popup?: string | Error;
  dialog?: string | Error;
}) {
  const acquireTokenSilent = vi.fn(async () => {
    if (input.silent instanceof Error) throw input.silent;
    return { accessToken: input.silent ?? "silent-token" };
  });
  const acquireTokenPopup = vi.fn(async () => {
    if (input.popup instanceof Error) throw input.popup;
    return {
      accessToken: input.popup ?? "popup-token",
      account: { homeAccountId: "account-1" },
    };
  });
  const dialog = vi.fn(async () => {
    if (input.dialog instanceof Error) throw input.dialog;
    return input.dialog ?? "dialog-token";
  });
  const client = {
    getAllAccounts: vi.fn(() => []),
    getActiveAccount: vi.fn(() => null),
    setActiveAccount: vi.fn(),
    acquireTokenSilent,
    acquireTokenPopup,
  };
  return {
    value: {
      client: vi.fn(async () => client),
      dialog,
    } as unknown as OutlookNaaClientDependencies,
    acquireTokenSilent,
    acquireTokenPopup,
    dialog,
  };
}

describe("Outlook NAA client", () => {
  it("uses silent SSO without opening another surface", async () => {
    const mocked = dependencies({ silent: "silent-token" });
    await expect(
      acquireOutlookNaaAccessToken({ config, interactive: true }, mocked.value),
    ).resolves.toBe("silent-token");
    expect(mocked.acquireTokenPopup).not.toHaveBeenCalled();
    expect(mocked.dialog).not.toHaveBeenCalled();
  });

  it("does not prompt during background initialization", async () => {
    const mocked = dependencies({ silent: new Error("interaction required") });
    await expect(
      acquireOutlookNaaAccessToken(
        { config, interactive: false },
        mocked.value,
      ),
    ).resolves.toBeNull();
    expect(mocked.acquireTokenPopup).not.toHaveBeenCalled();
    expect(mocked.dialog).not.toHaveBeenCalled();
  });

  it("falls from silent to popup and then the Office dialog", async () => {
    const popup = dependencies({
      silent: new Error("interaction required"),
      popup: "popup-token",
    });
    await expect(
      acquireOutlookNaaAccessToken({ config, interactive: true }, popup.value),
    ).resolves.toBe("popup-token");
    expect(
      (await popup.value.client(config)).setActiveAccount,
    ).toHaveBeenCalledWith({ homeAccountId: "account-1" });
    expect(popup.dialog).not.toHaveBeenCalled();

    const dialog = dependencies({
      silent: new Error("interaction required"),
      popup: new Error("popup unavailable"),
      dialog: "dialog-token",
    });
    await expect(
      acquireOutlookNaaAccessToken({ config, interactive: true }, dialog.value),
    ).resolves.toBe("dialog-token");
    expect(dialog.dialog).toHaveBeenCalledWith(config, undefined);
  });

  it("uses the Office dialog when the nested client cannot start", async () => {
    const mocked = dependencies({ dialog: "dialog-token" });
    mocked.value.client = vi.fn(async () => {
      throw new Error("nested client unavailable");
    });
    await expect(
      acquireOutlookNaaAccessToken({ config, interactive: true }, mocked.value),
    ).resolves.toBe("dialog-token");
    expect(mocked.dialog).toHaveBeenCalledWith(config, undefined);
  });

  it("does not reopen a dialog after the user closes the popup", async () => {
    const cancelled = Object.assign(new Error("cancelled"), {
      errorCode: "user_cancelled",
    });
    const mocked = dependencies({
      silent: new Error("interaction required"),
      popup: cancelled,
    });
    await expect(
      acquireOutlookNaaAccessToken({ config, interactive: true }, mocked.value),
    ).rejects.toThrow("closed before it finished");
    expect(mocked.dialog).not.toHaveBeenCalled();
  });

  it("detects the Outlook nested-auth requirement set", () => {
    const office = {
      context: {
        requirements: {
          isSetSupported: vi.fn(
            (name: string, version: string) =>
              name === "NestedAppAuth" && version === "1.1",
          ),
        },
      },
    } as unknown as OutlookAuthOfficeRuntime;
    expect(nestedAppAuthSupported(office)).toBe(true);
    expect(nestedAppAuthSupported(undefined)).toBe(false);
  });
});
