/* Mzigo Hub app: sign in, post loads, manage trucks, review. All changes go through the backend. */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithPopup, GoogleAuthProvider,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, sendEmailVerification,
  sendPasswordResetEmail, signOut
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore, collection, query, where, onSnapshot, doc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getStorage, ref as storageRef, uploadBytes } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";

const FB = window.MZIGO_FIREBASE || {};
const P = window.MzigoPricing;
const CFG = window.MZIGO_CONFIG;
const root = document.getElementById("app");

/* ---------- tiny DOM helpers (text only, never raw HTML) ---------- */
function h(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  Object.entries(attrs || {}).forEach(([k, v]) => {
    if (v === false || v === null || v === undefined) return;
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k === "value") n.value = v;
    else n.setAttribute(k, v === true ? "" : v);
  });
  kids.flat().forEach((c) => { if (c !== null && c !== undefined && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c))); });
  return n;
}
const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild); };
const kes = (n) => "KES " + Math.round(n).toLocaleString("en-US");
const place = (id) => (P.PLACES[id] ? P.PLACES[id].name : id);
const cargoLabel = (k) => (CFG.cargo[k] ? CFG.cargo[k].label : k);
let uid = 0;
const nextId = () => "f" + (++uid);

function field(label, input, hint) {
  const id = nextId();
  input.id = id;
  return h("div", { class: "field" }, h("label", { for: id }, label), input, hint ? h("p", { class: "fineprint" }, hint) : null);
}
function select(options, value) {
  const s = h("select", {});
  options.forEach((o) => s.append(h("option", { value: o[0] }, o[1])));
  if (value !== undefined) s.value = value;
  return s;
}
function placeOptions(includeAny) {
  const groups = { KE: "Kenya", UG: "Uganda", RW: "Rwanda", TZ: "Tanzania" };
  const s = h("select", {});
  if (includeAny) s.append(h("option", { value: "*" }, "Anywhere"));
  Object.keys(groups).forEach((c) => {
    const og = h("optgroup", { label: groups[c] });
    Object.keys(P.PLACES).filter((id) => !P.PLACES[id].border && P.PLACES[id].country === c).forEach((id) => og.append(h("option", { value: id }, P.PLACES[id].name)));
    if (og.children.length) s.append(og);
  });
  return s;
}

let toastTimer;
function toast(msg, bad) {
  document.querySelectorAll(".toast").forEach((t) => t.remove());
  const t = h("div", { class: "toast" + (bad ? " toast--bad" : ""), role: "status" }, msg);
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), bad ? 7000 : 4500);
}

/* ---------- not set up yet ---------- */
const configured = !!(FB.enabled && FB.config && FB.config.apiKey);
if (!configured) {
  clear(root);
  root.append(
    h("h1", {}, "The Mzigo Hub app is not switched on yet"),
    h("p", { class: "lead" }, "The website is live, but accounts and payments need the Firebase backend. Follow BACKEND-SETUP.md in the project, then fill in js/firebase-config.js."),
    h("p", {}, h("a", { class: "btn", href: "index.html" }, "Back to the home page"))
  );
}

function start() {
const app = initializeApp(FB.config);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);
const functions = getFunctions(app, FB.region || "europe-west1");
const call = (name, data) => httpsCallable(functions, name)(data || {}).then((r) => r.data);

/* ---------- state ---------- */
let subs = [];
const stopAll = () => { subs.forEach((u) => u()); subs = []; };
let me = { user: null, profile: undefined, isAdmin: false, rate: 0.08, tab: null };
let profileUnsub = null;

const AUTH_ERRORS = {
  "auth/invalid-credential": "The email or password is wrong.",
  "auth/wrong-password": "The email or password is wrong.",
  "auth/user-not-found": "The email or password is wrong.",
  "auth/email-already-in-use": "An account with this email already exists. Sign in instead.",
  "auth/weak-password": "Use a password with at least 6 characters.",
  "auth/invalid-email": "Enter a valid email address.",
  "auth/popup-closed-by-user": "Sign-in was closed before it finished.",
  "auth/popup-blocked": "Your browser blocked the sign-in window. Allow pop-ups and try again.",
  "auth/unauthorized-domain": "This website address is not allowed to sign in yet. Add it under Firebase Authentication > Settings > Authorized domains.",
  "auth/too-many-requests": "Too many tries. Wait a few minutes and try again."
};
const niceError = (e) => AUTH_ERRORS[e.code] || (e.message && e.message !== "internal" ? e.message.replace(/^Firebase: /, "") : "Something went wrong. Try again.");

/* Runs an action with the button disabled so a double tap cannot send money twice. */
async function act(btn, fn, okMsg) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Please wait...";
  try {
    const r = await fn();
    if (okMsg) toast(typeof okMsg === "function" ? okMsg(r) : okMsg);
    return r;
  } catch (e) {
    toast(niceError(e), true);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

/* ---------- sign in ---------- */
function authView() {
  stopAll();
  clear(root);
  let creating = false;
  const email = h("input", { type: "email", autocomplete: "email", required: true });
  const pass = h("input", { type: "password", autocomplete: "current-password", required: true, minlength: "6" });
  const title = h("h2", {}, "Sign in");
  const submit = h("button", { class: "btn btn--primary btn--block", type: "submit" }, "Sign in");
  const toggle = h("button", { class: "link-btn", type: "button" }, "New here? Create an account");
  const status = h("p", { class: "form-status", role: "status" });

  toggle.addEventListener("click", () => {
    creating = !creating;
    title.textContent = creating ? "Create an account" : "Sign in";
    submit.textContent = creating ? "Create account" : "Sign in";
    toggle.textContent = creating ? "Have an account? Sign in" : "New here? Create an account";
    pass.autocomplete = creating ? "new-password" : "current-password";
    status.textContent = "";
  });

  const form = h("form", { novalidate: true, onsubmit: async (ev) => {
    ev.preventDefault();
    status.textContent = ""; status.className = "form-status";
    try {
      if (creating) {
        const cred = await createUserWithEmailAndPassword(auth, email.value.trim(), pass.value);
        sendEmailVerification(cred.user).catch(() => {});
      } else {
        await signInWithEmailAndPassword(auth, email.value.trim(), pass.value);
      }
    } catch (e) { status.textContent = niceError(e); status.className = "form-status is-error"; }
  } },
    title,
    field("Email", email),
    field("Password", pass),
    submit, status,
    h("p", {}, toggle, " ", h("button", { class: "link-btn", type: "button", onclick: async () => {
      if (!email.value.trim()) { status.textContent = "Type your email above first."; status.className = "form-status is-error"; return; }
      try { await sendPasswordResetEmail(auth, email.value.trim()); status.textContent = "Check your email for a reset link."; status.className = "form-status is-ok"; }
      catch (e) { status.textContent = niceError(e); status.className = "form-status is-error"; }
    } }, "Forgot password?"))
  );

  root.append(
    h("h1", {}, "Move your load, or find one"),
    h("p", { class: "lead" }, "Sign in to post loads, list your trucks and track payments."),
    h("div", { class: "panel panel--narrow" },
      h("button", { class: "btn btn--block", type: "button", onclick: async (ev) => {
        try { await signInWithPopup(auth, new GoogleAuthProvider()); } catch (e) { toast(niceError(e), true); }
      } }, "Continue with Google"),
      h("hr", { class: "divider" }),
      form
    )
  );
}

/* ---------- profile ---------- */
function profileView() {
  stopAll();
  clear(root);
  const name = h("input", { type: "text", autocomplete: "name", required: true, value: (me.user.displayName || "") });
  const phone = h("input", { type: "tel", inputmode: "tel", autocomplete: "tel", placeholder: "0712 345 678", required: true });
  const role = h("fieldset", { class: "seg" }, h("legend", {}, "I want to"),
    h("div", { class: "seg-options" },
      h("label", {}, h("input", { type: "radio", name: "r", value: "shipper", checked: true }), h("span", {}, "Move cargo")),
      h("label", {}, h("input", { type: "radio", name: "r", value: "owner" }), h("span", {}, "Carry cargo"))));
  const btn = h("button", { class: "btn btn--primary btn--block", type: "submit" }, "Save and continue");
  root.append(
    h("h1", {}, "Set up your account"),
    h("p", { class: "lead" }, "Use your real name and your own M-Pesa number. Payments come from and go to this number, and you cannot change it later without contacting support."),
    h("form", { class: "panel panel--narrow", novalidate: true, onsubmit: (ev) => {
      ev.preventDefault();
      const chosen = root.querySelector('input[name="r"]:checked').value;
      act(btn, () => call("saveProfile", { name: name.value, phone: phone.value, role: chosen }), "Account saved.");
    } },
      field("Full name (as on your ID)", name),
      field("M-Pesa phone number", phone),
      role, btn)
  );
}

/* ---------- main shell ---------- */
const STATUS_TEXT = {
  open: ["Looking for a truck", "wait"], accepted: ["Truck found, waiting for payment", "wait"],
  payment_pending: ["Waiting for M-Pesa PIN", "wait"], paid: ["Paid, held safely", ""], in_transit: ["On the road", ""],
  payout_pending: ["Delivered, paying owner", ""], payout_failed: ["Delivered, payout being fixed", "bad"],
  completed: ["Complete", ""], disputed: ["Under review", "bad"], cancelled: ["Cancelled", "bad"], refunded: ["Refunded", ""]
};
const badge = (s) => { const t = STATUS_TEXT[s] || [s, ""]; return h("span", { class: "badge" + (t[1] ? " badge--" + t[1] : "") }, t[0]); };

function mainView() {
  stopAll();
  clear(root);
  const p = me.profile;
  const tabs = p.role === "shipper"
    ? [["post", "Post a load"], ["loads", "My loads"]]
    : [["trucks", "My trucks"], ["board", "Load board"], ["jobs", "My jobs"]];
  if (me.isAdmin) tabs.push(["admin", "Admin"]);
  if (!me.tab || !tabs.some((t) => t[0] === me.tab)) me.tab = tabs[0][0];

  const body = h("div", {});
  const bar = h("div", { class: "tabs", role: "tablist" });
  tabs.forEach(([key, label]) => bar.append(h("button", {
    class: "tab", type: "button", role: "tab", "aria-selected": String(me.tab === key),
    onclick: () => { me.tab = key; mainView(); }
  }, label)));

  root.append(h("h1", {}, "Hello, " + p.name.split(" ")[0]), bar, body);
  const views = { post: postView, loads: shipperLoadsView, trucks: trucksView, board: boardView, jobs: jobsView, admin: adminView };
  views[me.tab](body);
}

/* ---------- shipper: post a load ---------- */
function postView(box) {
  const from = placeOptions(false), to = placeOptions(false);
  from.value = "mombasa"; to.value = "nairobi";
  const cargo = select(Object.keys(CFG.cargo).map((k) => [k, CFG.cargo[k].label]));
  const tonnes = h("input", { type: "number", min: "0.1", max: "28", step: "0.5", value: "12", inputmode: "decimal" });
  const date = h("input", { type: "date", min: new Date().toLocaleDateString("en-CA"), required: true });
  const price = h("input", { type: "number", min: "100", max: "250000", step: "100", inputmode: "numeric" });
  const rName = h("input", { type: "text", placeholder: "Person who will receive the goods", required: true });
  const rPhone = h("input", { type: "tel", inputmode: "tel", placeholder: "0712 345 678", required: true });
  const hint = h("p", { class: "fineprint" });
  let priceTouched = false;

  const recompute = () => {
    const e = P.estimate({ from: from.value, to: to.value, tonnes: Number(tonnes.value), cargo: cargo.value });
    if (!e) { hint.textContent = "Choose two different places."; return; }
    const mid = Math.round(e.mid / 500) * 500;
    hint.textContent = "Usual price for this trip: " + kes(e.low) + " to " + kes(e.high) + ". Payments are in Kenyan shillings, up to KES 250,000 per load.";
    if (!priceTouched) price.value = String(mid);
  };
  [from, to, cargo, tonnes].forEach((i) => { i.addEventListener("input", recompute); i.addEventListener("change", recompute); });
  price.addEventListener("input", () => { priceTouched = true; });
  recompute();

  const btn = h("button", { class: "btn btn--primary btn--block", type: "submit" }, "Post load");
  box.append(h("form", { class: "panel", novalidate: true, onsubmit: (ev) => {
    ev.preventDefault();
    act(btn, () => call("createLoad", {
      from: from.value, to: to.value, cargo: cargo.value, tonnes: Number(tonnes.value), priceKES: Number(price.value),
      pickupDate: date.value, receiverName: rName.value, receiverPhone: rPhone.value
    }), (r) => (r.autoAccepted ? "A verified truck accepted your load. Pay to confirm it." : "Load posted. Truck owners can see it now.")).then((r) => { if (r) { me.tab = "loads"; mainView(); } });
  } },
    h("h2", {}, "Post a load"),
    h("div", { class: "panel-grid" },
      field("From", from), field("To", to),
      field("What are you moving?", cargo), field("Weight in tonnes", tonnes),
      field("Pickup date", date), field("Your price in KES", price, null),
      h("div", { class: "full" }, hint),
      field("Receiver's name", rName), field("Receiver's phone", rPhone)),
    h("p", { class: "legal" }, "You pay after a truck accepts. Mzigo Hub holds the money until the receiver gives the driver a 6-digit code at delivery."),
    btn));
}

/* ---------- shipper: my loads ---------- */
function shipperLoadsView(box) {
  const list = h("ul", { class: "cards" });
  box.append(h("h2", {}, "My loads"), list);
  let loads = [], codes = {};
  const draw = () => {
    clear(list);
    if (!loads.length) { list.append(h("li", { class: "empty" }, "No loads yet. Post your first one from the Post a load tab.")); return; }
    loads.slice().sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0)).forEach((l) => list.append(shipperCard(l, codes[l.id])));
  };
  subs.push(onSnapshot(query(collection(db, "loads"), where("shipperId", "==", me.user.uid)), (s) => { loads = s.docs.map((d) => ({ id: d.id, ...d.data() })); draw(); }, (e) => toast(niceError(e), true)));
  subs.push(onSnapshot(query(collection(db, "loads_private"), where("shipperId", "==", me.user.uid)), (s) => { codes = {}; s.docs.forEach((d) => { codes[d.id] = d.data().deliveryCode; }); draw(); }));
}

function contactsButton(l, label) {
  const out = h("div", { class: "card-note" });
  const btn = h("button", { class: "btn btn--small", type: "button", onclick: () => act(btn, async () => {
    const c = await call("getJobContacts", { loadId: l.id });
    clear(out);
    [["owner", "Driver"], ["shipper", "Customer"], ["receiver", "Receiver"]].forEach(([k, t]) => { if (c[k]) out.append(h("div", {}, t + ": " + c[k].name + ", " + c[k].phone + (c[k].plate ? ", truck " + c[k].plate : ""))); });
  }) }, label);
  return [btn, out];
}

function problemButton(l) {
  const btn = h("button", { class: "btn btn--small", type: "button", onclick: () => {
    const reason = window.prompt("What went wrong? Mzigo Hub will hold the payment while we look into it.");
    if (reason) act(btn, () => call("reportProblem", { loadId: l.id, reason }), "Reported. We will contact you.");
  } }, "Report a problem");
  return btn;
}

function shipperCard(l, code) {
  const actions = h("div", { class: "card-actions" });
  const note = h("div", {});
  if (l.status === "open") {
    note.append(h("p", { class: "card-note" }, "Waiting for a verified truck owner on this route to accept."));
  }
  if (l.status === "accepted") {
    const payer = h("input", { type: "tel", inputmode: "tel", value: me.profile.phone.replace(/^254/, "0") });
    const pay = h("button", { class: "btn btn--primary", type: "button", onclick: () => act(pay, () => call("payForLoad", { loadId: l.id, payerPhone: payer.value }), (r) => r.message) }, "Pay " + kes(l.priceKES) + " with M-Pesa");
    note.append(h("p", { class: "card-note" }, "Truck " + (l.truckPlate || "") + " accepted your load" + (l.acceptedBy === "auto" ? " automatically" : "") + ". Pay to confirm."));
    if (l.lastPaymentError) note.append(h("p", { class: "card-note" }, "Last attempt: " + l.lastPaymentError));
    actions.append(field("M-Pesa number to charge", payer), pay);
  }
  if (l.status === "payment_pending") note.append(h("p", { class: "card-note" }, "Enter your M-Pesa PIN on your phone. This page updates when the payment arrives."));
  if (l.status === "paid" || l.status === "in_transit") {
    note.append(h("p", { class: "card-note" }, "Your money is held by Mzigo Hub. Give this code to the receiver. They tell it to the driver only when the goods arrive."));
    note.append(h("div", { class: "code-box", "aria-label": "Delivery code" }, code || "..."));
    actions.append(...contactsButton(l, "Driver details"), problemButton(l));
  }
  if (["payout_pending", "payout_failed", "completed"].includes(l.status)) note.append(h("p", { class: "card-note" }, "Delivered. Thank you for using Mzigo Hub."));
  if (l.status === "disputed") note.append(h("p", { class: "card-note" }, "We are reviewing this load and holding the payment. We will contact you."));
  if (l.status === "open" || l.status === "accepted") {
    const cancel = h("button", { class: "btn btn--small", type: "button", onclick: () => { if (window.confirm("Cancel this load?")) act(cancel, () => call("cancelLoad", { loadId: l.id }), "Load cancelled."); } }, "Cancel load");
    actions.append(cancel);
  }
  return h("li", { class: "card" },
    h("div", { class: "card-top" }, h("span", { class: "card-title" }, place(l.from) + " to " + place(l.to)), badge(l.status)),
    h("p", { class: "card-sub" }, cargoLabel(l.cargo) + ", " + l.tonnes + " t, pickup " + l.pickupDate + ", " + kes(l.priceKES)),
    note, actions);
}

/* ---------- owner: trucks ---------- */
let myTrucks = [];
function trucksView(box) {
  const list = h("ul", { class: "cards" });
  box.append(addTruckPanel(), h("h2", {}, "My trucks"), list);
  const draw = () => {
    clear(list);
    if (!myTrucks.length) { list.append(h("li", { class: "empty" }, "No trucks yet. Add one above. We check your documents before it can carry loads.")); return; }
    myTrucks.forEach((t) => list.append(truckCard(t)));
  };
  subs.push(onSnapshot(query(collection(db, "trucks"), where("ownerId", "==", me.user.uid)), (s) => { myTrucks = s.docs.map((d) => ({ id: d.id, ...d.data() })); draw(); }, (e) => toast(niceError(e), true)));
}

function addTruckPanel() {
  const plate = h("input", { type: "text", placeholder: "KDA 123A", required: true, autocapitalize: "characters" });
  const cap = h("input", { type: "number", min: "0.5", max: "40", step: "0.5", value: "28", inputmode: "decimal" });
  const files = {
    id: h("input", { type: "file", accept: "image/*,application/pdf", required: true }),
    logbook: h("input", { type: "file", accept: "image/*,application/pdf", required: true }),
    insurance: h("input", { type: "file", accept: "image/*,application/pdf", required: true }),
    licence: h("input", { type: "file", accept: "image/*,application/pdf", required: true })
  };
  const btn = h("button", { class: "btn btn--primary btn--block", type: "submit" }, "Submit truck for checking");
  return h("details", { class: "panel" }, h("summary", {}, h("strong", {}, "Add a truck")),
    h("form", { novalidate: true, onsubmit: (ev) => {
      ev.preventDefault();
      act(btn, async () => {
        const docs = {};
        for (const [k, input] of Object.entries(files)) {
          const f = input.files[0];
          if (!f) throw new Error("Choose all four documents.");
          if (f.size > 5 * 1024 * 1024) throw new Error(f.name + " is bigger than 5 MB.");
          if (!/^image\/|^application\/pdf$/.test(f.type)) throw new Error(f.name + " must be a photo or a PDF.");
          const path = "truckdocs/" + me.user.uid + "/" + Date.now() + "-" + k + "-" + f.name.replace(/[^\w.\-]/g, "_");
          await uploadBytes(storageRef(storage, path), f, { contentType: f.type });
          docs[k] = path;
        }
        return call("registerTruck", { plate: plate.value, capacityT: Number(cap.value), docs });
      }, "Truck submitted. We will check your documents.");
    } },
      h("div", { class: "panel-grid" },
        field("Number plate", plate), field("Capacity in tonnes", cap),
        field("Owner's ID or passport", files.id), field("Vehicle logbook", files.logbook),
        field("Valid insurance", files.insurance), field("Driver's licence", files.licence)),
      h("p", { class: "legal" }, "Photos or PDFs, up to 5 MB each. Only Mzigo Hub staff see them. The name on these documents should match the name on your account and your M-Pesa number."),
      btn));
}

function truckCard(t) {
  const states = { pending: ["Being checked", "wait"], approved: ["Verified", ""], rejected: ["Not approved", "bad"] };
  const s = states[t.status] || [t.status, ""];
  return h("li", { class: "card" },
    h("div", { class: "card-top" }, h("span", { class: "card-title" }, t.plate + ", " + t.capacityT + " t"), h("span", { class: "badge" + (s[1] ? " badge--" + s[1] : "") }, s[0])),
    t.status === "rejected" ? h("p", { class: "card-note" }, "Reason: " + (t.reviewNote || "not given") + ". Fix this and register the truck again.") : null,
    t.activeLoadId ? h("p", { class: "card-sub" }, "On a job right now.") : null,
    rulesForm(t));
}

function rulesForm(t) {
  const r = t.rules || { autoAccept: false, routes: [], minPriceKES: 0, maxTonnes: t.capacityT, cargo: [] };
  const auto = h("input", { type: "checkbox", checked: r.autoAccept });
  const routesBox = h("div", {});
  const routes = (r.routes && r.routes.length ? r.routes : []).map((x) => ({ ...x }));
  const drawRoutes = () => {
    clear(routesBox);
    routes.forEach((rt, i) => {
      const a = placeOptions(true), b = placeOptions(true);
      a.value = rt.from; b.value = rt.to;
      a.setAttribute("aria-label", "From"); b.setAttribute("aria-label", "To");
      a.addEventListener("change", () => { rt.from = a.value; }); b.addEventListener("change", () => { rt.to = b.value; });
      routesBox.append(h("div", { class: "route-row" }, a, b, h("button", { class: "btn btn--small", type: "button", onclick: () => { routes.splice(i, 1); drawRoutes(); } }, "Remove")));
    });
  };
  drawRoutes();
  const minP = h("input", { type: "number", min: "0", max: "250000", step: "500", value: String(r.minPriceKES || 0), inputmode: "numeric" });
  const maxT = h("input", { type: "number", min: "0.5", max: String(t.capacityT), step: "0.5", value: String(r.maxTonnes || t.capacityT), inputmode: "decimal" });
  const cargoSet = h("fieldset", { class: "check-grid" }, h("legend", {}, "Cargo I accept (tick none for all types)"));
  Object.keys(CFG.cargo).forEach((k) => cargoSet.append(h("label", {}, h("input", { type: "checkbox", value: k, checked: (r.cargo || []).includes(k) }), CFG.cargo[k].label)));
  const save = h("button", { class: "btn btn--primary", type: "submit" }, "Save rules");
  return h("details", { class: "card-note" }, h("summary", {}, h("strong", {}, "Auto-accept rules" + (r.autoAccept ? " (on)" : " (off)"))),
    h("form", { novalidate: true, onsubmit: (ev) => {
      ev.preventDefault();
      act(save, () => call("setTruckRules", { truckId: t.id, rules: {
        autoAccept: auto.checked, routes, minPriceKES: Number(minP.value), maxTonnes: Number(maxT.value),
        cargo: Array.from(cargoSet.querySelectorAll("input:checked")).map((i) => i.value)
      } }), (res) => (res.accepted ? "Saved. " + res.accepted + " waiting load(s) accepted for you." : "Rules saved."));
    } },
      h("p", { class: "card-sub" }, "When a load fits every rule, it is accepted for this truck without you doing anything. The customer then pays, and you are told to go."),
      h("div", { class: "check-grid" }, h("label", {}, auto, "Accept matching loads automatically")),
      h("p", {}, h("strong", {}, "Routes")),
      routesBox,
      h("button", { class: "btn btn--small", type: "button", onclick: () => { routes.push({ from: "*", to: "*" }); drawRoutes(); } }, "Add a route"),
      h("hr", { class: "divider" }),
      h("div", { class: "panel-grid" }, field("Lowest price I accept (KES)", minP), field("Heaviest load I accept (tonnes)", maxT)),
      cargoSet,
      t.status !== "approved" ? h("p", { class: "legal" }, "Auto-accept starts working once this truck is verified.") : null,
      save));
}

/* ---------- owner: load board ---------- */
function boardView(box) {
  const list = h("ul", { class: "cards" });
  box.append(h("h2", {}, "Load board"), h("p", { class: "muted" }, "Open loads that no truck has taken yet. Loads that match your auto-accept rules are taken for you."), list);
  let trucks = [], loads = [];
  const draw = () => {
    clear(list);
    const mine = trucks.filter((t) => t.status === "approved" && !t.activeLoadId);
    const open = loads.filter((l) => l.shipperId !== me.user.uid).sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
    if (!open.length) { list.append(h("li", { class: "empty" }, "No open loads right now.")); return; }
    open.forEach((l) => list.append(boardCard(l, mine)));
  };
  subs.push(onSnapshot(query(collection(db, "trucks"), where("ownerId", "==", me.user.uid)), (s) => { trucks = s.docs.map((d) => ({ id: d.id, ...d.data() })); myTrucks = trucks; draw(); }));
  subs.push(onSnapshot(query(collection(db, "loads"), where("status", "==", "open")), (s) => { loads = s.docs.map((d) => ({ id: d.id, ...d.data() })); draw(); }, (e) => toast(niceError(e), true)));
}

function youGet(l) { return kes(l.priceKES * (1 - me.rate)); }

function boardCard(l, freeTrucks) {
  const fits = freeTrucks.filter((t) => t.capacityT >= l.tonnes);
  const actions = h("div", { class: "card-actions" });
  if (!fits.length) {
    actions.append(h("span", { class: "muted" }, freeTrucks.length ? "None of your free trucks can carry " + l.tonnes + " t." : "You need a verified, free truck to accept loads."));
  } else {
    const pick = select(fits.map((t) => [t.id, t.plate + " (" + t.capacityT + " t)"]));
    const go = h("button", { class: "btn btn--primary", type: "button", onclick: () => act(go, () => call("acceptLoad", { loadId: l.id, truckId: pick.value }), "Accepted. The customer will be asked to pay. Wait for payment before loading.") }, "Accept this load");
    actions.append(field("Truck", pick), go);
  }
  return h("li", { class: "card" },
    h("div", { class: "card-top" }, h("span", { class: "card-title" }, place(l.from) + " to " + place(l.to)), h("span", { class: "card-price" }, kes(l.priceKES))),
    h("p", { class: "card-sub" }, cargoLabel(l.cargo) + ", " + l.tonnes + " t, " + l.km.toLocaleString("en-US") + " km" + (l.borders ? ", crosses " + l.borders + " border" + (l.borders > 1 ? "s" : "") : "") + ", pickup " + l.pickupDate),
    h("p", { class: "card-sub" }, "You would receive about " + youGet(l) + " after Mzigo Hub's fee."),
    actions);
}

/* ---------- owner: jobs ---------- */
function jobsView(box) {
  const list = h("ul", { class: "cards" });
  box.append(h("h2", {}, "My jobs"), list);
  let jobs = [];
  const draw = () => {
    clear(list);
    if (!jobs.length) { list.append(h("li", { class: "empty" }, "No jobs yet. Accepted loads appear here.")); return; }
    jobs.slice().sort((a, b) => (b.acceptedAt?.seconds || 0) - (a.acceptedAt?.seconds || 0)).forEach((l) => list.append(jobCard(l)));
  };
  subs.push(onSnapshot(query(collection(db, "loads"), where("ownerId", "==", me.user.uid)), (s) => { jobs = s.docs.map((d) => ({ id: d.id, ...d.data() })); draw(); }, (e) => toast(niceError(e), true)));
}

function jobCard(l) {
  const note = h("div", {}), actions = h("div", { class: "card-actions" });
  if (l.status === "accepted" || l.status === "payment_pending") {
    note.append(h("p", { class: "card-note" }, "Waiting for the customer to pay. Do not load the truck until this changes to Paid."));
  }
  if (l.status === "paid") {
    note.append(h("p", { class: "card-note" }, "The customer has paid and Mzigo Hub is holding the money. Go and collect the load."));
    const pick = h("button", { class: "btn btn--primary", type: "button", onclick: () => act(pick, () => call("markPickedUp", { loadId: l.id }), "Marked as collected. Drive safely.") }, "I have collected the load");
    actions.append(pick, ...contactsButton(l, "Customer and receiver details"), problemButton(l));
  }
  if (l.status === "in_transit") {
    note.append(h("p", { class: "card-note" }, "When the goods arrive, ask the receiver for the 6-digit code. Enter it here to get paid."));
    const code = h("input", { type: "text", inputmode: "numeric", maxlength: "6", autocomplete: "one-time-code", placeholder: "6-digit code" });
    const ok = h("button", { class: "btn btn--primary", type: "button", onclick: () => act(ok, () => call("confirmDelivery", { loadId: l.id, code: code.value.trim() }), "Delivery confirmed. Your payout is on its way.") }, "Confirm delivery");
    actions.append(field("Delivery code", code), ok, ...contactsButton(l, "Customer and receiver details"), problemButton(l));
  }
  if (l.status === "payout_pending") note.append(h("p", { class: "card-note" }, "Delivered. Your M-Pesa payout is being sent" + (l.payout ? ": " + kes(l.payout.amount) + "." : ".")));
  if (l.status === "payout_failed") note.append(h("p", { class: "card-note" }, "Delivered. The payout hit a problem and Mzigo Hub is fixing it. You will still be paid."));
  if (l.status === "completed" && l.payout) note.append(h("p", { class: "card-note" }, "Paid " + kes(l.payout.amount) + " to your M-Pesa (fee " + kes(l.payout.fee) + "). Receipt " + (l.payout.receipt || "") + "."));
  if (l.status === "disputed") note.append(h("p", { class: "card-note" }, "Under review. Mzigo Hub is holding the payment and will contact you."));
  return h("li", { class: "card" },
    h("div", { class: "card-top" }, h("span", { class: "card-title" }, place(l.from) + " to " + place(l.to)), badge(l.status)),
    h("p", { class: "card-sub" }, cargoLabel(l.cargo) + ", " + l.tonnes + " t, truck " + (l.truckPlate || "") + ", " + kes(l.priceKES) + (l.acceptedBy === "auto" ? ", accepted automatically" : "")),
    note, actions);
}

/* ---------- admin ---------- */
async function adminView(box) {
  const out = h("div", {});
  box.append(h("h2", {}, "Admin"), out);
  const refresh = async () => {
    let o;
    try { o = await call("adminOverview"); } catch (e) { toast(niceError(e), true); return; }
    clear(out);
    out.append(h("p", {}, h("button", { class: "btn btn--small", type: "button", onclick: refresh }, "Refresh")));

    out.append(h("h3", {}, "Trucks to check (" + o.pendingTrucks.length + ")"));
    if (!o.pendingTrucks.length) out.append(h("p", { class: "empty" }, "Nothing waiting."));
    o.pendingTrucks.forEach((t) => {
      const links = h("div", { class: "card-note" });
      const note = h("input", { type: "text", placeholder: "Note (required to reject)" });
      const view = h("button", { class: "btn btn--small", type: "button", onclick: () => act(view, async () => {
        const urls = await call("adminTruckDocs", { truckId: t.id });
        clear(links);
        Object.entries(urls).forEach(([k, u]) => links.append(h("a", { href: u, target: "_blank", rel: "noopener noreferrer", class: "btn btn--small" }, k), " "));
      }) }, "View documents");
      const yes = h("button", { class: "btn btn--primary btn--small", type: "button", onclick: () => act(yes, () => call("adminReviewTruck", { truckId: t.id, approve: true, note: note.value }), "Approved.").then(refresh) }, "Approve");
      const no = h("button", { class: "btn btn--small", type: "button", onclick: () => act(no, () => call("adminReviewTruck", { truckId: t.id, approve: false, note: note.value }), "Rejected.").then(refresh) }, "Reject");
      out.append(h("div", { class: "card" },
        h("div", { class: "card-title" }, t.plate + ", " + t.capacityT + " t"),
        h("p", { class: "card-sub" }, "Owner: " + (t.owner ? t.owner.name + ", " + t.owner.phone : "unknown") + ". The name on the ID and licence must match, and the M-Pesa number should be registered to that name."),
        links, h("div", { class: "card-actions" }, view, field("Note", note), yes, no)));
    });

    out.append(h("h3", {}, "Failed payouts (" + o.failedPayouts.length + ")"));
    if (!o.failedPayouts.length) out.append(h("p", { class: "empty" }, "None."));
    o.failedPayouts.forEach((l) => {
      const sure = h("input", { type: "checkbox" });
      const retry = h("button", { class: "btn btn--primary btn--small", type: "button", onclick: () => { if (!sure.checked) { toast("Tick the box to confirm you checked the M-Pesa statement.", true); return; } act(retry, () => call("adminRetryPayout", { loadId: l.id, confirmedNotPaid: true }), "Payout restarted.").then(refresh); } }, "Retry payout");
      out.append(h("div", { class: "card" },
        h("div", { class: "card-title" }, place(l.from) + " to " + place(l.to) + ", pay " + kes(l.payout ? l.payout.amount : l.priceKES)),
        h("p", { class: "card-sub" }, (l.payout && l.payout.error) || "No reason recorded."),
        h("div", { class: "card-actions" }, h("label", { class: "check-grid" }, sure, "I checked the M-Pesa statement. The owner was NOT paid."), retry)));
    });

    out.append(h("h3", {}, "Disputes (" + o.disputes.length + ")"));
    if (!o.disputes.length) out.append(h("p", { class: "empty" }, "None."));
    o.disputes.forEach((l) => {
      const note = h("input", { type: "text", placeholder: "Note for the record" });
      const pay = h("button", { class: "btn btn--small", type: "button", onclick: () => act(pay, () => call("adminResolveDispute", { loadId: l.id, action: "pay_owner", note: note.value }), "Owner payout started.").then(refresh) }, "Pay the owner");
      const refund = h("button", { class: "btn btn--small", type: "button", onclick: () => { if (window.confirm("Mark as refunded? You must send the money back from your M-Pesa portal yourself.")) act(refund, () => call("adminResolveDispute", { loadId: l.id, action: "refund", note: note.value }), (r) => r.note).then(refresh); } }, "Refund the customer");
      out.append(h("div", { class: "card" },
        h("div", { class: "card-title" }, place(l.from) + " to " + place(l.to) + ", " + kes(l.priceKES)),
        h("p", { class: "card-sub" }, "Reason: " + (l.disputeReason || "not given")),
        h("div", { class: "card-actions" }, field("Note", note), pay, refund)));
    });

    out.append(h("h3", {}, "Recent payouts: does the M-Pesa name match?"));
    if (!o.recentPayouts.length) out.append(h("p", { class: "empty" }, "None yet."));
    o.recentPayouts.forEach((p) => out.append(h("div", { class: "card" },
      h("div", { class: "card-top" }, h("span", { class: "card-title" }, (p.ownerName || "?")), h("span", { class: "badge" + (p.nameMatches ? "" : " badge--bad") }, p.nameMatches ? "Name matches" : "Check this name")),
      h("p", { class: "card-sub" }, "M-Pesa says: " + (p.receiverName || "not returned") + ". Receipt " + (p.receipt || "")))));
  };
  refresh();
}

/* ---------- start ---------- */
const header = document.getElementById("header-user");
document.getElementById("sign-out").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, (user) => {
  if (profileUnsub) { profileUnsub(); profileUnsub = null; }
  me = { user, profile: undefined, isAdmin: false, rate: 0.08, tab: me.tab };
  header.hidden = !user;
  if (!user) { document.getElementById("who").textContent = ""; authView(); return; }
  document.getElementById("who").textContent = user.email || "";
  clear(root); root.append(h("p", { class: "muted" }, "Loading..."));
  call("whoami").then((r) => { me.isAdmin = !!r.isAdmin; if (typeof r.commissionRate === "number") me.rate = r.commissionRate; if (me.profile) mainView(); }).catch(() => {});
  profileUnsub = onSnapshot(doc(db, "users", user.uid), (snap) => {
    if (!snap.exists()) { me.profile = null; profileView(); return; }
    const first = !me.profile;
    me.profile = snap.data();
    if (first) mainView();
  }, (e) => toast(niceError(e), true));
});
}

if (configured) start();
