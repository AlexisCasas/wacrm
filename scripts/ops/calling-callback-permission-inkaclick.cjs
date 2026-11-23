#!/usr/bin/env node
"use strict";

// CALL-04: run inside the LIVE WACRM app container, from audited source on
// the VPS host: docker exec -i wacrm-app-1 node - audit < <this-file>
// Uses built-in Node modules only. Secrets never leave the container, except
// via HTTPS Authorization headers sent directly to Meta.
// Modes: audit (GET only), enable (single narrow POST), verify (GET only),
// rollback (single narrow POST). No calls/messages/webhooks are sent.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- stdin runner is intentionally CommonJS, with no build dependencies.
const crypto = require("node:crypto");

const PHONE_NUMBER_ID = "740434745820831";
const APPROVED_MODE = "ALLOW_APPROVED_PERMISSION_ONLY";
const GRAPH_ORIGIN = "https://graph.facebook.com";
const ACTIVE_STATES = "in.(offered,ringing,connecting,connected)";
const VALID_MODES = new Set(["audit", "enable", "verify", "rollback"]);

function safeCallingSettings(response) {
  const c = response && typeof response === "object" && response.calling;
  if (!c || typeof c !== "object" || Array.isArray(c)) {
    throw new Error("META_CALLING_SETTINGS_MISSING");
  }
  const value = (x) => typeof x === "string" && x.length < 100 ? x : "UNKNOWN";
  return {
    calling_status: value(c.status),
    callback_permission_status: value(c.callback_permission_status),
    call_permission_mode: value(c.call_permission_mode),
    sip_status: value(c.sip && c.sip.status || "NOT_SET"),
    call_icon_visibility: value(c.call_icon_visibility || "NOT_SET"),
  };
}

function assertSafeCallingMode(settings) {
  if (settings.calling_status !== "ENABLED") throw new Error("CALLING_NOT_ENABLED");
  if (settings.call_permission_mode !== APPROVED_MODE) {
    throw new Error("PERMISSION_MODE_NOT_APPROVED_ONLY");
  }
  // Meta specifies SIP disabled by default. Unknown explicit SIP values fail.
  if (!["DISABLED", "NOT_SET"].includes(settings.sip_status)) {
    throw new Error("SIP_STATE_UNSAFE");
  }
}

function callbackPayload(enabled) {
  return { calling: { callback_permission_status: enabled ? "ENABLED" : "DISABLED" } };
}

function stableJson(value) {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort()
      .map((key) => JSON.stringify(key) + ":" + stableJson(value[key]))
      .join(",") + "}";
  }
  return JSON.stringify(value);
}

function unchangedCallingFields(response) {
  const c = response.calling;
  // Do not copy the callback switch (the only intended change).
  // Do not include dynamically changing restrictions or generated metadata.
  const fields = [
    "status", "call_permission_mode", "call_icon_visibility", "call_icons",
    "call_hours", "sip", "audio", "voicemail",
  ];
  return stableJson(Object.fromEntries(fields
    .filter((field) => Object.prototype.hasOwnProperty.call(c, field))
    .map((field) => [field, c[field]])));
}

function decryptToken(encrypted, key) {
  if (typeof encrypted !== "string" || !/^[0-9a-f]{2,}:[0-9a-f]+(?::[0-9a-f]{32})?$/i.test(encrypted)) {
    throw new Error("TOKEN_FORMAT_UNEXPECTED");
  }
  if (!/^[0-9a-f]{64}$/i.test(key || "")) throw new Error("ENCRYPTION_KEY_INVALID");
  const [ivHex, ciphertextHex, tagHex] = encrypted.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const rawKey = Buffer.from(key, "hex");
  if (tagHex) {
    if (iv.length !== 12) throw new Error("GCM_IV_INVALID");
    const decipher = crypto.createDecipheriv("aes-256-gcm", rawKey, iv);
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return decipher.update(ciphertextHex, "hex", "utf8") + decipher.final("utf8");
  }
  if (iv.length !== 16) throw new Error("CBC_IV_INVALID");
  const decipher = crypto.createDecipheriv("aes-256-cbc", rawKey, iv);
  return decipher.update(ciphertextHex, "hex", "utf8") + decipher.final("utf8");
}

async function safeFetchJson(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error("HTTP_" + response.status);
  try {
    return await response.json();
  } catch {
    throw new Error("NON_JSON_RESPONSE");
  }
}

async function createContext() {
  const e = process.env;
  if (e.WHATSAPP_CALLING_ENABLED !== "true"
    || e.WHATSAPP_CALLING_PILOT_PHONE_NUMBER_IDS !== PHONE_NUMBER_ID
    || e.WHATSAPP_CALLING_KEYLER_ALL_CONTACTS !== "true"
    || e.FLOW_RECOVERY_ACTIVE !== "true") throw new Error("RUNTIME_PILOT_FLAGS_NOT_APPROVED");

  const base = e.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = e.SUPABASE_SERVICE_ROLE_KEY;
  if (!/^https?:\/\//.test(base || "") || !serviceKey) throw new Error("DB_CONFIG_MISSING");
  const configUrl = new URL(base.replace(/\/$/, "") + "/rest/v1/whatsapp_config");
  configUrl.searchParams.set("select", "account_id,phone_number_id,status,access_token");
  configUrl.searchParams.set("phone_number_id", "eq." + PHONE_NUMBER_ID);
  configUrl.searchParams.set("limit", "2");

  const headers = { apikey: serviceKey, Authorization: "Bearer " + serviceKey };
  const configs = await safeFetchJson(configUrl, { headers, cache: "no-store" });
  if (!Array.isArray(configs) || configs.length !== 1
    || configs[0].phone_number_id !== PHONE_NUMBER_ID
    || configs[0].status !== "connected"
    || !/^[0-9a-f-]{36}$/i.test(configs[0].account_id || "")) {
    throw new Error("PILOT_DB_CONFIG_NOT_UNIQUE_OR_CONNECTED");
  }

  const accessToken = decryptToken(configs[0].access_token, e.ENCRYPTION_KEY);
  if (!accessToken || accessToken.length < 20) throw new Error("DECRYPTED_TOKEN_INVALID");
  const version = e.WHATSAPP_CALLING_API_VERSION || "v27.0";
  if (!/^v\d{2}\.\d+$/.test(version)) throw new Error("GRAPH_VERSION_INVALID");

  const settingsUrl = new URL(GRAPH_ORIGIN + "/" + version + "/" + PHONE_NUMBER_ID + "/settings");
  return { accessToken, settingsUrl, accountId: configs[0].account_id, dbBase: base, dbHeaders: headers };
}

async function readMetaSettings(ctx) {
  const result = await safeFetchJson(ctx.settingsUrl, {
    headers: { Authorization: "Bearer " + ctx.accessToken },
    cache: "no-store",
  });
  safeCallingSettings(result);
  return result;
}

async function activeCallGate(ctx) {
  const url = new URL(ctx.dbBase.replace(/\/$/, "") + "/rest/v1/whatsapp_call_sessions");
  url.searchParams.set("select", "id");
  url.searchParams.set("account_id", "eq." + ctx.accountId);
  url.searchParams.set("phone_number_id", "eq." + PHONE_NUMBER_ID);
  url.searchParams.set("state", ACTIVE_STATES);
  url.searchParams.set("limit", "1");
  const rows = await safeFetchJson(url, {
    headers: ctx.dbHeaders, cache: "no-store",
  });
  if (!Array.isArray(rows)) throw new Error("ACTIVE_CALL_QUERY_INVALID");
  console.log("ACTIVE_CALLS=" + (rows.length ? ">=1" : "0"));
  if (rows.length) throw new Error("ACTIVE_CALLS_BLOCK_CHANGE");
  console.log("CALLS_GATE=PASS");
}

async function updateCallback(ctx, enabled) {
  // Single POST. Never automatically retry, including after network uncertainty.
  let response;
  try {
    response = await safeFetchJson(ctx.settingsUrl, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + ctx.accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(callbackPayload(enabled)),
    });
  } catch (error) {
    console.log("META_POST=UNCONFIRMED_OR_REJECTED");
    console.log("NEXT_ACTION=READ_ONLY_VERIFY_DO_NOT_RETRY_POST");
    throw error;
  }
  if (!response || response.success !== true) {
    throw new Error("META_POST_SUCCESS_NOT_CONFIRMED");
  }
  console.log("META_POST=ACKNOWLEDGED");
}

async function main(mode) {
  if (!VALID_MODES.has(mode)) throw new Error("INVALID_MODE_USE_audit_enable_verify_rollback");
  const ctx = await createContext();
  console.log("TARGET=INKACLICK_KEYLER_ONLY");
  console.log("PHONE_NUMBER_ID=" + PHONE_NUMBER_ID);
  console.log("OPERATION=" + mode.toUpperCase());
  const beforeRaw = await readMetaSettings(ctx);
  const before = safeCallingSettings(beforeRaw);
  console.log("META_BEFORE=" + JSON.stringify(before));
  assertSafeCallingMode(before);
  console.log("CALLING_MODE_GATE=PASS");

  if (mode === "audit" || mode === "verify") {
    console.log("READY_FOR_ENABLE=" + (before.callback_permission_status === "DISABLED" ? "YES" : "NO"));
    console.log("CALLBACK_SETTINGS_" + mode.toUpperCase() + "=PASS");
    console.log("META_SETTINGS_CHANGED=NO");
    return;
  }

  if (process.env.CALLBACK_CHANGE_APPROVED !== "YES"
    || process.env.CALLBACK_EXPECTED_PHONE_NUMBER_ID !== PHONE_NUMBER_ID) {
    throw new Error("EXPLICIT_OPERATION_AUTHORIZATION_MISSING");
  }
  const isEnable = mode === "enable";
  const expectedBefore = isEnable ? "DISABLED" : "ENABLED";
  const expectedAfter = isEnable ? "ENABLED" : "DISABLED";
  if (before.callback_permission_status !== expectedBefore) {
    throw new Error("CALLBACK_PREVIOUS_STATE_UNEXPECTED_" + before.callback_permission_status);
  }
  await activeCallGate(ctx);
  const frozen = unchangedCallingFields(beforeRaw);
  await updateCallback(ctx, isEnable);
  const afterRaw = await readMetaSettings(ctx);
  const after = safeCallingSettings(afterRaw);
  console.log("META_AFTER=" + JSON.stringify(after));

  if (after.callback_permission_status !== expectedAfter) {
    throw new Error("CALLBACK_POST_VERIFY_MISMATCH_READ_ONLY_INVESTIGATE");
  }
  if (unchangedCallingFields(afterRaw) !== frozen) {
    throw new Error("UNRELATED_CALLING_SETTINGS_DRIFT_REVIEW_REQUIRED");
  }
  assertSafeCallingMode(after);
  console.log("CALLBACK_" + (isEnable ? "ENABLED" : "ROLLED_BACK") + "=PASS");
  console.log("META_SETTINGS_CHANGED=YES_CALLBACK_ONLY");
}

module.exports = {
  PHONE_NUMBER_ID, safeCallingSettings, assertSafeCallingMode,
  callbackPayload, unchangedCallingFields, decryptToken,
};

if (process.argv[1] === "-" || process.argv[1]?.endsWith("/calling-callback-permission-inkaclick.cjs")) {
  main(process.argv[2]).catch((error) => {
    // Do not leak Meta response bodies, ciphertext, tokens, or settings JSON.
    console.error("CALLBACK_OPS=FAIL", error instanceof Error ? error.message : "UNKNOWN");
    process.exitCode = 1;
  });
}
