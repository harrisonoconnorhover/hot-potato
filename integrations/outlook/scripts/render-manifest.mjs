#!/usr/bin/env node

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_TEMPLATE = resolve(
  dirname(SCRIPT_PATH),
  "../manifest.template.xml",
);
const PLACEHOLDER_PATTERN = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const USAGE = `Usage:
  node scripts/render-manifest.mjs \\
    --origin https://hot-potato.example \\
    --app-id 11111111-2222-4333-8444-555555555555 \\
    --output manifest.generated.xml [--template manifest.template.xml] [--force]

The origin must be a bare HTTPS origin (no path, query, fragment, or credentials).
Existing output files are not overwritten unless --force is supplied.`;

function fail(message) {
  throw new Error(message);
}

export function normalizeOrigin(value) {
  if (!value || value !== value.trim()) {
    fail("--origin must be a non-empty value without surrounding whitespace");
  }
  if (value.includes("{{") || value.includes("}}")) {
    fail("--origin contains an unexpanded template variable");
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("--origin must be a valid absolute URL");
  }

  if (parsed.protocol !== "https:") {
    fail("--origin must use HTTPS, including local development origins");
  }
  if (parsed.username || parsed.password) {
    fail("--origin must not contain credentials");
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    fail("--origin must not contain a path, query, or fragment");
  }

  return parsed.origin;
}

export function normalizeAppId(value) {
  if (!value || !UUID_PATTERN.test(value)) {
    fail("--app-id must be a GUID in 8-4-4-4-12 form");
  }
  if (value.toLowerCase() === "00000000-0000-0000-0000-000000000000") {
    fail("--app-id must not be the nil GUID");
  }
  return value.toLowerCase();
}

export function renderTemplate(template, { origin, appId }) {
  const variables = new Map([
    ["APP_ORIGIN", normalizeOrigin(origin)],
    ["APP_ID", normalizeAppId(appId)],
  ]);

  const placeholders = [...template.matchAll(PLACEHOLDER_PATTERN)].map(
    (match) => match[1],
  );
  if (placeholders.length === 0) {
    fail("template contains no render variables");
  }

  for (const placeholder of new Set(placeholders)) {
    if (!variables.has(placeholder)) {
      fail(`template contains unsupported variable {{${placeholder}}}`);
    }
  }
  for (const variable of variables.keys()) {
    if (!placeholders.includes(variable)) {
      fail(`template is missing required variable {{${variable}}}`);
    }
  }

  let rendered = template;
  for (const [name, replacement] of variables) {
    rendered = rendered.replaceAll(`{{${name}}}`, replacement);
  }
  if (
    /\{\{[A-Z][A-Z0-9_]*\}\}/.test(rendered) ||
    rendered.includes("{{") ||
    rendered.includes("}}")
  ) {
    fail("rendered manifest still contains an unexpanded variable");
  }

  validateRenderedManifest(rendered, variables.get("APP_ORIGIN"));
  return rendered;
}

export function validateRenderedManifest(manifest, expectedOrigin) {
  const requiredPatterns = [
    [/<OfficeApp\b[^>]*xsi:type="MailApp"/, "MailApp root"],
    [/<Host Name="Mailbox"\s*\/>/, "Mailbox host"],
    [
      /<Set Name="Mailbox" MinVersion="1\.1"\s*\/>/,
      "base Mailbox 1.1 requirement",
    ],
    [/<Form xsi:type="ItemEdit">/, "ItemEdit fallback form"],
    [
      /<Rule xsi:type="ItemIs" ItemType="Message" FormType="Edit"\s*\/>/,
      "message edit activation rule",
    ],
    [
      /<bt:Sets DefaultMinVersion="1\.4">\s*<bt:Set Name="Mailbox"\s*\/>/s,
      "Mailbox 1.4 command requirement",
    ],
    [
      /<ExtensionPoint xsi:type="MessageComposeCommandSurface">/,
      "message compose command surface",
    ],
    [/<Action xsi:type="ShowTaskpane">/, "ShowTaskpane action"],
  ];
  for (const [pattern, label] of requiredPatterns) {
    if (!pattern.test(manifest)) {
      fail(`rendered manifest is missing ${label}`);
    }
  }

  const permissions = [
    ...manifest.matchAll(/<Permissions>\s*([^<]+?)\s*<\/Permissions>/g),
  ].map((match) => match[1].trim());
  if (permissions.length !== 1 || permissions[0] !== "ReadWriteItem") {
    fail(
      "rendered manifest must request exactly ReadWriteItem once and no other Office permission",
    );
  }
  if (
    /ReadWriteMailbox|WebApplicationInfo|graph\.microsoft\.com/i.test(manifest)
  ) {
    fail(
      "rendered manifest contains a forbidden mailbox, Graph, or identity permission",
    );
  }

  const endpointValues = [
    ...manifest.matchAll(
      /<(?:IconUrl|HighResolutionIconUrl|SupportUrl|SourceLocation|bt:Image|bt:Url)\b[^>]*\bDefaultValue="([^\"]+)"/g,
    ),
    ...manifest.matchAll(/<AppDomain>([^<]+)<\/AppDomain>/g),
  ].map((match) => match[1]);
  if (endpointValues.length === 0) {
    fail("rendered manifest contains no deployable HTTPS endpoints");
  }
  for (const endpoint of endpointValues) {
    let parsed;
    try {
      parsed = new URL(endpoint);
    } catch {
      fail(`rendered manifest contains an invalid endpoint: ${endpoint}`);
    }
    if (parsed.protocol !== "https:") {
      fail(`rendered manifest contains an insecure endpoint: ${endpoint}`);
    }
    if (parsed.origin !== expectedOrigin) {
      fail(
        `rendered manifest endpoint is outside the configured origin: ${endpoint}`,
      );
    }
  }

  const requiredEndpoints = [
    `${expectedOrigin}/`,
    `${expectedOrigin}/email/outlook`,
    ...[16, 32, 64, 80, 128].map(
      (size) => `${expectedOrigin}/email/outlook/assets/icon-${size}.png`,
    ),
  ];
  for (const endpoint of requiredEndpoints) {
    if (!endpointValues.includes(endpoint)) {
      fail(`rendered manifest is missing required endpoint: ${endpoint}`);
    }
  }
}

function parseArgs(argv) {
  const result = { force: false, template: DEFAULT_TEMPLATE };
  const valueFlags = new Set([
    "--origin",
    "--app-id",
    "--output",
    "--template",
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      result.help = true;
      continue;
    }
    if (argument === "--force") {
      if (result.force) fail("--force was provided more than once");
      result.force = true;
      continue;
    }
    if (!valueFlags.has(argument)) {
      fail(`unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      fail(`${argument} requires a value`);
    }
    const key = argument
      .slice(2)
      .replace(/-([a-z])/g, (_, character) => character.toUpperCase());
    if (Object.hasOwn(result, key) && key !== "template") {
      fail(`${argument} was provided more than once`);
    }
    if (key === "template" && result.template !== DEFAULT_TEMPLATE) {
      fail("--template was provided more than once");
    }
    result[key] = value;
    index += 1;
  }

  return result;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(USAGE);
      return;
    }
    if (!args.origin || !args.appId || !args.output) {
      fail("--origin, --app-id, and --output are required");
    }

    const templatePath = resolve(args.template);
    const outputPath = resolve(args.output);
    if (templatePath === outputPath) {
      fail("--output must not overwrite the manifest template");
    }

    const template = await readFile(templatePath, "utf8");
    const manifest = renderTemplate(template, {
      origin: args.origin,
      appId: args.appId,
    });
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, manifest, {
      encoding: "utf8",
      flag: args.force ? "w" : "wx",
    });
    console.log(`Rendered Outlook manifest: ${outputPath}`);
  } catch (error) {
    console.error(`Outlook manifest render failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  await main();
}
