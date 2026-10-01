(function () {
  "use strict";

  var globalKey = "__hotPotatoEmbedV1";
  var inlineSelector = "[data-hot-potato-router]";
  var bridgeSelector = "[data-hot-potato-form-bridge]";
  var source = "hot-potato";
  var hostSource = "hot-potato-host";
  var version = 1;
  var configTimeoutMilliseconds = 8000;
  var embedTimeoutMilliseconds = 15000;

  if (window[globalKey]) {
    window[globalKey].scan(document);
    return;
  }

  var records = [];
  var bridges = Object.create(null);
  var rememberedSubmissions = Object.create(null);
  var activeModal = null;
  var modalSequence = 0;
  var loaderOrigin = resolveLoaderOrigin();

  function isPlainObject(value) {
    return (
      value !== null &&
      typeof value === "object" &&
      Object.getPrototypeOf(value) === Object.prototype
    );
  }

  function hasExactKeys(value, allowed) {
    if (!isPlainObject(value)) return false;
    var keys = Object.keys(value);
    return (
      keys.length === allowed.length &&
      keys.every(function (key) {
        return allowed.indexOf(key) !== -1;
      })
    );
  }

  function safeCode(value, fallback) {
    return typeof value === "string" && /^[a-z0-9_-]{1,64}$/.test(value)
      ? value
      : fallback;
  }

  function dispatchTarget(target, event, detail) {
    if (!target || typeof target.dispatchEvent !== "function") return true;
    return target.dispatchEvent(
      new CustomEvent("hotpotato:" + event, {
        bubbles: true,
        cancelable: event === "booked",
        detail: detail || {},
      }),
    );
  }

  function dispatch(record, event, detail) {
    return dispatchTarget(record.eventTarget, event, detail);
  }

  function dispatchBridge(bridge, event, detail) {
    for (var index = 0; index < bridge.markers.length; index += 1) {
      dispatchTarget(bridge.markers[index], event, detail);
    }
  }

  function validMessage(data) {
    if (!data || Object.getPrototypeOf(data) !== Object.prototype) return false;
    if (data.source !== source || data.version !== version) return false;

    var base = ["source", "version", "event"];
    var allowed;
    if (
      data.event === "ready" ||
      data.event === "no_slots" ||
      data.event === "disqualified"
    ) {
      allowed = base;
    } else if (data.event === "booked") {
      allowed = base.concat("redirectUrl", "redirectDelaySeconds");
      if (
        !validSuccessRedirect(data.redirectUrl) ||
        !Number.isInteger(data.redirectDelaySeconds) ||
        data.redirectDelaySeconds < 1 ||
        data.redirectDelaySeconds > 30
      ) {
        return false;
      }
    } else if (data.event === "step") {
      allowed = base.concat("step");
      if (
        ["details", "availability", "confirmation", "no_match"].indexOf(
          data.step,
        ) === -1
      ) {
        return false;
      }
    } else if (data.event === "error") {
      allowed = base.concat("code");
      if (safeCode(data.code, "") !== data.code) return false;
    } else if (data.event === "height") {
      allowed = base.concat("height");
      if (
        !Number.isInteger(data.height) ||
        data.height < 240 ||
        data.height > 5000
      ) {
        return false;
      }
    } else {
      return false;
    }

    return hasExactKeys(data, allowed);
  }

  function validSuccessRedirect(value) {
    if (value === null) return true;
    if (typeof value !== "string" || value.length > 2048) return false;
    var url = validHttpUrl(value, undefined);
    if (!url || url.toString() !== value) return false;
    var hostname = url.hostname.toLowerCase();
    var loopback =
      hostname === "localhost" ||
      hostname === "[::1]" ||
      /^127(?:\.\d{1,3}){3}$/.test(hostname);
    return url.protocol === "https:" || (url.protocol === "http:" && loopback);
  }

  function scheduleRedirect(record, redirectUrl, delaySeconds) {
    window.clearTimeout(record.redirectTimer);
    record.redirectTimer = 0;
    if (!redirectUrl) return;
    record.redirectTimer = window.setTimeout(function () {
      if (record.closed || record.terminalFailure) return;
      window.location.assign(redirectUrl);
    }, delaySeconds * 1000);
  }

  function showFallback(record, code) {
    if (record.ready || record.closed || record.terminalFailure) return;
    releaseRecordSubmission(record);
    if (record.bridge) {
      record.terminalFailure = true;
      record.submission = null;
    }
    record.iframe.hidden = true;
    record.fallback.hidden = false;
    record.container.removeAttribute("aria-busy");
    window.clearTimeout(record.timeout);
    dispatch(record, "error", { code: safeCode(code, "embed_failed") });
    if (record.complete) {
      record.complete({
        ok: false,
        error: safeCode(code, "embed_failed"),
      });
      record.complete = null;
    }
  }

  function bridgeSubmissionMessage(record) {
    return {
      source: hostSource,
      version: version,
      command: "submit",
      submissionId: record.submissionId,
      submission: {
        attendeeName: record.submission.attendeeName,
        attendeeEmail: record.submission.attendeeEmail,
        answers: record.submission.answers,
      },
    };
  }

  function receiveMessage(event) {
    for (var index = 0; index < records.length; index += 1) {
      var record = records[index];
      if (
        record.closed ||
        record.terminalFailure ||
        event.origin !== record.origin ||
        event.source !== record.iframe.contentWindow ||
        !validMessage(event.data)
      ) {
        continue;
      }

      var data = event.data;
      if (data.event === "ready") {
        if (record.bridge && !record.submissionSent) {
          try {
            record.iframe.contentWindow.postMessage(
              bridgeSubmissionMessage(record),
              record.origin,
            );
          } catch (_error) {
            showFallback(record, "bridge_message_failed");
            continue;
          }
          record.submissionSent = true;
          record.submission = null;
        }
        record.ready = true;
        window.clearTimeout(record.timeout);
        record.fallback.hidden = true;
        record.iframe.hidden = false;
        record.container.removeAttribute("aria-busy");
        dispatch(
          record,
          "ready",
          record.bridge ? { bridge: true } : { iframe: record.iframe },
        );
        if (record.complete) {
          record.complete({ ok: true });
          record.complete = null;
        }
      } else if (data.event === "height") {
        record.iframe.style.height = data.height + "px";
        dispatch(record, "height", { height: data.height });
      } else if (data.event === "step") {
        dispatch(record, "step", { step: data.step });
      } else if (data.event === "booked") {
        record.booked = true;
        if (record.resumeButtons) {
          for (
            var resumeIndex = 0;
            resumeIndex < record.resumeButtons.length;
            resumeIndex += 1
          ) {
            record.resumeButtons[resumeIndex].textContent =
              "View meeting details";
          }
        }
        var redirectAccepted = dispatch(record, "booked", {
          redirectUrl: data.redirectUrl,
          redirectDelaySeconds: data.redirectDelaySeconds,
        });
        if (redirectAccepted) {
          scheduleRedirect(record, data.redirectUrl, data.redirectDelaySeconds);
        }
      } else if (data.event === "no_slots") {
        dispatch(record, "no_slots", {});
      } else if (data.event === "disqualified") {
        dispatch(record, "disqualified", {});
      } else if (data.event === "error") {
        dispatch(record, "error", { code: data.code });
      }
    }
  }

  function validHttpUrl(value, base) {
    try {
      var url = new URL(value, base);
      if (url.protocol !== "https:" && url.protocol !== "http:") return null;
      if (url.username || url.password) return null;
      url.hash = "";
      return url;
    } catch (_error) {
      return null;
    }
  }

  function resolveLoaderOrigin() {
    var script = document.currentScript;
    var url =
      script && script.src ? validHttpUrl(script.src, document.baseURI) : null;
    if (url) return url.origin;

    var scripts = document.querySelectorAll
      ? document.querySelectorAll("script[src]")
      : [];
    for (var index = scripts.length - 1; index >= 0; index -= 1) {
      url = validHttpUrl(scripts[index].src, document.baseURI);
      if (url && /\/embed\/v1\.js$/.test(url.pathname)) return url.origin;
    }
    return null;
  }

  function validRouterUrl(value) {
    return validHttpUrl(value, document.baseURI);
  }

  function mountInline(originalTarget) {
    if (originalTarget.getAttribute("data-hot-potato-mounted") === "true") {
      return;
    }

    var routerUrl = validRouterUrl(
      originalTarget.getAttribute("data-hot-potato-router") || "",
    );
    if (!routerUrl) {
      originalTarget.setAttribute("data-hot-potato-mounted", "invalid");
      dispatchTarget(originalTarget, "error", { code: "invalid_router_url" });
      return;
    }

    var container = originalTarget;
    if (originalTarget.tagName === "SCRIPT") {
      container = document.createElement("div");
      originalTarget.insertAdjacentElement("afterend", container);
    }
    originalTarget.setAttribute("data-hot-potato-mounted", "true");
    container.setAttribute("aria-busy", "true");

    var fallback = document.createElement("div");
    fallback.setAttribute("data-hot-potato-fallback", "");
    while (container.firstChild) fallback.appendChild(container.firstChild);
    if (!fallback.hasChildNodes()) {
      var fallbackLink = document.createElement("a");
      fallbackLink.href = routerUrl.toString();
      fallbackLink.target = "_blank";
      fallbackLink.rel = "noopener noreferrer";
      fallbackLink.textContent = "Open the meeting scheduler";
      fallback.appendChild(fallbackLink);
    }

    var iframeUrl = new URL(routerUrl.toString());
    iframeUrl.searchParams.set("embed", "1");
    iframeUrl.searchParams.set("parentOrigin", window.location.origin);

    var iframe = document.createElement("iframe");
    iframe.src = iframeUrl.toString();
    iframe.title =
      originalTarget.getAttribute("data-hot-potato-title") ||
      "Find and schedule a meeting";
    iframe.loading = "lazy";
    iframe.referrerPolicy = "no-referrer";
    iframe.setAttribute(
      "sandbox",
      "allow-forms allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox",
    );
    iframe.style.width = "100%";
    iframe.style.minHeight = "640px";
    iframe.style.border = "0";
    iframe.style.display = "block";
    iframe.hidden = true;

    container.appendChild(fallback);
    container.appendChild(iframe);

    var record = {
      bridge: false,
      closed: false,
      complete: null,
      container: container,
      eventTarget: originalTarget,
      fallback: fallback,
      iframe: iframe,
      origin: iframeUrl.origin,
      ready: false,
      redirectTimer: 0,
      timeout: 0,
    };
    record.timeout = window.setTimeout(function () {
      showFallback(record, "embed_timeout");
    }, embedTimeoutMilliseconds);
    iframe.addEventListener("error", function () {
      showFallback(record, "embed_load_failed");
    });
    records.push(record);
  }

  function validUuid(value) {
    return (
      typeof value === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value,
      )
    );
  }

  function validSourceField(value) {
    return (
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= 160 &&
      value === value.trim() &&
      !/[\u0000-\u001f\u007f]/.test(value) &&
      value !== "__proto__" &&
      value !== "prototype" &&
      value !== "constructor"
    );
  }

  function validAnswerField(value) {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > 160 ||
      !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/.test(value)
    ) {
      return false;
    }
    return value.split(".").every(function (part) {
      return (
        part !== "__proto__" && part !== "prototype" && part !== "constructor"
      );
    });
  }

  function validOrigin(value) {
    if (typeof value !== "string" || value.length > 2048) return false;
    var url = validHttpUrl(value, undefined);
    var hostname = url ? url.hostname.toLowerCase() : "";
    var loopback =
      hostname === "localhost" ||
      hostname === "[::1]" ||
      /^127(?:\.\d{1,3}){3}$/.test(hostname);
    return (
      url !== null &&
      url.origin === value &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      (url.protocol === "https:" || (url.protocol === "http:" && loopback))
    );
  }

  function validRouterPath(value) {
    if (typeof value !== "string" || value.length > 165) return false;
    return /^\/r\/[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(
      value,
    );
  }

  function validBridgeConfig(value) {
    if (
      !hasExactKeys(value, [
        "provider",
        "formId",
        "allowedOrigins",
        "mapping",
        "routerPath",
      ]) ||
      (value.provider !== "hubspot" && value.provider !== "manual") ||
      (value.provider === "hubspot" &&
        (typeof value.formId !== "string" ||
          value.formId.length === 0 ||
          value.formId.length > 160 ||
          value.formId !== value.formId.trim() ||
          /[\u0000-\u001f\u007f]/.test(value.formId))) ||
      (value.provider === "manual" && value.formId !== null) ||
      !Array.isArray(value.allowedOrigins) ||
      value.allowedOrigins.length === 0 ||
      value.allowedOrigins.length > 10 ||
      !validRouterPath(value.routerPath) ||
      !hasExactKeys(value.mapping, [
        "attendeeNameFields",
        "attendeeEmailField",
        "answerMappings",
      ]) ||
      !Array.isArray(value.mapping.attendeeNameFields) ||
      value.mapping.attendeeNameFields.length < 1 ||
      value.mapping.attendeeNameFields.length > 4 ||
      !validSourceField(value.mapping.attendeeEmailField) ||
      !isPlainObject(value.mapping.answerMappings)
    ) {
      return false;
    }

    var seenOrigins = Object.create(null);
    for (
      var originIndex = 0;
      originIndex < value.allowedOrigins.length;
      originIndex += 1
    ) {
      var origin = value.allowedOrigins[originIndex];
      if (!validOrigin(origin) || seenOrigins[origin]) return false;
      seenOrigins[origin] = true;
    }

    var seenNameFields = Object.create(null);
    for (
      var nameIndex = 0;
      nameIndex < value.mapping.attendeeNameFields.length;
      nameIndex += 1
    ) {
      var nameField = value.mapping.attendeeNameFields[nameIndex];
      if (!validSourceField(nameField) || seenNameFields[nameField])
        return false;
      seenNameFields[nameField] = true;
    }

    var answerFields = Object.keys(value.mapping.answerMappings);
    if (answerFields.length > 50) return false;
    for (
      var answerIndex = 0;
      answerIndex < answerFields.length;
      answerIndex += 1
    ) {
      var answerField = answerFields[answerIndex];
      if (
        !validAnswerField(answerField) ||
        !validSourceField(value.mapping.answerMappings[answerField])
      ) {
        return false;
      }
    }

    return true;
  }

  function configFailure(bridge, code) {
    if (bridge.failed) return null;
    bridge.failed = true;
    bridge.error = safeCode(code, "bridge_config_unavailable");
    dispatchBridge(bridge, "error", { code: bridge.error });
    return null;
  }

  function fetchBridgeConfig(bridge) {
    if (!loaderOrigin || typeof window.fetch !== "function") {
      return Promise.resolve(
        configFailure(bridge, "bridge_loader_unavailable"),
      );
    }

    var requestUrl =
      loaderOrigin +
      "/api/router-form-bridges/" +
      encodeURIComponent(bridge.id);
    var timedOut = false;
    var timeout = 0;
    var timeoutPromise = new Promise(function (resolve) {
      timeout = window.setTimeout(function () {
        timedOut = true;
        resolve(configFailure(bridge, "bridge_config_timeout"));
      }, configTimeoutMilliseconds);
    });
    var requestPromise = window
      .fetch(requestUrl, {
        method: "GET",
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
      })
      .then(function (response) {
        if (timedOut) return null;
        if (
          !response ||
          response.ok !== true ||
          typeof response.text !== "function"
        ) {
          return configFailure(bridge, "bridge_config_unavailable");
        }
        return response.text().then(function (text) {
          if (timedOut) return null;
          if (
            typeof text !== "string" ||
            text.length === 0 ||
            text.length > 32768
          ) {
            return configFailure(bridge, "invalid_bridge_config");
          }
          var parsed;
          try {
            parsed = JSON.parse(text);
          } catch (_error) {
            return configFailure(bridge, "invalid_bridge_config");
          }
          if (!validBridgeConfig(parsed)) {
            return configFailure(bridge, "invalid_bridge_config");
          }
          if (parsed.allowedOrigins.indexOf(window.location.origin) === -1) {
            return configFailure(bridge, "bridge_origin_not_allowed");
          }
          bridge.config = parsed;
          bridge.failed = false;
          bridge.error = null;
          return parsed;
        });
      })
      .catch(function () {
        if (timedOut) return null;
        return configFailure(bridge, "bridge_config_unavailable");
      })
      .then(function (result) {
        window.clearTimeout(timeout);
        return result;
      });
    return Promise.race([requestPromise, timeoutPromise]);
  }

  function startVerifiedConfigRetry(bridge) {
    if (bridge.verifiedRetryPromise) return bridge.verifiedRetryPromise;
    bridge.failed = false;
    bridge.error = null;
    bridge.config = null;
    var retry = fetchBridgeConfig(bridge);
    bridge.promise = retry;
    bridge.verifiedRetryPromise = retry;
    retry.then(function () {
      if (bridge.verifiedRetryPromise === retry) {
        bridge.verifiedRetryPromise = null;
      }
    });
    return retry;
  }

  function configForVerifiedSubmission(bridge) {
    if (bridge.config) return Promise.resolve(bridge.config);
    if (!bridge.promise) bridge.promise = fetchBridgeConfig(bridge);
    var attempt = bridge.promise;
    var attemptIsVerifiedRetry = attempt === bridge.verifiedRetryPromise;
    return attempt.then(function (config) {
      if (config || attemptIsVerifiedRetry) return config;
      return startVerifiedConfigRetry(bridge);
    });
  }

  function mountBridgeMarker(marker) {
    if (
      marker.getAttribute("data-hot-potato-form-bridge-mounted") === "true" ||
      marker.getAttribute("data-hot-potato-form-bridge-mounted") === "invalid"
    ) {
      return;
    }

    var originalId = marker.getAttribute("data-hot-potato-form-bridge") || "";
    if (!validUuid(originalId)) {
      marker.setAttribute("data-hot-potato-form-bridge-mounted", "invalid");
      dispatchTarget(marker, "error", { code: "invalid_bridge_id" });
      return;
    }

    var bridgeId = originalId.toLowerCase();
    marker.setAttribute("data-hot-potato-form-bridge-mounted", "true");
    var bridge = bridges[bridgeId];
    if (!bridge) {
      bridge = {
        id: bridgeId,
        markers: [],
        config: null,
        failed: false,
        error: null,
        promise: null,
        verifiedRetryPromise: null,
      };
      bridges[bridgeId] = bridge;
    }
    if (bridge.markers.indexOf(marker) === -1) bridge.markers.push(marker);
    if (!bridge.promise) bridge.promise = fetchBridgeConfig(bridge);
    if (bridge.failed) {
      dispatchTarget(marker, "error", { code: bridge.error });
    }
  }

  function normalizeWhitespace(value, maximumLength) {
    if (typeof value !== "string") return null;
    var normalized = value.replace(/\s+/g, " ").trim();
    if (normalized.length === 0) return "";
    return normalized.slice(0, maximumLength);
  }

  function normalizeSourceValue(value, maximumLength) {
    if (typeof value === "string") {
      return normalizeWhitespace(value, maximumLength);
    }
    if (typeof value === "number" && isFinite(value)) {
      return normalizeWhitespace(String(value), maximumLength);
    }
    if (typeof value === "boolean") return value ? "true" : "false";
    if (Array.isArray(value) && value.length <= 20) {
      var parts = [];
      for (var index = 0; index < value.length; index += 1) {
        var part = normalizeSourceValue(value[index], maximumLength);
        if (part) parts.push(part);
      }
      return normalizeWhitespace(parts.join(", "), maximumLength);
    }
    return null;
  }

  function normalizeSubmissionId(value) {
    if (
      typeof value !== "string" ||
      value.length < 1 ||
      value.length > 200 ||
      !/^[A-Za-z0-9._:-]+$/.test(value)
    ) {
      return null;
    }
    return value;
  }

  function validValues(value) {
    if (!isPlainObject(value)) return false;
    var keys = Object.keys(value);
    if (keys.length > 200) return false;
    return keys.every(function (key) {
      return validSourceField(key);
    });
  }

  function sourceValue(values, field, maximumLength) {
    if (!Object.prototype.hasOwnProperty.call(values, field)) return "";
    var normalized = normalizeSourceValue(values[field], maximumLength);
    return normalized === null ? "" : normalized;
  }

  function mappedSubmission(config, values) {
    if (!validValues(values)) return null;
    var nameParts = [];
    for (
      var index = 0;
      index < config.mapping.attendeeNameFields.length;
      index += 1
    ) {
      var namePart = sourceValue(
        values,
        config.mapping.attendeeNameFields[index],
        80,
      );
      if (namePart) nameParts.push(namePart);
    }
    var attendeeName = normalizeWhitespace(nameParts.join(" "), 80);
    var attendeeEmail = sourceValue(
      values,
      config.mapping.attendeeEmailField,
      320,
    ).toLowerCase();
    if (
      !attendeeName ||
      attendeeName.length < 2 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(attendeeEmail)
    ) {
      return null;
    }

    var answers = {};
    var answerFields = Object.keys(config.mapping.answerMappings);
    for (
      var answerIndex = 0;
      answerIndex < answerFields.length;
      answerIndex += 1
    ) {
      var answerField = answerFields[answerIndex];
      answers[answerField] = sourceValue(
        values,
        config.mapping.answerMappings[answerField],
        500,
      );
    }
    return {
      attendeeName: attendeeName,
      attendeeEmail: attendeeEmail,
      answers: answers,
    };
  }

  function rememberSubmission(bridgeId, submissionId) {
    var key = bridgeId + ":" + submissionId;
    if (Object.prototype.hasOwnProperty.call(rememberedSubmissions, key)) {
      return null;
    }
    var token = {};
    rememberedSubmissions[key] = token;
    return token;
  }

  function forgetSubmission(bridgeId, submissionId, token) {
    var key = bridgeId + ":" + submissionId;
    if (rememberedSubmissions[key] === token) {
      delete rememberedSubmissions[key];
    }
  }

  function releaseRecordSubmission(record) {
    if (
      !record ||
      !record.bridge ||
      record.ready ||
      record.submissionSent ||
      !record.submissionToken
    ) {
      return;
    }
    forgetSubmission(
      record.bridgeId,
      record.submissionId,
      record.submissionToken,
    );
    record.submissionToken = null;
  }

  function fallbackContent(routerUrl) {
    var fallback = document.createElement("div");
    fallback.hidden = true;
    fallback.style.padding = "28px 22px";
    fallback.style.textAlign = "center";

    var title = document.createElement("strong");
    title.textContent = "The scheduler is taking longer than expected.";
    title.style.display = "block";
    title.style.marginBottom = "8px";
    fallback.appendChild(title);

    var copy = document.createElement("p");
    copy.textContent =
      "Your form was still submitted. You can open the scheduler and enter your details there.";
    copy.style.margin = "0 0 16px";
    copy.style.color = "#4f5565";
    fallback.appendChild(copy);

    var link = document.createElement("a");
    link.href = routerUrl.toString();
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Open scheduler";
    link.style.color = "#8b341c";
    link.style.fontWeight = "700";
    fallback.appendChild(link);
    return fallback;
  }

  function removeRecord(record) {
    var index = records.indexOf(record);
    if (index !== -1) records.splice(index, 1);
  }

  function setResumeControlsHidden(record, hidden) {
    if (!record.resumeButtons) return;
    for (var index = 0; index < record.resumeButtons.length; index += 1) {
      record.resumeButtons[index].hidden = hidden;
    }
  }

  function resumeModal(record) {
    if (
      !record ||
      record.closed ||
      record.terminalFailure ||
      !record.backdrop.parentNode
    ) {
      return;
    }
    if (activeModal && activeModal !== record) {
      closeModal(activeModal, "replaced");
    }
    record.previousFocus = document.activeElement;
    record.previousBodyOverflow = document.body.style.overflow;
    record.backdrop.hidden = false;
    record.backdrop.style.display = "flex";
    document.body.style.overflow = "hidden";
    activeModal = record;
    setResumeControlsHidden(record, true);
    record.closeButton.focus();
  }

  function ensureResumeControls(record) {
    if (record.resumeButtons) {
      setResumeControlsHidden(record, false);
      return;
    }
    record.resumeButtons = [];
    for (var index = 0; index < record.bridgeMarkers.length; index += 1) {
      var marker = record.bridgeMarkers[index];
      if (!marker || typeof marker.appendChild !== "function") continue;
      var button = document.createElement("button");
      button.type = "button";
      button.setAttribute("data-hot-potato-resume", "");
      button.textContent = record.booked
        ? "View meeting details"
        : "Resume scheduling";
      button.style.display = "inline-flex";
      button.style.alignItems = "center";
      button.style.justifyContent = "center";
      button.style.marginTop = "12px";
      button.style.padding = "11px 16px";
      button.style.border = "1px solid #8b341c";
      button.style.borderRadius = "999px";
      button.style.background = "#fffaf4";
      button.style.color = "#8b341c";
      button.style.font = "700 14px/1.2 system-ui, sans-serif";
      button.style.cursor = "pointer";
      button.addEventListener("click", function () {
        resumeModal(record);
      });
      marker.appendChild(button);
      record.resumeButtons.push(button);
    }
  }

  function suspendModal(record) {
    record.backdrop.hidden = true;
    record.backdrop.style.display = "none";
    document.body.style.overflow = record.previousBodyOverflow;
    if (activeModal === record) activeModal = null;
    ensureResumeControls(record);
    if (
      record.previousFocus &&
      document.documentElement.contains(record.previousFocus) &&
      typeof record.previousFocus.focus === "function"
    ) {
      record.previousFocus.focus();
    }
  }

  function closeModal(record, reason) {
    if (!record || record.closed) return;
    window.clearTimeout(record.redirectTimer);
    record.redirectTimer = 0;
    dispatch(record, "closed", { booked: Boolean(record.booked) });
    if (record.ready && !record.terminalFailure) {
      suspendModal(record);
      return;
    }
    record.closed = true;
    window.clearTimeout(record.timeout);
    removeRecord(record);
    releaseRecordSubmission(record);
    if (record.complete) {
      record.complete({ ok: false, error: safeCode(reason, "closed") });
      record.complete = null;
    }
    record.submission = null;
    if (record.backdrop.parentNode) {
      record.backdrop.parentNode.removeChild(record.backdrop);
    }
    document.body.style.overflow = record.previousBodyOverflow;
    if (activeModal === record) activeModal = null;
    if (
      record.previousFocus &&
      document.documentElement.contains(record.previousFocus) &&
      typeof record.previousFocus.focus === "function"
    ) {
      record.previousFocus.focus();
    }
  }

  function modalKeydown(record, event) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeModal(record, "closed");
      return;
    }
    if (event.key !== "Tab") return;
    var focusable = modalControls(record);
    var first = focusable[0];
    var last = focusable[focusable.length - 1];
    if (focusable.indexOf(document.activeElement) === -1) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (
      focusable.length === 1 ||
      (event.shiftKey && document.activeElement === first)
    ) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function modalControls(record) {
    var focusable = [record.closeButton];
    if (!record.iframe.hidden) {
      focusable.push(record.iframe);
    } else if (!record.fallback.hidden && record.fallbackLink) {
      focusable.push(record.fallbackLink);
    }
    return focusable;
  }

  function focusSentinel(name) {
    var sentinel = document.createElement("span");
    sentinel.setAttribute("data-hot-potato-focus-" + name, "");
    sentinel.setAttribute("tabindex", "0");
    sentinel.style.position = "fixed";
    sentinel.style.width = "1px";
    sentinel.style.height = "1px";
    sentinel.style.overflow = "hidden";
    sentinel.style.opacity = "0";
    sentinel.style.pointerEvents = "none";
    sentinel.style.outline = "none";
    return sentinel;
  }

  function openModal(bridge, submissionId, submission, submissionToken) {
    if (activeModal) closeModal(activeModal, "replaced");

    var config = bridge.config;
    var routerUrl = new URL(config.routerPath, loaderOrigin);
    var iframeUrl = new URL(routerUrl.toString());
    iframeUrl.searchParams.set("embed", "1");
    iframeUrl.searchParams.set("bridge", bridge.id);
    iframeUrl.searchParams.set("parentOrigin", window.location.origin);

    var previousFocus = document.activeElement;
    var previousBodyOverflow = document.body.style.overflow;
    var backdrop = document.createElement("div");
    backdrop.setAttribute("data-hot-potato-bridge-modal", "");
    backdrop.style.position = "fixed";
    backdrop.style.inset = "0";
    backdrop.style.zIndex = "2147483647";
    backdrop.style.display = "flex";
    backdrop.style.alignItems = "center";
    backdrop.style.justifyContent = "center";
    backdrop.style.padding = "18px";
    backdrop.style.background = "rgba(23, 19, 17, 0.62)";
    backdrop.style.backdropFilter = "blur(7px)";

    var dialog = document.createElement("div");
    modalSequence += 1;
    var titleId = "hot-potato-dialog-title-" + modalSequence;
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", titleId);
    dialog.setAttribute("aria-busy", "true");
    dialog.style.position = "relative";
    dialog.style.width = "min(100%, 760px)";
    dialog.style.maxHeight = "calc(100vh - 36px)";
    dialog.style.overflow = "auto";
    dialog.style.border = "1px solid rgba(255, 255, 255, 0.55)";
    dialog.style.borderRadius = "22px";
    dialog.style.background = "#fffaf4";
    dialog.style.boxShadow = "0 30px 90px rgba(30, 18, 12, 0.32)";

    var heading = document.createElement("h2");
    heading.id = titleId;
    heading.textContent = "Choose a meeting time";
    heading.style.position = "absolute";
    heading.style.width = "1px";
    heading.style.height = "1px";
    heading.style.padding = "0";
    heading.style.margin = "-1px";
    heading.style.overflow = "hidden";
    heading.style.clip = "rect(0, 0, 0, 0)";
    heading.style.whiteSpace = "nowrap";
    heading.style.border = "0";

    var closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.setAttribute("aria-label", "Close meeting scheduler");
    closeButton.textContent = "×";
    closeButton.style.position = "absolute";
    closeButton.style.top = "12px";
    closeButton.style.right = "12px";
    closeButton.style.zIndex = "2";
    closeButton.style.width = "40px";
    closeButton.style.height = "40px";
    closeButton.style.border = "1px solid #d8cec3";
    closeButton.style.borderRadius = "999px";
    closeButton.style.background = "#ffffff";
    closeButton.style.color = "#332a25";
    closeButton.style.font = "700 26px/1 system-ui, sans-serif";
    closeButton.style.cursor = "pointer";

    var iframe = document.createElement("iframe");
    iframe.src = iframeUrl.toString();
    iframe.title = "Find and schedule a meeting";
    iframe.referrerPolicy = "no-referrer";
    iframe.setAttribute(
      "sandbox",
      "allow-forms allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox",
    );
    iframe.style.width = "100%";
    iframe.style.minHeight = "650px";
    iframe.style.border = "0";
    iframe.style.display = "block";
    iframe.hidden = true;

    var startSentinel = focusSentinel("start");
    var endSentinel = focusSentinel("end");
    var fallback = fallbackContent(routerUrl);
    dialog.appendChild(startSentinel);
    dialog.appendChild(heading);
    dialog.appendChild(closeButton);
    dialog.appendChild(fallback);
    dialog.appendChild(iframe);
    dialog.appendChild(endSentinel);
    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);
    document.body.style.overflow = "hidden";

    var record;
    var completion = new Promise(function (resolve) {
      record = {
        bridge: true,
        closed: false,
        complete: resolve,
        container: dialog,
        eventTarget: bridge.markers[0],
        fallback: fallback,
        iframe: iframe,
        origin: iframeUrl.origin,
        ready: false,
        terminalFailure: false,
        timeout: 0,
        submissionId: submissionId,
        submission: submission,
        submissionToken: submissionToken,
        submissionSent: false,
        bridgeId: bridge.id,
        bridgeMarkers: bridge.markers.slice(),
        booked: false,
        redirectTimer: 0,
        resumeButtons: null,
        backdrop: backdrop,
        dialog: dialog,
        closeButton: closeButton,
        fallbackLink: fallback.querySelector("a[href]"),
        previousFocus: previousFocus,
        previousBodyOverflow: previousBodyOverflow,
      };
    });
    activeModal = record;
    records.push(record);
    record.timeout = window.setTimeout(function () {
      showFallback(record, "embed_timeout");
    }, embedTimeoutMilliseconds);
    iframe.addEventListener("error", function () {
      showFallback(record, "embed_load_failed");
    });
    closeButton.addEventListener("click", function () {
      closeModal(record, "closed");
    });
    backdrop.addEventListener("click", function (event) {
      if (event.target === backdrop) closeModal(record, "closed");
    });
    backdrop.addEventListener("keydown", function (event) {
      modalKeydown(record, event);
    });
    startSentinel.addEventListener("focus", function () {
      if (record.closed) return;
      var focusable = modalControls(record);
      focusable[focusable.length - 1].focus();
    });
    endSentinel.addEventListener("focus", function () {
      if (record.closed) return;
      modalControls(record)[0].focus();
    });
    closeButton.focus();
    return completion;
  }

  function bridgeForId(bridgeId) {
    var normalizedId =
      typeof bridgeId === "string" ? bridgeId.toLowerCase() : "";
    if (!validUuid(normalizedId)) return null;
    if (bridges[normalizedId]) return bridges[normalizedId];
    scan(document);
    return bridges[normalizedId] || null;
  }

  function openBridge(bridgeId, input) {
    var bridge = bridgeForId(bridgeId);
    if (!bridge)
      return Promise.resolve({ ok: false, error: "bridge_not_found" });
    if (!hasExactKeys(input, ["submissionId", "values"])) {
      dispatchBridge(bridge, "error", { code: "invalid_submission" });
      return Promise.resolve({ ok: false, error: "invalid_submission" });
    }
    var submissionId = normalizeSubmissionId(input.submissionId);
    if (!submissionId || !validValues(input.values)) {
      dispatchBridge(bridge, "error", { code: "invalid_submission" });
      return Promise.resolve({ ok: false, error: "invalid_submission" });
    }

    var submissionToken = null;
    return configForVerifiedSubmission(bridge)
      .then(function (config) {
        if (!config) {
          return {
            ok: false,
            error: bridge.error || "bridge_config_unavailable",
          };
        }
        var submission = mappedSubmission(config, input.values);
        if (!submission) {
          dispatchBridge(bridge, "error", {
            code: "invalid_mapped_submission",
          });
          return { ok: false, error: "invalid_mapped_submission" };
        }
        submissionToken = rememberSubmission(bridge.id, submissionId);
        if (!submissionToken) {
          dispatchBridge(bridge, "error", { code: "duplicate_submission" });
          return { ok: false, error: "duplicate_submission" };
        }
        return openModal(bridge, submissionId, submission, submissionToken);
      })
      .catch(function () {
        if (submissionToken) {
          forgetSubmission(bridge.id, submissionId, submissionToken);
        }
        dispatchBridge(bridge, "error", { code: "bridge_open_failed" });
        return { ok: false, error: "bridge_open_failed" };
      });
  }

  function hubspotSuccess(event) {
    scan(document);
    var formId =
      event && event.detail && typeof event.detail.formId === "string"
        ? event.detail.formId
        : "";
    var api = window.HubSpotFormsV4;
    if (!formId || !api || typeof api.getFormFromEvent !== "function") {
      return;
    }

    var form;
    try {
      form = api.getFormFromEvent(event);
      if (
        !form ||
        typeof form.getFormId !== "function" ||
        form.getFormId() !== formId
      ) {
        return;
      }
    } catch (_error) {
      return;
    }

    var pending = Object.keys(bridges).map(function (bridgeId) {
      var bridge = bridges[bridgeId];
      return configForVerifiedSubmission(bridge).then(function (config) {
        return { bridge: bridge, config: config };
      });
    });
    Promise.all(pending).then(function (results) {
      var matching = [];
      for (var index = 0; index < results.length; index += 1) {
        if (
          results[index].config &&
          results[index].config.provider === "hubspot" &&
          results[index].config.formId === formId
        ) {
          matching.push(results[index].bridge);
        }
      }
      if (matching.length !== 1) {
        if (matching.length > 1) {
          for (
            var matchIndex = 0;
            matchIndex < matching.length;
            matchIndex += 1
          ) {
            dispatchBridge(matching[matchIndex], "error", {
              code: "ambiguous_hubspot_bridge",
            });
          }
        }
        return;
      }

      var redirectUrl;
      var conversionId;
      try {
        if (
          typeof form.getRedirectUrl !== "function" ||
          typeof form.getConversionId !== "function" ||
          typeof form.getFormFieldValues !== "function"
        ) {
          throw new Error("unsupported");
        }
        redirectUrl = form.getRedirectUrl();
        if (
          redirectUrl !== null &&
          redirectUrl !== undefined &&
          (typeof redirectUrl !== "string" || redirectUrl.trim() !== "")
        ) {
          return;
        }
        conversionId = form.getConversionId();
      } catch (_error) {
        dispatchBridge(matching[0], "error", {
          code: "hubspot_form_unavailable",
        });
        return;
      }
      conversionId = normalizeSubmissionId(conversionId);
      if (!conversionId) {
        dispatchBridge(matching[0], "error", { code: "invalid_submission" });
        return;
      }

      var fieldValues;
      try {
        fieldValues = form.getFormFieldValues();
      } catch (_error) {
        dispatchBridge(matching[0], "error", {
          code: "hubspot_fields_unavailable",
        });
        return;
      }
      Promise.resolve(fieldValues)
        .then(function (fields) {
          if (!Array.isArray(fields) || fields.length > 200) {
            throw new Error("invalid_fields");
          }
          var values = {};
          for (
            var fieldIndex = 0;
            fieldIndex < fields.length;
            fieldIndex += 1
          ) {
            var field = fields[fieldIndex];
            if (
              !hasExactKeys(field, ["name", "value"]) ||
              !validSourceField(field.name)
            ) {
              throw new Error("invalid_fields");
            }
            values[field.name] = field.value;
          }
          return openBridge(matching[0].id, {
            submissionId: conversionId,
            values: values,
          });
        })
        .catch(function () {
          dispatchBridge(matching[0], "error", {
            code: "hubspot_fields_unavailable",
          });
        });
    });
  }

  function scan(root) {
    if (!root) return;
    if (root.nodeType === Node.ELEMENT_NODE && root.matches) {
      if (root.matches(inlineSelector)) mountInline(root);
      if (root.matches(bridgeSelector)) mountBridgeMarker(root);
    }
    var inlineTargets = root.querySelectorAll
      ? root.querySelectorAll(inlineSelector)
      : [];
    for (
      var inlineIndex = 0;
      inlineIndex < inlineTargets.length;
      inlineIndex += 1
    ) {
      mountInline(inlineTargets[inlineIndex]);
    }
    var bridgeTargets = root.querySelectorAll
      ? root.querySelectorAll(bridgeSelector)
      : [];
    for (
      var bridgeIndex = 0;
      bridgeIndex < bridgeTargets.length;
      bridgeIndex += 1
    ) {
      mountBridgeMarker(bridgeTargets[bridgeIndex]);
    }
  }

  var publicForms =
    window.HotPotatoForms && typeof window.HotPotatoForms === "object"
      ? window.HotPotatoForms
      : {};
  publicForms.open = function (bridgeId, input) {
    try {
      return Promise.resolve(openBridge(bridgeId, input)).catch(function () {
        return { ok: false, error: "bridge_open_failed" };
      });
    } catch (_error) {
      return Promise.resolve({ ok: false, error: "bridge_open_failed" });
    }
  };
  window.HotPotatoForms = publicForms;

  window.addEventListener("message", receiveMessage);
  window.addEventListener(
    "hs-form-event:on-submission:success",
    hubspotSuccess,
  );
  var observer = new MutationObserver(function (mutations) {
    mutations.forEach(function (mutation) {
      if (mutation.type === "attributes") {
        scan(mutation.target);
        return;
      }
      mutation.addedNodes.forEach(scan);
    });
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-hot-potato-router", "data-hot-potato-form-bridge"],
  });

  window[globalKey] = { scan: scan };
  scan(document);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      scan(document);
    });
  }
})();
