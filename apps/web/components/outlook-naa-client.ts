import type { OutlookNaaPublicConfig } from "../app/outlook-naa";

type DialogMessage = { message: string; origin?: string };
type DialogError = { error: number };
type DialogEvent = DialogMessage | DialogError;

type OfficeDialog = {
  addEventHandler: (
    eventType: string,
    handler: (event: DialogEvent) => void,
  ) => void;
  close: () => void;
};

export type OutlookAuthOfficeRuntime = {
  AsyncResultStatus: { Succeeded: string };
  EventType?: {
    DialogEventReceived: string;
    DialogMessageReceived: string;
  };
  context: {
    requirements?: {
      isSetSupported: (name: string, version: string) => boolean;
    };
    ui?: {
      displayDialogAsync: (
        url: string,
        options: { height: number; width: number; displayInIframe: boolean },
        callback: (result: {
          status: string;
          value?: OfficeDialog;
          error?: { message?: string };
        }) => void,
      ) => void;
    };
  };
};

type TokenClient = Pick<
  import("@azure/msal-browser").IPublicClientApplication,
  | "getActiveAccount"
  | "setActiveAccount"
  | "getAllAccounts"
  | "acquireTokenSilent"
  | "acquireTokenPopup"
>;

export type OutlookNaaClientDependencies = {
  client: (config: OutlookNaaPublicConfig) => Promise<TokenClient>;
  dialog: (
    config: OutlookNaaPublicConfig,
    office: OutlookAuthOfficeRuntime | undefined,
  ) => Promise<string>;
};

let clientPromise:
  | Promise<import("@azure/msal-browser").IPublicClientApplication>
  | undefined;
let clientConfigurationKey = "";

async function publicClient(config: OutlookNaaPublicConfig) {
  const key = `${config.clientId}:${config.redirectUri}`;
  if (!clientPromise || clientConfigurationKey !== key) {
    clientConfigurationKey = key;
    clientPromise = import("@azure/msal-browser").then(
      ({ createNestablePublicClientApplication }) =>
        createNestablePublicClientApplication({
          auth: {
            clientId: config.clientId,
            authority: config.authority,
            redirectUri: config.redirectUri,
            postLogoutRedirectUri: config.redirectUri,
            clientCapabilities: ["CP1"],
          },
          cache: { cacheLocation: "sessionStorage" },
        }),
    );
  }
  return clientPromise;
}

function dialogAccessToken(
  config: OutlookNaaPublicConfig,
  office: OutlookAuthOfficeRuntime | undefined,
): Promise<string> {
  const ui = office?.context.ui;
  const eventType = office?.EventType;
  if (!ui || !eventType) {
    return Promise.reject(
      new Error(
        "This Outlook client cannot open the Microsoft sign-in dialog.",
      ),
    );
  }
  return new Promise((resolve, reject) => {
    ui.displayDialogAsync(
      config.dialogUrl,
      { height: 60, width: 35, displayInIframe: false },
      (result) => {
        if (
          result.status !== office.AsyncResultStatus.Succeeded ||
          !result.value
        ) {
          reject(
            new Error(
              result.error?.message ??
                "Outlook could not open the Microsoft sign-in dialog.",
            ),
          );
          return;
        }
        const dialog = result.value;
        let settled = false;
        dialog.addEventHandler(eventType.DialogEventReceived, (event) => {
          if (settled || !("error" in event)) return;
          settled = true;
          dialog.close();
          reject(
            new Error(
              event.error === 12006
                ? "Microsoft sign-in was closed before it finished."
                : "Microsoft sign-in could not be completed in this Outlook client.",
            ),
          );
        });
        dialog.addEventHandler(eventType.DialogMessageReceived, (event) => {
          if (settled || !("message" in event)) return;
          if (event.origin && event.origin !== window.location.origin) {
            settled = true;
            dialog.close();
            reject(
              new Error(
                "Microsoft sign-in returned from an unexpected origin.",
              ),
            );
            return;
          }
          let payload: { accessToken?: unknown; error?: unknown };
          try {
            payload = JSON.parse(event.message) as typeof payload;
          } catch {
            payload = { error: "invalid_message" };
          }
          settled = true;
          dialog.close();
          if (
            typeof payload.accessToken === "string" &&
            payload.accessToken.length >= 80
          ) {
            resolve(payload.accessToken);
          } else {
            reject(
              new Error(
                typeof payload.error === "string"
                  ? payload.error
                  : "Microsoft sign-in did not return an access token.",
              ),
            );
          }
        });
      },
    );
  });
}

export async function acquireOutlookNaaAccessToken(
  input: {
    config: OutlookNaaPublicConfig;
    office?: OutlookAuthOfficeRuntime;
    interactive: boolean;
  },
  dependencies: OutlookNaaClientDependencies = {
    client: publicClient,
    dialog: dialogAccessToken,
  },
): Promise<string | null> {
  let client: TokenClient;
  try {
    client = await dependencies.client(input.config);
  } catch (clientError) {
    if (!input.interactive) return null;
    try {
      return await dependencies.dialog(input.config, input.office);
    } catch (dialogError) {
      throw new Error(
        dialogError instanceof Error
          ? dialogError.message
          : clientError instanceof Error
            ? clientError.message
            : "Microsoft sign-in could not be started.",
      );
    }
  }
  const accounts = client.getAllAccounts();
  const account =
    client.getActiveAccount() ??
    (accounts.length === 1 ? accounts[0] : undefined);
  const request = {
    scopes: [input.config.scope],
    redirectUri: input.config.redirectUri,
    ...(account ? { account } : { prompt: "select_account" }),
  };
  try {
    return (await client.acquireTokenSilent(request)).accessToken;
  } catch {
    if (!input.interactive) return null;
  }

  try {
    const result = await client.acquireTokenPopup(request);
    if (result.account) client.setActiveAccount(result.account);
    return result.accessToken;
  } catch (popupError) {
    const popupCode =
      popupError && typeof popupError === "object" && "errorCode" in popupError
        ? String(popupError.errorCode)
        : "";
    if (popupCode === "user_cancelled") {
      throw new Error("Microsoft sign-in was closed before it finished.");
    }
    try {
      return await dependencies.dialog(input.config, input.office);
    } catch (dialogError) {
      throw new Error(
        dialogError instanceof Error
          ? dialogError.message
          : popupError instanceof Error
            ? popupError.message
            : "Microsoft sign-in could not be completed.",
      );
    }
  }
}

export function nestedAppAuthSupported(
  office: OutlookAuthOfficeRuntime | undefined,
): boolean {
  return Boolean(
    office?.context.requirements?.isSetSupported("NestedAppAuth", "1.1"),
  );
}
