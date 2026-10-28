"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const phone = require("../lib/phone");
const money = require("../lib/money");
const matching = require("../lib/matching");
const state = require("../lib/state");
const daraja = require("../lib/daraja");
require("../lib/price-config");
const pricing = require("../lib/pricing");

/* ---------- phone ---------- */
test("phone: accepts common Kenyan formats", () => {
  for (const input of ["0712345678", "0712 345 678", "+254712345678", "254712345678", "712345678", "0112345678", "+254 (712) 345-678"]) {
    assert.match(phone.normalizeKenyaPhone(input), /^254[17]\d{8}$/, input);
  }
  assert.equal(phone.normalizeKenyaPhone("0712345678"), "254712345678");
  assert.equal(phone.normalizeKenyaPhone("0112345678"), "254112345678");
});
test("phone: rejects bad numbers", () => {
  for (const bad of ["", "abc", "071234567", "07123456789", "+256712345678", "0212345678", null, undefined, 712345678, "254212345678"]) {
    assert.equal(phone.normalizeKenyaPhone(bad), null, String(bad));
  }
});

/* ---------- money ---------- */
test("money: amount limits", () => {
  assert.equal(money.isValidAmount(100), true);
  assert.equal(money.isValidAmount(250000), true);
  assert.equal(money.isValidAmount(99), false);
  assert.equal(money.isValidAmount(250001), false);
  assert.equal(money.isValidAmount(1000.5), false);
  assert.equal(money.isValidAmount("1000"), false);
  assert.equal(money.isValidAmount(NaN), false);
});
test("money: commission split always adds back to the total", () => {
  for (let a = 100; a <= 250000; a += 777) {
    const s = money.split(a, 0.08);
    assert.equal(s.fee + s.payout, a);
    assert.ok(Number.isInteger(s.fee) && Number.isInteger(s.payout));
  }
  assert.deepEqual(money.split(115200, 0.08), { fee: 9216, payout: 105984 });
  assert.throws(() => money.split(1000, 0.9));
  assert.throws(() => money.split(0, 0.08));
});

/* ---------- matching ---------- */
const truck = (over) => Object.assign({
  id: "t1", ownerId: "owner1", status: "approved", capacityT: 28, activeLoadId: null, approvedAtMs: 1000,
  rules: { autoAccept: true, routes: [{ from: "mombasa", to: "nairobi" }], minPriceKES: 100000, maxTonnes: 28, cargo: [] }
}, over);
const load = (over) => Object.assign({ shipperId: "shipper1", from: "mombasa", to: "nairobi", tonnes: 20, cargo: "general", priceKES: 115000 }, over);

test("matching: a load that fits every rule is accepted", () => {
  assert.deepEqual(matching.autoAcceptCheck(truck(), load()), { ok: true });
});
test("matching: each rule can say no", () => {
  const no = (t, l, reason) => { const r = matching.autoAcceptCheck(t, l); assert.equal(r.ok, false); assert.equal(r.reason, reason); };
  no(truck({ status: "pending" }), load(), "truck not verified");
  no(truck({ status: "rejected" }), load(), "truck not verified");
  no(truck({ activeLoadId: "x" }), load(), "truck busy");
  no(truck({ ownerId: "shipper1" }), load(), "own load");
  no(truck({ capacityT: 10 }), load({ tonnes: 12 }), "too heavy for truck");
  no(truck(), load({ from: "nairobi", to: "mombasa" }), "route not in rules");
  no(truck(), load({ priceKES: 99999 }), "below minimum price");
  no(truck({ rules: { autoAccept: false, routes: [{ from: "mombasa", to: "nairobi" }], minPriceKES: 0 } }), load(), "auto-accept off");
  no(truck({ rules: { autoAccept: true, routes: [{ from: "mombasa", to: "nairobi" }], minPriceKES: 0, maxTonnes: 15 } }), load({ tonnes: 20 }), "above max weight rule");
  no(truck({ rules: { autoAccept: true, routes: [{ from: "mombasa", to: "nairobi" }], minPriceKES: 0, cargo: ["farm"] } }), load({ cargo: "cold" }), "cargo type not accepted");
});
test("matching: wildcard routes, and price exactly at the minimum", () => {
  const t = truck({ rules: { autoAccept: true, routes: [{ from: "*", to: "nairobi" }], minPriceKES: 115000 } });
  assert.equal(matching.autoAcceptCheck(t, load({ from: "kampala" })).ok, true);
  assert.equal(matching.autoAcceptCheck(t, load({ from: "kampala", to: "kigali" })).ok, false);
  assert.equal(matching.autoAcceptCheck(t, load({ priceKES: 115000 })).ok, true);
});
test("matching: manual accept ignores the auto-accept switch but not safety checks", () => {
  const off = truck({ rules: { autoAccept: false, routes: [], minPriceKES: 0 } });
  assert.equal(matching.check(off, load()).ok, true);
  assert.equal(matching.check(truck({ status: "pending" }), load()).ok, false);
  assert.equal(matching.check(truck({ activeLoadId: "x" }), load()).ok, false);
});
test("matching: cheapest owner wins, then the longest-verified", () => {
  const a = truck({ id: "a", approvedAtMs: 5, rules: { autoAccept: true, routes: [{ from: "*", to: "*" }], minPriceKES: 90000 } });
  const b = truck({ id: "b", approvedAtMs: 1, rules: { autoAccept: true, routes: [{ from: "*", to: "*" }], minPriceKES: 80000 } });
  const c = truck({ id: "c", approvedAtMs: 2, rules: { autoAccept: true, routes: [{ from: "*", to: "*" }], minPriceKES: 80000 } });
  const d = truck({ id: "d", status: "pending", rules: { autoAccept: true, routes: [{ from: "*", to: "*" }], minPriceKES: 1 } });
  assert.deepEqual(matching.pickBest([a, b, c, d], load()).map((t) => t.id), ["b", "c", "a"]);
});

/* ---------- load status flow ---------- */
test("state: the happy path is allowed", () => {
  const path_ = ["open", "accepted", "payment_pending", "paid", "in_transit", "payout_pending", "completed"];
  for (let i = 0; i < path_.length - 1; i++) assert.equal(state.canMove(path_[i], path_[i + 1]), true, path_[i]);
});
test("state: money steps cannot be skipped", () => {
  assert.equal(state.canMove("open", "paid"), false);
  assert.equal(state.canMove("accepted", "paid"), false);
  assert.equal(state.canMove("accepted", "in_transit"), false);
  assert.equal(state.canMove("paid", "completed"), false);
  assert.equal(state.canMove("paid", "payout_pending"), false);
  assert.equal(state.canMove("payment_pending", "cancelled"), false);
  assert.equal(state.canMove("paid", "cancelled"), false);
  assert.equal(state.canMove("in_transit", "cancelled"), false);
});
test("state: finished loads stay finished", () => {
  for (const s of ["completed", "cancelled", "refunded"]) {
    assert.equal(state.isFinished(s), true);
    for (const to of Object.keys(state.MOVES)) assert.equal(state.canMove(s, to), false, s + " -> " + to);
  }
  assert.equal(state.canMove("nonsense", "paid"), false);
});
test("state: every target status exists", () => {
  for (const [from, tos] of Object.entries(state.MOVES)) for (const to of tos) assert.ok(state.MOVES[to], from + " -> " + to);
});

/* ---------- Daraja helpers ---------- */
test("daraja: timestamp is 14 digits in East Africa Time", () => {
  assert.equal(daraja.timestamp(new Date("2026-10-28T08:05:09Z")), "20261028110509");
  assert.equal(daraja.timestamp(new Date("2026-12-31T22:00:00Z")), "20270101010000");
});
test("daraja: password is base64 of shortcode+passkey+timestamp", () => {
  const p = daraja.stkPassword("174379", "KEY", "20261028110509");
  assert.equal(Buffer.from(p, "base64").toString(), "174379KEY20261028110509");
});
test("daraja: urls", () => {
  assert.equal(daraja.baseUrl("sandbox"), "https://sandbox.safaricom.co.ke");
  assert.equal(daraja.baseUrl("production"), "https://api.safaricom.co.ke");
  assert.equal(daraja.baseUrl(undefined), "https://sandbox.safaricom.co.ke");
});
test("daraja: reads a successful payment callback", () => {
  const body = { Body: { stkCallback: {
    MerchantRequestID: "29115-34620561-1", CheckoutRequestID: "ws_CO_191220191020363925", ResultCode: 0, ResultDesc: "The service request is processed successfully.",
    CallbackMetadata: { Item: [{ Name: "Amount", Value: 1 }, { Name: "MpesaReceiptNumber", Value: "NLJ7RT61SV" }, { Name: "TransactionDate", Value: 20191219102115 }, { Name: "PhoneNumber", Value: 254708374149 }] }
  } } };
  assert.deepEqual(daraja.parseStkCallback(body), {
    checkoutRequestId: "ws_CO_191220191020363925", merchantRequestId: "29115-34620561-1", resultCode: 0,
    resultDesc: "The service request is processed successfully.", amount: 1, receipt: "NLJ7RT61SV", phone: "254708374149"
  });
});
test("daraja: reads a cancelled payment callback", () => {
  const r = daraja.parseStkCallback({ Body: { stkCallback: { MerchantRequestID: "m", CheckoutRequestID: "c", ResultCode: 1032, ResultDesc: "Request cancelled by user" } } });
  assert.equal(r.resultCode, 1032);
  assert.equal(r.receipt, null);
  assert.equal(r.amount, null);
});
test("daraja: ignores junk callbacks", () => {
  for (const junk of [null, {}, { Body: {} }, { Body: { stkCallback: {} } }, "text"]) assert.equal(daraja.parseStkCallback(junk), null);
  for (const junk of [null, {}, { Result: {} }]) assert.equal(daraja.parseB2CResult(junk), null);
});
test("daraja: reads a payout result", () => {
  const body = { Result: {
    ResultType: 0, ResultCode: 0, ResultDesc: "The service request is processed successfully.",
    OriginatorConversationID: "abc-123", ConversationID: "AG_2019", TransactionID: "NLJ41HAY6Q",
    ResultParameters: { ResultParameter: [
      { Key: "TransactionAmount", Value: 105984 },
      { Key: "TransactionReceipt", Value: "NLJ41HAY6Q" },
      { Key: "ReceiverPartyPublicName", Value: "254712345678 - JOHN KAMAU" }
    ] }
  } };
  const r = daraja.parseB2CResult(body);
  assert.equal(r.originatorId, "abc-123");
  assert.equal(r.resultCode, 0);
  assert.equal(r.receipt, "NLJ41HAY6Q");
  assert.equal(r.receiverName, "254712345678 - JOHN KAMAU");
  assert.equal(r.amount, 105984);
});
test("daraja: failed payout result", () => {
  const r = daraja.parseB2CResult({ Result: { ResultCode: 2001, ResultDesc: "The initiator information is invalid.", OriginatorConversationID: "x" } });
  assert.equal(r.resultCode, 2001);
  assert.equal(r.receipt, null);
});
test("daraja: security credential decrypts with the matching private key", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cred-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"), "-days", "2", "-subj", "/CN=test"], { stdio: "ignore" });
    const cert = fs.readFileSync(path.join(dir, "c.pem"), "utf8");
    const key = fs.readFileSync(path.join(dir, "k.pem"), "utf8");
    const out = daraja.securityCredential("TestPassword1!", cert);
    // Newer Node 20 releases refuse PKCS#1 v1.5 decryption (a security fix), so decrypt raw and unpad by hand.
    const raw = crypto.privateDecrypt({ key, padding: crypto.constants.RSA_NO_PADDING }, Buffer.from(out, "base64"));
    assert.equal(raw[0], 0x00);
    assert.equal(raw[1], 0x02); // PKCS#1 v1.5 encryption block
    const end = raw.indexOf(0x00, 2);
    assert.ok(end >= 10, "padding string must be at least 8 bytes");
    assert.equal(raw.subarray(end + 1).toString(), "TestPassword1!");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/* ---------- price model matches the website ---------- */
test("pricing: server copy gives the same numbers as the site", () => {
  const e = pricing.estimate({ from: "mombasa", to: "nairobi", tonnes: 28, cargo: "building" });
  assert.equal(Math.round(e.mid), 115200);
  assert.equal(e.km, 480);
  assert.equal(pricing.estimate({ from: "nairobi", to: "nairobi", tonnes: 5, cargo: "general" }), null);
});
