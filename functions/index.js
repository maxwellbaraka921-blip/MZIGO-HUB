"use strict";

/*
 * Mzigo Hub backend (Firebase Cloud Functions).
 *
 * Everything that touches money or changes a load's status happens here, never in the
 * browser. The browser can only read what the security rules allow and ask these
 * functions to act.
 */
const crypto = require("crypto");
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions } = require("firebase-functions/v2");
const { defineSecret, defineString } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");

require("./lib/price-config");
const pricing = require("./lib/pricing");
const phoneLib = require("./lib/phone");
const money = require("./lib/money");
const matching = require("./lib/matching");
const state = require("./lib/state");
const daraja = require("./lib/daraja");

initializeApp();
const db = getFirestore();

const REGION = "europe-west1";
setGlobalOptions({ region: REGION, maxInstances: 10 });

/* ---------- settings ---------- */
const DARAJA_KEY = defineSecret("DARAJA_KEY");
const DARAJA_SECRET = defineSecret("DARAJA_SECRET");
const DARAJA_PASSKEY = defineSecret("DARAJA_PASSKEY");
const DARAJA_INITIATOR_PASSWORD = defineSecret("DARAJA_INITIATOR_PASSWORD");
const CALLBACK_TOKEN = defineSecret("CALLBACK_TOKEN");
const PAY_SECRETS = [DARAJA_KEY, DARAJA_SECRET, DARAJA_PASSKEY, DARAJA_INITIATOR_PASSWORD, CALLBACK_TOKEN];

const MPESA_ENV = defineString("MPESA_ENV", { default: "sandbox" });
const MPESA_SHORTCODE = defineString("MPESA_SHORTCODE", { default: "174379" });
const MPESA_B2C_SHORTCODE = defineString("MPESA_B2C_SHORTCODE", { default: "600996" });
const MPESA_INITIATOR_NAME = defineString("MPESA_INITIATOR_NAME", { default: "testapi" });
const MPESA_TRANSACTION_TYPE = defineString("MPESA_TRANSACTION_TYPE", { default: "CustomerPayBillOnline" });
const ADMIN_EMAILS = defineString("ADMIN_EMAILS", { default: "" });
const COMMISSION_RATE = defineString("COMMISSION_RATE", { default: "0.08" });

function darajaConfig() {
  return {
    env: MPESA_ENV.value(),
    key: DARAJA_KEY.value(),
    secret: DARAJA_SECRET.value(),
    passkey: DARAJA_PASSKEY.value(),
    initiatorPassword: DARAJA_INITIATOR_PASSWORD.value(),
    initiatorName: MPESA_INITIATOR_NAME.value(),
    shortcode: MPESA_SHORTCODE.value(),
    b2cShortcode: MPESA_B2C_SHORTCODE.value(),
    transactionType: MPESA_TRANSACTION_TYPE.value()
  };
}

/* Safaricom rejects callback URLs that contain words like "mpesa", so these names avoid them. */
function callbackUrl(fnName) {
  const project = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
  return "https://" + REGION + "-" + project + ".cloudfunctions.net/" + fnName + "?t=" + encodeURIComponent(CALLBACK_TOKEN.value());
}

/* ---------- small helpers ---------- */
const now = () => FieldValue.serverTimestamp();

/* Compares the secret in a callback URL without leaking timing information. */
function tokenOk(given) {
  const a = Buffer.from(String(given || ""));
  const b = Buffer.from(CALLBACK_TOKEN.value());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function needAuth(req) {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  return req.auth.uid;
}

function isAdminAuth(req) {
  const t = req.auth && req.auth.token;
  if (!t || !t.email || t.email_verified !== true) return false;
  const list = ADMIN_EMAILS.value().split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.indexOf(String(t.email).toLowerCase()) !== -1;
}

function needAdmin(req) {
  needAuth(req);
  if (!isAdminAuth(req)) throw new HttpsError("permission-denied", "Admins only.");
}

async function getProfile(uid, role) {
  const snap = await db.doc("users/" + uid).get();
  if (!snap.exists) throw new HttpsError("failed-precondition", "Finish your profile first.");
  const p = snap.data();
  if (role && p.role !== role) throw new HttpsError("permission-denied", "This action is for " + role + "s.");
  return p;
}

function str(v, max) {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function placeOk(id) {
  return typeof id === "string" && pricing.PLACES[id] && !pricing.PLACES[id].border;
}

function newDeliveryCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

/* ---------- accounts ---------- */
exports.saveProfile = onCall(async (req) => {
  const uid = needAuth(req);
  const d = req.data || {};
  const name = str(d.name, 80);
  const phone = phoneLib.normalizeKenyaPhone(str(d.phone, 20));
  const role = d.role;
  if (name.length < 3) throw new HttpsError("invalid-argument", "Enter your full name as it appears on your ID.");
  if (!phone) throw new HttpsError("invalid-argument", "Enter a Kenyan M-Pesa number, like 0712 345 678.");
  if (role !== "shipper" && role !== "owner") throw new HttpsError("invalid-argument", "Choose shipper or truck owner.");

  const ref = db.doc("users/" + uid);
  const existing = await ref.get();
  // Name, number and role are fixed after sign-up. This stops a hijacked account from redirecting payouts.
  if (existing.exists) throw new HttpsError("already-exists", "Your profile is already saved. Contact support to change it.");
  await ref.set({ name, phone, role, email: (req.auth.token.email || null), createdAt: now() });
  return { ok: true };
});

exports.whoami = onCall(async (req) => {
  needAuth(req);
  return { isAdmin: isAdminAuth(req), commissionRate: Number(COMMISSION_RATE.value()) };
});

/* ---------- trucks ---------- */
exports.registerTruck = onCall(async (req) => {
  const uid = needAuth(req);
  await getProfile(uid, "owner");
  const d = req.data || {};
  const plate = str(d.plate, 14).toUpperCase().replace(/[\s-]/g, "");
  const capacityT = Number(d.capacityT);
  if (!/^[A-Z0-9]{5,10}$/.test(plate)) throw new HttpsError("invalid-argument", "Enter the number plate, like KDA123A.");
  if (!(capacityT >= 0.5 && capacityT <= 40)) throw new HttpsError("invalid-argument", "Capacity must be between 0.5 and 40 tonnes.");

  const docs = {};
  ["id", "logbook", "insurance", "licence"].forEach((k) => {
    const p = d.docs && d.docs[k];
    if (typeof p !== "string" || p.indexOf("truckdocs/" + uid + "/") !== 0 || p.indexOf("..") !== -1) {
      throw new HttpsError("invalid-argument", "Upload all four documents.");
    }
    docs[k] = p;
  });

  const dup = await db.collection("trucks").where("plate", "==", plate).limit(1).get();
  const truckClass = ["pickup", "light", "medium", "heavy"].find((c) => capacityT <= CFG().maxTonnes[c]) || "heavy";
  if (!dup.empty) {
    // The same owner may resubmit a truck that was rejected. Nobody else may take a plate that is registered.
    const old = dup.docs[0];
    if (old.data().ownerId === uid && old.data().status === "rejected") {
      await old.ref.update({ capacityT, truckClass, docs, status: "pending", reviewNote: null, resubmittedAt: now() });
      return { truckId: old.id };
    }
    throw new HttpsError("already-exists", "This number plate is already registered.");
  }

  const ref = await db.collection("trucks").add({
    ownerId: uid, plate, capacityT, truckClass, docs,
    status: "pending", activeLoadId: null,
    rules: { autoAccept: false, routes: [], minPriceKES: 0, maxTonnes: capacityT, cargo: [] },
    createdAt: now()
  });
  return { truckId: ref.id };
});

function CFG() { return globalThis.MZIGO_CONFIG; }

function cleanRules(input, capacityT) {
  const r = input || {};
  const routes = (Array.isArray(r.routes) ? r.routes : []).slice(0, 12).map((x) => ({
    from: x && x.from === "*" ? "*" : (x && placeOk(x.from) ? x.from : null),
    to: x && x.to === "*" ? "*" : (x && placeOk(x.to) ? x.to : null)
  }));
  if (routes.some((x) => !x.from || !x.to)) throw new HttpsError("invalid-argument", "One of the routes has a place we do not know.");
  const cargoKeys = Object.keys(CFG().cargo);
  const cargo = (Array.isArray(r.cargo) ? r.cargo : []).filter((c) => cargoKeys.indexOf(c) !== -1);
  const minPriceKES = Math.round(Number(r.minPriceKES) || 0);
  if (minPriceKES < 0 || minPriceKES > money.MAX_KES) throw new HttpsError("invalid-argument", "Minimum price is out of range.");
  const maxTonnes = Math.min(Number(r.maxTonnes) || capacityT, capacityT);
  return { autoAccept: r.autoAccept === true, routes, minPriceKES, maxTonnes, cargo };
}

exports.setTruckRules = onCall(async (req) => {
  const uid = needAuth(req);
  const truckId = str(req.data && req.data.truckId, 40);
  const ref = db.doc("trucks/" + truckId);
  const snap = await ref.get();
  if (!snap.exists || snap.data().ownerId !== uid) throw new HttpsError("not-found", "Truck not found.");
  const rules = cleanRules(req.data.rules, snap.data().capacityT);
  if (rules.autoAccept && rules.routes.length === 0) throw new HttpsError("invalid-argument", "Add at least one route before turning auto-accept on.");
  await ref.update({ rules });
  let accepted = 0;
  if (rules.autoAccept && snap.data().status === "approved") accepted = await matchOpenLoadsToTruck(truckId);
  return { ok: true, accepted };
});

/* ---------- loads ---------- */
exports.createLoad = onCall(async (req) => {
  const uid = needAuth(req);
  await getProfile(uid, "shipper");
  const d = req.data || {};
  const cargoKeys = Object.keys(CFG().cargo);
  const from = d.from, to = d.to, cargo = d.cargo;
  const tonnes = Number(d.tonnes);
  const priceKES = Number(d.priceKES);
  const receiverName = str(d.receiverName, 80);
  const receiverPhone = phoneLib.normalizeKenyaPhone(str(d.receiverPhone, 20));
  const pickupDate = str(d.pickupDate, 10);

  if (!placeOk(from) || !placeOk(to) || from === to) throw new HttpsError("invalid-argument", "Choose two different places.");
  if (cargoKeys.indexOf(cargo) === -1) throw new HttpsError("invalid-argument", "Choose a cargo type.");
  if (!(tonnes > 0 && tonnes <= 28)) throw new HttpsError("invalid-argument", "Weight must be between 0.1 and 28 tonnes. For more, post separate loads.");
  if (!money.isValidAmount(priceKES)) throw new HttpsError("invalid-argument", "Price must be a whole number between KES " + money.MIN_KES + " and " + money.MAX_KES.toLocaleString("en-US") + ".");
  if (receiverName.length < 3 || !receiverPhone) throw new HttpsError("invalid-argument", "Enter who receives the goods and their phone number.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(pickupDate)) throw new HttpsError("invalid-argument", "Choose a pickup date.");

  const est = pricing.estimate({ from, to, tonnes, cargo, flexible: false });
  if (!est) throw new HttpsError("invalid-argument", "We cannot price this route yet.");
  if (priceKES < est.low * 0.5) throw new HttpsError("invalid-argument", "That price is far below the usual rate for this trip (about KES " + Math.round(est.low).toLocaleString("en-US") + " or more). Raise it so owners will accept.");
  if (priceKES > est.high * 3) throw new HttpsError("invalid-argument", "That price is far above the usual rate. Check the amount.");

  const ref = db.collection("loads").doc();
  const batch = db.batch();
  batch.set(ref, {
    shipperId: uid, from, to, cargo, tonnes, priceKES, pickupDate,
    km: est.km, borders: est.borders,
    status: "open", truckId: null, ownerId: null,
    createdAt: now()
  });
  batch.set(db.doc("loads_private/" + ref.id), {
    shipperId: uid, deliveryCode: newDeliveryCode(), attempts: 0, receiverName, receiverPhone
  });
  await batch.commit();

  const matched = await autoAcceptLoad(ref.id);
  return { loadId: ref.id, autoAccepted: matched };
});

/* Frees the truck and finishes bookkeeping whenever a load ends. */
async function freeTruck(t, truckId, loadId) {
  if (!truckId) return;
  const ref = db.doc("trucks/" + truckId);
  const s = await t.get(ref);
  if (s.exists && s.data().activeLoadId === loadId) t.update(ref, { activeLoadId: null });
}

/* Books a truck on a load in one atomic step so two loads can never share a truck. */
async function assignTruck(loadId, truckId, how) {
  return db.runTransaction(async (t) => {
    const lref = db.doc("loads/" + loadId), tref = db.doc("trucks/" + truckId);
    const [ls, ts] = await Promise.all([t.get(lref), t.get(tref)]);
    if (!ls.exists || !ts.exists) return false;
    const load = ls.data(), truck = ts.data();
    if (!state.canMove(load.status, "accepted")) return false;
    const verdict = how === "auto" ? matching.autoAcceptCheck(truck, load) : matching.check(truck, load);
    if (!verdict.ok) return false;
    t.update(lref, { status: "accepted", truckId, ownerId: truck.ownerId, truckPlate: truck.plate, acceptedBy: how, acceptedAt: now() });
    t.update(tref, { activeLoadId: loadId });
    return true;
  });
}

async function autoAcceptLoad(loadId) {
  const ls = await db.doc("loads/" + loadId).get();
  if (!ls.exists || ls.data().status !== "open") return false;
  const load = ls.data();
  const q = await db.collection("trucks").where("status", "==", "approved").where("rules.autoAccept", "==", true).limit(200).get();
  const trucks = q.docs.map((d) => Object.assign({ id: d.id, approvedAtMs: d.data().approvedAt ? d.data().approvedAt.toMillis() : 0 }, d.data()));
  const ranked = matching.pickBest(trucks, load).slice(0, 5);
  for (const truck of ranked) {
    if (await assignTruck(loadId, truck.id, "auto")) return true;
  }
  return false;
}

async function matchOpenLoadsToTruck(truckId) {
  const q = await db.collection("loads").where("status", "==", "open").limit(100).get();
  let n = 0;
  for (const d of q.docs) {
    const ts = await db.doc("trucks/" + truckId).get();
    const truck = ts.data();
    if (!truck || truck.activeLoadId) break;
    if (matching.autoAcceptCheck(truck, d.data()).ok && await assignTruck(d.id, truckId, "auto")) n++;
  }
  return n;
}

exports.acceptLoad = onCall(async (req) => {
  const uid = needAuth(req);
  await getProfile(uid, "owner");
  const loadId = str(req.data && req.data.loadId, 40), truckId = str(req.data && req.data.truckId, 40);
  const ts = await db.doc("trucks/" + truckId).get();
  if (!ts.exists || ts.data().ownerId !== uid) throw new HttpsError("not-found", "Truck not found.");
  if (!(await assignTruck(loadId, truckId, "manual"))) {
    throw new HttpsError("failed-precondition", "This load cannot be accepted with that truck. It may be taken, too heavy, or your truck is not verified or is busy.");
  }
  return { ok: true };
});

exports.cancelLoad = onCall(async (req) => {
  const uid = needAuth(req);
  const loadId = str(req.data && req.data.loadId, 40);
  await db.runTransaction(async (t) => {
    const ref = db.doc("loads/" + loadId);
    const s = await t.get(ref);
    if (!s.exists || s.data().shipperId !== uid) throw new HttpsError("not-found", "Load not found.");
    const l = s.data();
    if (!state.canMove(l.status, "cancelled")) throw new HttpsError("failed-precondition", "This load can no longer be cancelled. If you have paid, report a problem instead.");
    await freeTruck(t, l.truckId, loadId);
    t.update(ref, { status: "cancelled", cancelledAt: now() });
  });
  return { ok: true };
});

/* ---------- paying (customer to Mzigo Hub, held until delivery) ---------- */
exports.payForLoad = onCall({ secrets: PAY_SECRETS }, async (req) => {
  const uid = needAuth(req);
  const profile = await getProfile(uid, "shipper");
  const loadId = str(req.data && req.data.loadId, 40);
  const payer = phoneLib.normalizeKenyaPhone(str(req.data && req.data.payerPhone, 20)) || profile.phone;

  const paymentRef = db.collection("payments").doc();
  const amount = await db.runTransaction(async (t) => {
    const ref = db.doc("loads/" + loadId);
    const s = await t.get(ref);
    if (!s.exists || s.data().shipperId !== uid) throw new HttpsError("not-found", "Load not found.");
    const l = s.data();
    if (!state.canMove(l.status, "payment_pending")) throw new HttpsError("failed-precondition", "This load is not waiting for payment.");
    t.update(ref, { status: "payment_pending", paymentId: paymentRef.id });
    t.set(paymentRef, { loadId, shipperId: uid, amount: l.priceKES, payerPhone: payer, status: "pending", createdAt: now() });
    return l.priceKES;
  });

  try {
    const r = await daraja.stkPush(darajaConfig(), {
      amount, phone: payer, reference: "MZ" + loadId.slice(0, 8),
      description: "Mzigo load", callbackUrl: callbackUrl("payCallback")
    });
    if (r.ResponseCode !== "0") throw new Error(r.ResponseDescription || "M-Pesa refused the request.");
    await paymentRef.update({ checkoutRequestId: r.CheckoutRequestID, merchantRequestId: r.MerchantRequestID });
  } catch (e) {
    await failPayment(paymentRef.id, "Could not start M-Pesa: " + e.message);
    throw new HttpsError("unavailable", "We could not send the M-Pesa prompt. Try again in a minute.");
  }
  return { ok: true, message: "Check your phone and enter your M-Pesa PIN." };
});

async function failPayment(paymentId, reason) {
  await db.runTransaction(async (t) => {
    const pref = db.doc("payments/" + paymentId);
    const ps = await t.get(pref);
    if (!ps.exists || ps.data().status !== "pending") return;
    const lref = db.doc("loads/" + ps.data().loadId);
    const ls = await t.get(lref);
    t.update(pref, { status: "failed", reason, finishedAt: now() });
    if (ls.exists && state.canMove(ls.data().status, "accepted")) t.update(lref, { status: "accepted", lastPaymentError: reason });
  });
}

async function succeedPayment(paymentId, info) {
  await db.runTransaction(async (t) => {
    const pref = db.doc("payments/" + paymentId);
    const ps = await t.get(pref);
    if (!ps.exists || ps.data().status !== "pending") return; // already handled: safe to receive twice
    const lref = db.doc("loads/" + ps.data().loadId);
    const ls = await t.get(lref);
    if (info.amount !== null && info.amount !== ps.data().amount) {
      // Wrong amount. Hold it for a person to look at instead of marking the load paid.
      t.update(pref, { status: "mismatch", receipt: info.receipt, paidAmount: info.amount, finishedAt: now() });
      return;
    }
    t.update(pref, { status: "success", receipt: info.receipt, paidPhone: info.phone, finishedAt: now() });
    if (ls.exists && state.canMove(ls.data().status, "paid")) t.update(lref, { status: "paid", paidAt: now(), paymentReceipt: info.receipt });
  });
}

/* Safaricom calls this URL after the customer answers the prompt. */
exports.payCallback = onRequest({ secrets: PAY_SECRETS }, async (req, res) => {
  if (req.method !== "POST" || !tokenOk(req.query.t)) { res.status(403).send("no"); return; }
  const cb = daraja.parseStkCallback(req.body);
  res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  if (!cb) return;
  try { await settleByCheckoutId(cb); } catch (e) { console.error("payCallback", e); }
});

async function settleByCheckoutId(cb) {
  const q = await db.collection("payments").where("checkoutRequestId", "==", cb.checkoutRequestId).limit(1).get();
  if (q.empty) return;
  const pay = q.docs[0];
  if (pay.data().status !== "pending") return;
  if (cb.resultCode !== 0) { await failPayment(pay.id, cb.resultDesc || "Payment was not completed."); return; }
  // Do not trust the callback alone. Ask Safaricom directly before marking money received.
  const check = await daraja.stkQuery(darajaConfig(), cb.checkoutRequestId);
  if (check.resultCode !== 0) { await failPayment(pay.id, check.resultDesc || "Safaricom did not confirm the payment."); return; }
  await succeedPayment(pay.id, { amount: cb.amount, receipt: cb.receipt, phone: cb.phone });
}

/* If a callback never arrives, ask Safaricom about payments that have waited more than two minutes. */
exports.reconcilePayments = onSchedule({ schedule: "every 5 minutes", secrets: PAY_SECRETS }, async () => {
  const cutoff = Date.now() - 2 * 60 * 1000;
  const q = await db.collection("payments").where("status", "==", "pending").limit(50).get();
  for (const d of q.docs) {
    const p = d.data();
    if (!p.checkoutRequestId || !p.createdAt || p.createdAt.toMillis() > cutoff) continue;
    try {
      const r = await daraja.stkQuery(darajaConfig(), p.checkoutRequestId);
      if (r.resultCode === 0) await succeedPayment(d.id, { amount: null, receipt: null, phone: p.payerPhone });
      else if (r.resultCode !== null) await failPayment(d.id, r.resultDesc || "Payment was not completed.");
    } catch (e) {
      console.error("reconcile", d.id, e.message); // Safaricom says "still processing" as an error. Try again next round.
    }
    if (Date.now() - p.createdAt.toMillis() > 24 * 3600 * 1000) await failPayment(d.id, "Timed out.");
  }
});

/* ---------- the trip ---------- */
exports.markPickedUp = onCall(async (req) => {
  const uid = needAuth(req);
  const loadId = str(req.data && req.data.loadId, 40);
  await db.runTransaction(async (t) => {
    const ref = db.doc("loads/" + loadId);
    const s = await t.get(ref);
    if (!s.exists || s.data().ownerId !== uid) throw new HttpsError("not-found", "Job not found.");
    if (!state.canMove(s.data().status, "in_transit")) throw new HttpsError("failed-precondition", "Wait until the customer has paid before collecting the load.");
    t.update(ref, { status: "in_transit", pickedUpAt: now() });
  });
  return { ok: true };
});

/* The receiver gives the driver the 6-digit code when the goods arrive. That releases the payout. */
exports.confirmDelivery = onCall({ secrets: PAY_SECRETS }, async (req) => {
  const uid = needAuth(req);
  const loadId = str(req.data && req.data.loadId, 40);
  const code = str(req.data && req.data.code, 10);
  const result = await db.runTransaction(async (t) => {
    const lref = db.doc("loads/" + loadId), pref = db.doc("loads_private/" + loadId);
    const [ls, ps] = await Promise.all([t.get(lref), t.get(pref)]);
    if (!ls.exists || ls.data().ownerId !== uid) throw new HttpsError("not-found", "Job not found.");
    if (ls.data().status !== "in_transit") throw new HttpsError("failed-precondition", "This load is not on the road.");
    const priv = ps.data();
    if (priv.attempts >= 5) throw new HttpsError("resource-exhausted", "Too many wrong codes. This load has been flagged for review.");
    if (code !== priv.deliveryCode) {
      t.update(pref, { attempts: priv.attempts + 1 });
      if (priv.attempts + 1 >= 5) t.update(lref, { status: "disputed", disputeReason: "Five wrong delivery codes.", disputedAt: now() });
      return { ok: false, left: Math.max(0, 5 - priv.attempts - 1) };
    }
    t.update(lref, { status: "payout_pending", deliveredAt: now() });
    return { ok: true };
  });
  if (!result.ok) throw new HttpsError("permission-denied", "That code is wrong. " + result.left + " tries left.");
  await startPayout(loadId);
  return { ok: true };
});

/* ---------- paying the truck owner ---------- */
async function startPayout(loadId) {
  const ref = db.doc("loads/" + loadId);
  const rate = Number(COMMISSION_RATE.value());
  const job = await db.runTransaction(async (t) => {
    const s = await t.get(ref);
    const l = s.data();
    if (!s.exists || l.status !== "payout_pending" || (l.payout && l.payout.originatorId)) return null; // someone else is already paying it
    const parts = money.split(l.priceKES, rate);
    const originatorId = crypto.randomUUID();
    t.update(ref, { payout: { originatorId, amount: parts.payout, fee: parts.fee, state: "sent", startedAt: now() } });
    return { originatorId, amount: parts.payout, ownerId: l.ownerId };
  });
  if (!job) return;
  try {
    const owner = (await db.doc("users/" + job.ownerId).get()).data();
    const r = await daraja.b2c(darajaConfig(), {
      originatorId: job.originatorId, amount: job.amount, phone: owner.phone,
      remarks: "Mzigo Hub payout", occasion: loadId.slice(0, 20),
      resultUrl: callbackUrl("payoutResult"), timeoutUrl: callbackUrl("payoutTimeout")
    });
    if (r.ResponseCode !== "0") throw new Error(r.ResponseDescription || "M-Pesa refused the payout.");
  } catch (e) {
    await ref.update({ status: "payout_failed", "payout.state": "failed", "payout.error": e.message });
  }
}

async function finishPayout(info) {
  const q = await db.collection("loads").where("payout.originatorId", "==", info.originatorId).limit(1).get();
  if (q.empty) return;
  const ref = q.docs[0].ref;
  await db.runTransaction(async (t) => {
    const s = await t.get(ref);
    const l = s.data();
    if (l.status !== "payout_pending") return; // already settled
    if (info.resultCode === 0) {
      await freeTruck(t, l.truckId, ref.id); // reads first, then all writes
      t.update(ref, { status: "completed", completedAt: now(), "payout.state": "paid", "payout.receipt": info.receipt, "payout.receiverName": info.receiverName });
    } else {
      t.update(ref, { status: "payout_failed", "payout.state": "failed", "payout.error": info.resultDesc });
    }
  });
}

exports.payoutResult = onRequest({ secrets: PAY_SECRETS }, async (req, res) => {
  if (req.method !== "POST" || !tokenOk(req.query.t)) { res.status(403).send("no"); return; }
  res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  const info = daraja.parseB2CResult(req.body);
  if (!info) return;
  try { await finishPayout(info); } catch (e) { console.error("payoutResult", e); }
});

/* A timeout does not tell us whether the money moved. A person must check before any retry. */
exports.payoutTimeout = onRequest({ secrets: PAY_SECRETS }, async (req, res) => {
  if (req.method !== "POST" || !tokenOk(req.query.t)) { res.status(403).send("no"); return; }
  res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  const info = daraja.parseB2CResult(req.body);
  if (!info) return;
  const q = await db.collection("loads").where("payout.originatorId", "==", info.originatorId).limit(1).get();
  if (q.empty || q.docs[0].data().status !== "payout_pending") return;
  await q.docs[0].ref.update({ status: "payout_failed", "payout.state": "timeout", "payout.error": "Safaricom timed out. Check the M-Pesa statement before retrying." });
});

/* ---------- disputes and contacts ---------- */
exports.reportProblem = onCall(async (req) => {
  const uid = needAuth(req);
  const loadId = str(req.data && req.data.loadId, 40);
  const reason = str(req.data && req.data.reason, 500);
  if (reason.length < 5) throw new HttpsError("invalid-argument", "Say what went wrong.");
  await db.runTransaction(async (t) => {
    const ref = db.doc("loads/" + loadId);
    const s = await t.get(ref);
    if (!s.exists || (s.data().shipperId !== uid && s.data().ownerId !== uid)) throw new HttpsError("not-found", "Load not found.");
    if (!state.canMove(s.data().status, "disputed")) throw new HttpsError("failed-precondition", "You can report a problem once the load is paid and until it is delivered.");
    t.update(ref, { status: "disputed", disputeReason: reason, disputedBy: uid, disputedAt: now() });
  });
  return { ok: true };
});

/* Phone numbers are shared only after the customer has paid, so nobody can bypass Mzigo Hub before then. */
exports.getJobContacts = onCall(async (req) => {
  const uid = needAuth(req);
  const loadId = str(req.data && req.data.loadId, 40);
  const ls = await db.doc("loads/" + loadId).get();
  if (!ls.exists) throw new HttpsError("not-found", "Load not found.");
  const l = ls.data();
  if (l.shipperId !== uid && l.ownerId !== uid) throw new HttpsError("permission-denied", "Not your load.");
  if (["paid", "in_transit", "payout_pending", "payout_failed", "completed", "disputed"].indexOf(l.status) === -1) {
    throw new HttpsError("failed-precondition", "Contacts appear after payment.");
  }
  const [shipper, owner, priv] = await Promise.all([
    db.doc("users/" + l.shipperId).get(), db.doc("users/" + l.ownerId).get(), db.doc("loads_private/" + loadId).get()
  ]);
  const out = {};
  if (l.ownerId === uid) {
    out.shipper = { name: shipper.data().name, phone: shipper.data().phone };
    out.receiver = { name: priv.data().receiverName, phone: priv.data().receiverPhone };
  } else {
    out.owner = { name: owner.data().name, phone: owner.data().phone, plate: l.truckPlate };
  }
  return out;
});

/* ---------- admin ---------- */
exports.adminOverview = onCall(async (req) => {
  needAdmin(req);
  const [trucks, failed, disputes, done] = await Promise.all([
    db.collection("trucks").where("status", "==", "pending").limit(50).get(),
    db.collection("loads").where("status", "==", "payout_failed").limit(50).get(),
    db.collection("loads").where("status", "==", "disputed").limit(50).get(),
    db.collection("loads").where("status", "==", "completed").limit(20).get()
  ]);
  const ownerIds = new Set();
  trucks.docs.forEach((d) => ownerIds.add(d.data().ownerId));
  done.docs.forEach((d) => ownerIds.add(d.data().ownerId));
  const owners = {};
  await Promise.all(Array.from(ownerIds).map(async (id) => { const u = await db.doc("users/" + id).get(); owners[id] = u.exists ? u.data() : {}; }));

  const slim = (d) => { const o = d.data(); return { id: d.id, from: o.from, to: o.to, priceKES: o.priceKES, status: o.status, payout: o.payout || null, disputeReason: o.disputeReason || null }; };
  const sameName = (a, b) => {
    const tokens = String(a || "").toLowerCase().split(/\s+/).filter((x) => x.length > 2);
    const hay = String(b || "").toLowerCase();
    return tokens.length > 0 && tokens.some((tk) => hay.indexOf(tk) !== -1);
  };
  return {
    pendingTrucks: trucks.docs.map((d) => ({ id: d.id, plate: d.data().plate, capacityT: d.data().capacityT, owner: owners[d.data().ownerId] ? { name: owners[d.data().ownerId].name, phone: owners[d.data().ownerId].phone } : null })),
    failedPayouts: failed.docs.map(slim),
    disputes: disputes.docs.map(slim),
    recentPayouts: done.docs.map((d) => {
      const o = d.data(), owner = owners[o.ownerId] || {};
      return { id: d.id, ownerName: owner.name, receiverName: o.payout && o.payout.receiverName, nameMatches: sameName(owner.name, o.payout && o.payout.receiverName), receipt: o.payout && o.payout.receipt };
    })
  };
});

exports.adminTruckDocs = onCall(async (req) => {
  needAdmin(req);
  const truckId = str(req.data && req.data.truckId, 40);
  const s = await db.doc("trucks/" + truckId).get();
  if (!s.exists) throw new HttpsError("not-found", "Truck not found.");
  const bucket = getStorage().bucket();
  const urls = {};
  for (const [k, p] of Object.entries(s.data().docs || {})) {
    const [url] = await bucket.file(p).getSignedUrl({ action: "read", expires: Date.now() + 15 * 60 * 1000 });
    urls[k] = url;
  }
  return urls;
});

exports.adminReviewTruck = onCall(async (req) => {
  needAdmin(req);
  const truckId = str(req.data && req.data.truckId, 40);
  const approve = req.data && req.data.approve === true;
  const note = str(req.data && req.data.note, 300);
  const ref = db.doc("trucks/" + truckId);
  const s = await ref.get();
  if (!s.exists) throw new HttpsError("not-found", "Truck not found.");
  if (!approve && note.length < 3) throw new HttpsError("invalid-argument", "Say why the truck was rejected.");
  await ref.update(approve
    ? { status: "approved", approvedAt: now(), reviewNote: note || null }
    : { status: "rejected", reviewNote: note });
  let accepted = 0;
  if (approve && s.data().rules && s.data().rules.autoAccept) accepted = await matchOpenLoadsToTruck(truckId);
  return { ok: true, accepted };
});

exports.adminRetryPayout = onCall({ secrets: PAY_SECRETS }, async (req) => {
  needAdmin(req);
  const loadId = str(req.data && req.data.loadId, 40);
  if (req.data.confirmedNotPaid !== true) throw new HttpsError("failed-precondition", "Confirm you checked the M-Pesa statement and the owner was not paid.");
  const ref = db.doc("loads/" + loadId);
  await db.runTransaction(async (t) => {
    const s = await t.get(ref);
    if (!s.exists || !state.canMove(s.data().status, "payout_pending") || s.data().status !== "payout_failed") throw new HttpsError("failed-precondition", "This load has no failed payout.");
    t.update(ref, { status: "payout_pending", payout: FieldValue.delete() });
  });
  await startPayout(loadId);
  return { ok: true };
});

exports.adminResolveDispute = onCall({ secrets: PAY_SECRETS }, async (req) => {
  needAdmin(req);
  const loadId = str(req.data && req.data.loadId, 40);
  const action = req.data && req.data.action;
  const note = str(req.data && req.data.note, 300);
  if (action !== "pay_owner" && action !== "refund") throw new HttpsError("invalid-argument", "Choose pay owner or refund.");
  if (note.length < 3) throw new HttpsError("invalid-argument", "Write a short note for the record.");
  const ref = db.doc("loads/" + loadId);
  await db.runTransaction(async (t) => {
    const s = await t.get(ref);
    if (!s.exists || s.data().status !== "disputed") throw new HttpsError("failed-precondition", "This load is not in dispute.");
    if (action === "pay_owner") {
      t.update(ref, { status: "payout_pending", resolution: { action, note, at: now() } });
    } else {
      await freeTruck(t, s.data().truckId, loadId); // reads first, then all writes
      t.update(ref, { status: "refunded", resolution: { action, note, at: now() } });
    }
  });
  if (action === "pay_owner") await startPayout(loadId);
  return { ok: true, note: action === "refund" ? "Now send the customer's money back from your M-Pesa portal, then record the reference in your own records." : "Payout started." };
});
