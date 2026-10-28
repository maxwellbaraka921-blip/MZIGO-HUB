# Mzigo Hub

A website for Mzigo Hub, a marketplace that connects people with cargo to truck owners in East Africa. This is a static site (plain HTML, CSS and JavaScript), so it needs no build step and no server. GitHub Pages hosts it for free.

## What is in it

- A price check that estimates a load's cost from distance, weight and cargo type
- A sample load board that reprices itself in the visitor's currency
- A country switcher for Kenya, Uganda, Rwanda and Tanzania (currency and mobile money names change)
- A waitlist form for shippers, truck owners and drivers
- Logo files in `assets/`

## Put it online with GitHub

### 1. Create the repository

On github.com, click **New repository**. Name it `mzigo-hub`, keep it **Public** (free Pages needs this on personal accounts), and do not add a README because one already exists.

### 2. Upload the files

With Git on your computer, open a terminal inside this folder and run:

```bash
git init -b main
git add .
git commit -m "Launch Mzigo Hub website"
git remote add origin https://github.com/YOUR-USERNAME/mzigo-hub.git
git push -u origin main
```

No Git? On the new repository page choose **uploading an existing file**, drag in everything from this folder (including the hidden `.github` folder), and commit.

### 3. Turn on Pages

In the repository go to **Settings, Pages**. Under **Build and deployment**, set **Source** to **GitHub Actions**.

The workflow in `.github/workflows/pages.yml` runs on every push to `main`. After a minute or two your site is live at:

```
https://YOUR-USERNAME.github.io/mzigo-hub/
```

Watch progress in the **Actions** tab.

### 4. Use your own domain (optional)

1. Buy a domain such as `mzigohub.com`.
2. In **Settings, Pages, Custom domain**, enter it and save.
3. At your domain registrar, add the DNS records GitHub shows you.
4. Turn on **Enforce HTTPS** once it is available.

The site uses relative links, so it works at both the `github.io/mzigo-hub/` address and a custom domain. The 404 page uses absolute paths, so it works fully only on a custom domain or a `YOUR-USERNAME.github.io` root repository.

## Accounts, auto-accept and M-Pesa payments

The code for these is included. Follow **BACKEND-SETUP.md** to switch it on. Until then the site works as a landing page and waitlist, and the Sign in link stays hidden.

## Make the waitlist form work

By default the form opens an email draft. To collect sign-ups properly:

1. Create a free form at [formspree.io](https://formspree.io) (or a similar service).
2. Copy its endpoint URL.
3. Paste it into `formEndpoint` in `js/config.js`.
4. Change `contactEmail` in `js/config.js` and the address in `privacy.html` to a real inbox.

## Tune the prices

Open `js/config.js`. Per-kilometre rates, border fees, the flexible-date discount and currency rates are all there. They are starting points. Replace them with real quotes from truck owners, and update the currency rates now and then.

Route distances live in `js/pricing.js`. To add a city or road, add it to `PLACES` and `EDGES`.

## Before you tell the public

- The text describes the product you plan to build (escrow, tracking, WhatsApp, SMS and USSD). Edit anything that is not live yet.
- The sample load board is labelled as samples. Keep that label until real loads exist.
- Have a lawyer review `privacy.html`, and check the name "Mzigo Hub" in each country's business registry.
- Have native speakers review any translations you add later.

## Files

```
index.html          the page
app.html            accounts, loads, trucks and payments (needs the backend)
functions/          the backend (Firebase Cloud Functions)
BACKEND-SETUP.md    how to switch the backend on
privacy.html        privacy note (draft)
404.html            page not found
css/styles.css      all styles
js/config.js        settings you will edit
js/pricing.js       distances and price model
js/main.js          page behaviour
assets/             logo and favicon
.github/workflows/  GitHub Pages deploy
```
