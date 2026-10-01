#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeAppId,
  normalizeOrigin,
  renderTemplate,
  validateRenderedManifest,
} from "./render-manifest.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const template = await readFile(
  resolve(HERE, "../manifest.template.xml"),
  "utf8",
);
const origin = "https://schedule.example.com";
const appId = "11111111-2222-4333-8444-555555555555";
const rendered = renderTemplate(template, { origin, appId });

assert.match(rendered, /<Id>11111111-2222-4333-8444-555555555555<\/Id>/);
assert.match(rendered, /https:\/\/schedule\.example\.com\/email\/outlook/);
assert.doesNotMatch(rendered, /\{\{/);
assert.equal(normalizeOrigin("https://EXAMPLE.com/"), "https://example.com");
assert.equal(normalizeAppId(appId.toUpperCase()), appId);

assert.throws(
  () => normalizeOrigin("http://schedule.example.com"),
  /must use HTTPS/,
);
assert.throws(
  () => normalizeOrigin("https://schedule.example.com/path"),
  /must not contain a path/,
);
assert.throws(() => normalizeAppId("not-a-guid"), /must be a GUID/);
assert.throws(
  () => renderTemplate(`${template}\n{{UNEXPECTED}}`, { origin, appId }),
  /unsupported variable/,
);
assert.throws(
  () =>
    validateRenderedManifest(
      rendered.replace("ReadWriteItem", "ReadWriteMailbox"),
      origin,
    ),
  /exactly ReadWriteItem/,
);
assert.throws(
  () =>
    validateRenderedManifest(
      rendered.replace("ReadWriteItem", "CustomPermission"),
      origin,
    ),
  /exactly ReadWriteItem/,
);
assert.throws(
  () =>
    validateRenderedManifest(
      rendered.replace(
        `${origin}/email/outlook`,
        "http://insecure.example/email/outlook",
      ),
      origin,
    ),
  /insecure endpoint/,
);
assert.throws(
  () =>
    validateRenderedManifest(
      rendered.replace(`${origin}/email/outlook`, "javascript:alert(1)"),
      origin,
    ),
  /insecure endpoint/,
);
assert.throws(
  () =>
    validateRenderedManifest(
      rendered.replace(
        `${origin}/email/outlook`,
        "https://other.example/email/outlook",
      ),
      origin,
    ),
  /outside the configured origin/,
);

console.log("Outlook manifest renderer tests: ok");
