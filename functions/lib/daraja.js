"use strict";

/*
 * Safaricom Daraja (M-Pesa) helpers.
 * The top half is pure and unit-tested. The bottom half makes the network calls.
 */
var crypto = require("crypto");
var fs = require("fs");
var path = require("path");

/* ---------- pure helpers ---------- */

function baseUrl(env) {
  return env === "production" ? "https://api.safaricom.co.ke" : "https://sandbox.safaricom.co.ke";
}

/* YYYYMMDDHHmmss in East Africa Time (UTC+3), the format Daraja expects. */
function timestamp(date) {
  var d = new Date((date || new Date()).getTime() + 3 * 3600 * 1000);
  return d.toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

function stkPassword(shortcode, passkey, ts) {
  return Buffer.from(String(shortcode) + passkey + ts).toString("base64");
}

/* Reads the callback Safaricom posts after a customer answers (or ignores) the PIN prompt. */
function parseStkCallback(body) {
  var cb = body && body.Body && body.Body.stkCallback;
  if (!cb || !cb.CheckoutRequestID) return null;
  var items = (cb.CallbackMetadata && cb.CallbackMetadata.Item) || [];
  var meta = {};
  items.forEach(function (i) { if (i && i.Name) meta[i.Name] = i.Value; });
  return {
    checkoutRequestId: String(cb.CheckoutRequestID),
    merchantRequestId: String(cb.MerchantRequestID || ""),
    resultCode: Number(cb.ResultCode),
    resultDesc: String(cb.ResultDesc || ""),
    amount: meta.Amount === undefined ? null : Number(meta.Amount),
    receipt: meta.MpesaReceiptNumber ? String(meta.MpesaReceiptNumber) : null,
    phone: meta.PhoneNumber ? String(meta.PhoneNumber) : null
  };
}

/* Reads the result Safaricom posts after a payout (B2C). */
function parseB2CResult(body) {
  var r = body && body.Result;
  if (!r || !r.OriginatorConversationID) return null;
  var params = (r.ResultParameters && r.ResultParameters.ResultParameter) || [];
  var map = {};
  (Array.isArray(params) ? params : [params]).forEach(function (p) { if (p && p.Key) map[p.Key] = p.Value; });
  return {
    originatorId: String(r.OriginatorConversationID),
    conversationId: String(r.ConversationID || ""),
    resultCode: Number(r.ResultCode),
    resultDesc: String(r.ResultDesc || ""),
    receipt: map.TransactionReceipt ? String(map.TransactionReceipt) : (r.TransactionID ? String(r.TransactionID) : null),
    receiverName: map.ReceiverPartyPublicName ? String(map.ReceiverPartyPublicName) : null,
    amount: map.TransactionAmount === undefined ? null : Number(map.TransactionAmount)
  };
}

/* Safaricom wants the initiator password encrypted with their public certificate. */
function securityCredential(password, certPem) {
  var encrypted = crypto.publicEncrypt(
    { key: certPem, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(password)
  );
  return encrypted.toString("base64");
}

function loadCertificate(env) {
  var file = env === "production" ? "ProductionCertificate.cer" : "SandboxCertificate.cer";
  var p = path.join(__dirname, "..", "certs", file);
  if (!fs.existsSync(p)) {
    throw new Error("Missing functions/certs/" + file + ". Download it from the Daraja portal (see BACKEND-SETUP.md).");
  }
  return fs.readFileSync(p, "utf8");
}

/* ---------- network calls ---------- */

async function call(env, token, urlPath, body) {
  var res = await fetch(baseUrl(env) + urlPath, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify(body)
  });
  var text = await res.text();
  var json;
  try { json = JSON.parse(text); } catch (e) { json = { raw: text }; }
  if (!res.ok) {
    var msg = json.errorMessage || json.ResponseDescription || json.raw || ("HTTP " + res.status);
    var err = new Error("Daraja: " + msg);
    err.status = res.status;
    throw err;
  }
  return json;
}

async function getToken(env, key, secret) {
  var auth = Buffer.from(key + ":" + secret).toString("base64");
  var res = await fetch(baseUrl(env) + "/oauth/v1/generate?grant_type=client_credentials", {
    headers: { Authorization: "Basic " + auth }
  });
  if (!res.ok) throw new Error("Daraja sign-in failed (HTTP " + res.status + "). Check the consumer key and secret.");
  var json = await res.json();
  if (!json.access_token) throw new Error("Daraja sign-in returned no token.");
  return json.access_token;
}

/* Sends the "enter your M-Pesa PIN" prompt to the customer's phone. */
async function stkPush(cfg, o) {
  var token = await getToken(cfg.env, cfg.key, cfg.secret);
  var ts = timestamp();
  return call(cfg.env, token, "/mpesa/stkpush/v1/processrequest", {
    BusinessShortCode: cfg.shortcode,
    Password: stkPassword(cfg.shortcode, cfg.passkey, ts),
    Timestamp: ts,
    TransactionType: cfg.transactionType || "CustomerPayBillOnline",
    Amount: o.amount,
    PartyA: o.phone,
    PartyB: cfg.shortcode,
    PhoneNumber: o.phone,
    CallBackURL: o.callbackUrl,
    AccountReference: String(o.reference).slice(0, 12),
    TransactionDesc: String(o.description || "Mzigo Hub load").slice(0, 13)
  });
}

/* Asks Safaricom directly what happened to a payment. This is how we confirm a callback is genuine. */
async function stkQuery(cfg, checkoutRequestId) {
  var token = await getToken(cfg.env, cfg.key, cfg.secret);
  var ts = timestamp();
  var json = await call(cfg.env, token, "/mpesa/stkpushquery/v1/query", {
    BusinessShortCode: cfg.shortcode,
    Password: stkPassword(cfg.shortcode, cfg.passkey, ts),
    Timestamp: ts,
    CheckoutRequestID: checkoutRequestId
  });
  return { resultCode: json.ResultCode === undefined ? null : Number(json.ResultCode), resultDesc: json.ResultDesc || "" };
}

/* Pays money out to a phone number. */
async function b2c(cfg, o) {
  var token = await getToken(cfg.env, cfg.key, cfg.secret);
  return call(cfg.env, token, "/mpesa/b2c/v1/paymentrequest", {
    OriginatorConversationID: o.originatorId,
    InitiatorName: cfg.initiatorName,
    SecurityCredential: securityCredential(cfg.initiatorPassword, loadCertificate(cfg.env)),
    CommandID: "BusinessPayment",
    Amount: o.amount,
    PartyA: cfg.b2cShortcode,
    PartyB: o.phone,
    Remarks: String(o.remarks || "Mzigo Hub payout").slice(0, 100),
    QueueTimeOutURL: o.timeoutUrl,
    ResultURL: o.resultUrl,
    Occasion: String(o.occasion || "").slice(0, 100)
  });
}

module.exports = {
  baseUrl: baseUrl,
  timestamp: timestamp,
  stkPassword: stkPassword,
  parseStkCallback: parseStkCallback,
  parseB2CResult: parseB2CResult,
  securityCredential: securityCredential,
  stkPush: stkPush,
  stkQuery: stkQuery,
  b2c: b2c
};
