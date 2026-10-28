# Turn on accounts, auto-accept and M-Pesa payments

The website on GitHub Pages can only show pages. Accounts, truck checks, auto-accept and money need a backend. This project uses **Firebase** (Google) for that, and **Safaricom Daraja** for M-Pesa.

Do this in order. Set aside a few hours. Nothing here costs money until you go live, except a card on file for Firebase (see Costs).

## What you get

| Feature | How it works |
|---|---|
| Accounts | Sign in with Google or email. Name and M-Pesa number are fixed after sign-up. |
| Verified trucks | Owner uploads ID, logbook, insurance and licence. You approve or reject in the Admin tab. Only approved trucks can carry loads. |
| Auto-accept | Owner sets routes, lowest price, heaviest load and cargo types. A load that fits every rule is accepted for that truck at once. One truck, one job at a time. |
| Payment | Customer pays by M-Pesa prompt (STK push). The backend confirms with Safaricom before marking the load paid. |
| Held until delivery | The receiver gets a 6-digit code from the customer. The driver enters it on arrival, and only then is the owner paid (minus your fee) by M-Pesa. |
| Problems | Either side can report a problem. Money stays held until you resolve it in the Admin tab. |

## Limits to know about

- Payments work for **Kenya (M-Pesa) only**, in Kenyan shillings, up to **KES 250,000 per load** (the M-Pesa limit for one transaction).
- Weight per load is up to 28 tonnes. Post bigger loads as separate loads.
- Refunds are done by you from your M-Pesa portal. The Admin tab records the decision.
- Not covered yet: Uganda, Rwanda and Tanzania payments, SMS and USSD, live GPS tracking.

## Part 1: Create the Firebase project

1. Go to **console.firebase.google.com**, sign in, click **Add project**, name it `mzigo-hub`. Turn Google Analytics off.
2. **Upgrade to the Blaze plan** (bottom left, "Upgrade"). Cloud Functions need it. It has a free monthly allowance, and testing costs almost nothing. Set a **budget alert** at USD 5 when asked.
3. **Build > Authentication > Get started.** Under Sign-in method, turn on **Google** and **Email/Password**.
4. Still in Authentication, open **Settings > Authorized domains** and add `YOUR-USERNAME.github.io`. Without this, sign-in on your live site fails.
5. **Build > Firestore Database > Create database.** Pick **Production mode** and the region `europe-west1`.
6. **Build > Storage > Get started.** Production mode, same region.
7. **Project settings (gear) > Your apps > Web app (`</>`).** Register an app named `mzigo-hub-web`. Copy the config values.
8. Open `js/firebase-config.js`, paste the values in, and change `enabled: false` to `enabled: true`.

These web values are safe to publish. The security rules in `firestore.rules` and `storage.rules` protect the data.

## Part 2: Get Safaricom Daraja test access

1. Go to **developer.safaricom.co.ke**, create an account, and verify your email and phone.
2. **My Apps > Add a new app.** Tick **M-Pesa Sandbox** (and every sandbox API it lists). Copy the **Consumer Key** and **Consumer Secret**.
3. Under **APIs > M-Pesa Express (STK Push)**, find the sandbox **shortcode** and **passkey** on the simulate page.
4. Under **Test Credentials**, copy the **B2C shortcode**, **initiator name** and **initiator password**.
5. Download the **Sandbox certificate** and save it as `functions/certs/SandboxCertificate.cer`.

## Part 3: Install the tools (once)

1. Install **Node.js 20 LTS** from nodejs.org.
2. Open a terminal in the project folder and run:

```
npm install -g firebase-tools
firebase login
firebase use --add
```

Pick your `mzigo-hub` project and give it the alias `default`.

3. Install the backend's packages:

```
cd functions
npm install
cd ..
```

## Part 4: Add your settings and secrets

Create a file named `functions/.env` (it is ignored by Git, so it is never published):

```
MPESA_ENV=sandbox
MPESA_SHORTCODE=<STK shortcode from step 2.3>
MPESA_B2C_SHORTCODE=<B2C shortcode from step 2.4>
MPESA_INITIATOR_NAME=<initiator name from step 2.4>
ADMIN_EMAILS=<your own Google email>
COMMISSION_RATE=0.08
```

`ADMIN_EMAILS` decides who sees the Admin tab. Use only your own verified email. Several emails can be separated by commas.

Now store the secrets. Each command asks you to paste the value:

```
firebase functions:secrets:set DARAJA_KEY
firebase functions:secrets:set DARAJA_SECRET
firebase functions:secrets:set DARAJA_PASSKEY
firebase functions:secrets:set DARAJA_INITIATOR_PASSWORD
firebase functions:secrets:set CALLBACK_TOKEN
```

For `CALLBACK_TOKEN`, make a long random value first:

```
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

Safaricom calls your payment and payout addresses with this token attached. Calls without it are refused.

## Part 5: Deploy

```
firebase deploy --only firestore,storage,functions
```

The first deploy takes several minutes. Then push the website changes with GitHub Desktop as before (commit, then Push origin).

## Part 6: Test in the sandbox

1. Open your live site and click **Sign in**. Create an owner account (name and number are locked afterwards, so use test values).
2. Add a truck with test photos. Sign in with your admin email, open the **Admin** tab, view the documents and **Approve**.
3. As the owner, open the truck's **Auto-accept rules**, add a route, switch auto-accept on, and save.
4. Sign in as a second person (another email) as a **shipper** and post a load on that route at or above the owner's minimum price. It should show **Truck found, waiting for payment** with no owner action.
5. Press **Pay**. In the sandbox, a real phone does not get a prompt. Complete the payment from the Daraja simulator for the checkout request, and the load should move to **Paid, held safely**. If your callback does not arrive, the backend asks Safaricom itself within 5 minutes.
6. As the owner, mark the load collected, then enter the shipper's 6-digit code. The payout starts, and the sandbox result should arrive and mark it **Complete**.

If something fails, open **Firebase console > Functions > Logs**.

**Honest status:** the matching rules, phone and money checks, M-Pesa message handling and status flow have automated tests. The screens were tested against a stand-in for Firebase. The deployed functions have **not** been run against real Firebase or real Safaricom servers, so expect to fix small things in Part 6. Do not skip it.

## Part 7: Going live with real money

Do not do this until Part 6 works end to end.

1. Get a **Pay Bill or Till number** registered to your business. For payouts you need **B2C** enabled on a Pay Bill. Ask Safaricom (M-PESA for Business) about it.
2. On Daraja, use **Go Live** and follow the steps. You will receive production keys, a production shortcode and passkey, and the production certificate.
3. Save the production certificate as `functions/certs/ProductionCertificate.cer`.
4. In `functions/.env`, set `MPESA_ENV=production` and the new shortcodes and initiator name. Re-run the five `functions:secrets:set` commands with the production values.
5. Deploy again. Start with one small real load between two people you know and check the M-Pesa statements by hand.

## Part 8: Before you take other people's money

These are not optional, and they are not things I can settle for you. Talk to a Kenyan lawyer.

- **Holding customers' money until delivery** can count as running a payment service. Ask whether you need a licence from the Central Bank of Kenya, a licensed partner, or a trust or escrow account.
- **Collecting IDs and phone numbers** means registering as a data controller with the Office of the Data Protection Commissioner under the Data Protection Act, 2019. Have the privacy note reviewed.
- **Terms of service** covering fees, who is responsible for damaged or lost goods, cancellations and disputes.
- **Tax** on the commission you earn.
- **Goods insurance.** Decide whether you offer it or require owners to carry it.

## Costs

Firebase's free monthly allowance covers early testing. Cloud Functions, Secret Manager and Cloud Scheduler can show small charges once you are on the Blaze plan, usually well under a few dollars a month at test volumes. The budget alert from Part 1 protects you. Safaricom charges transaction fees in production.

## Everyday admin

- **Approve trucks:** Admin tab, View documents, check the name on the ID and licence matches the owner, then Approve or Reject with a reason.
- **Check payout names:** the Admin tab lists recent payouts with the name Safaricom returned for the receiving number. A mismatch is flagged. Look into it before the next payout to that owner.
- **Failed payouts:** retry only after checking your M-Pesa statement to confirm the owner was not paid. The button makes you tick a box to say so.
- **Disputes:** pay the owner, or refund. For a refund, send the money back from your M-Pesa portal yourself.
- **Change someone's phone or name:** do it in the Firestore console on their `users` document, after you have confirmed it is really them.

## Where things are

```
app.html, css/app.css, js/app.js     the app screens
js/firebase-config.js                your Firebase web settings
functions/index.js                   the backend
functions/lib/                       matching rules, money, M-Pesa helpers, status flow
functions/test/                      automated tests (cd functions, then npm test)
firestore.rules, storage.rules       who can read what
firebase.json                        deploy settings
```

The server has its own copy of the price tables (`functions/lib/price-config.js`). If you change prices in `js/config.js`, change them there too.
