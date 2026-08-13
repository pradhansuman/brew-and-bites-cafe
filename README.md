# ☕ Brew & Bites Cafe — Order & Pay by UPI

A cafe ordering app: customers log in with their **name + mobile number**
(OTP), are **auto-assigned a free table**, browse the menu, add to cart and
**place their order**. **Each placement is its own order** — the admin is
notified instantly (table + items), starts preparing, and sets an
**estimated serve time** the customer can see. Orders stay open until the
customer taps **"Pay your bill"**, which totals **all open orders** and pays
by UPI directly to the admin's real UPI account. Payment closes the orders,
frees the table, notifies the admin, and **logs the customer out
automatically**.

## How it works

| Step | What happens |
|---|---|
| 1. Login | Customer enters **name** + 10-digit mobile → OTP (demo: shown on screen) → verified |
| 2. Table | A **free table is assigned automatically**. If all are occupied, login waits. |
| 3. Order | Add items → **Place Order** → admin notified with **table + items** (each placement = a new order number). The order starts as **Received** and **auto-changes to Accepted ~10 seconds later** (kitchen took the order). It stays open until paid. |
| 4. ETA | Admin taps **Start preparing** and sets the **estimated minutes** (e.g. 15) — the customer's order flips to **Preparing** with a **live animated progress bar** that fills toward the ETA (shimmering while preparing, "Almost ready!" pulse when time is up). |
| 5. More | Customer can place again whenever they want — each placement is a separate order, all open until paid. |
| 6. Pay bill | **"Pay your bill"** totals **all open orders** (items + 5% GST) → pay by **UPI App** (deep link) / **Scan UPI QR** / **Simulate** |
| 7. Admin notified | **Payment received** appears live on the dashboard (toast + sound + browser notification) |
| 8. Auto logout | Orders marked PAID, table freed, receipt shown, then the customer is **logged out automatically after about a minute** |

## Admin dashboard

- **Open Orders tab** — every placed order (order ID, table, customer,
  itemised list, running total, time). Tap **Start preparing** with the
  **ETA in minutes** (e.g. 15) — the customer sees it instantly. "Update ETA"
  changes it any time.
- **Payments tab** — every paid bill with amount, customer, table and time.
- **UPI Settings card** — set the cafe's **real UPI ID** right in the
  dashboard. With Firebase live sync enabled, saving here pushes the ID to
  every customer device instantly, so payments go straight to your account.
- Stats: today's revenue, open orders, payments today.

## Demo credentials

- **OTP:** shown in a toast on screen (no real SMS is sent)
- **Admin passcode:** `1234` (link at the bottom of the login screen)

## Configuration (`js/data.js`)

```js
const CAFE = {
  upiId: "9900905159@ybl",   // ← merchant VPA (this is the payment address; also settable in Admin → UPI Settings)
  upiName: "Brew & Bites Cafe",
  gstRate: 0.05,               // ← GST percentage (0.05 = 5%)
  adminPasscode: "1234",       // ← change this
  tables: 12,                  // ← number of tables for auto-assignment
  rt: { enabled: false, url: "" }  // ← optional real-time sync (below)
};
```

Menu items are edited in the `MENU` object (name, description, price, emoji, veg flag).

## Making it real-time (cross-device)

### Option A — Firebase sync (already built in, zero backend) ⭐
1. Create a free Firebase project → **Realtime Database** → start in *test mode*.
2. Copy the database URL (e.g. `https://my-cafe-12345-default-rtdb.firebaseio.com`).
3. In `js/data.js` set `rt: { enabled: true, url: "https://...firebaseio.com" }`.

Orders, ETAs and payments are mirrored to Firebase, and the admin dashboard
**on any device** updates instantly (REST + SSE — no SDK). The admin's UPI ID
setting also syncs to all customer devices. (For production, restrict DB
rules and add auth.)

### Option B — Small backend + WebSocket (recommended for production)
A tiny Node/Express service that owns orders/tables/payments, pushes updates
via WebSocket (Socket.io) or the Firebase SDK, and **verifies** the UPI
payment webhook before marking orders paid. The front-end keeps all storage
behind the `store` object, so swapping the data layer needs no UI changes.

## Real UPI payments to your account

The customer pays **directly to the UPI ID shown at checkout** (deep link or
QR), so the money lands in whatever VPA the admin has set — enter yours in
**Admin → UPI Settings** (instant, synced to all devices with Firebase) or set
`CAFE.upiId` in `js/data.js`. To test for real: set a real VPA, open the app
on a phone, place an order, tap **Pay your bill**, choose UPI App or Scan QR,
complete the payment in GPay/PhonePe/Paytm, and tap **"I've Paid"** — the
money arrives in your account, the admin is notified, and the customer is
logged out.

To make confirmation fully automatic (no "I've Paid" tap):

1. **Payment gateway / aggregator (recommended)** — Razorpay, Cashfree, PayU,
   PhonePe PG, Juspay. Backend creates a UPI order, gateway calls your
   **webhook** on success, backend **verifies the signature**, marks the order
   paid and pushes the update to the admin. Never trust a payment
   confirmation that comes only from the browser.
2. **Direct bank UPI API** — corporate UPI (mandate/collect) via your bank or
   PSP; similar webhook flow.

### Security checklist for production
- Verify every webhook signature server-side; ignore unverified callbacks.
- Store payment/order state server-side; treat the browser only as a view.
- Use HTTPS everywhere; real auth (not a shared passcode) for admin.
- Rate-limit login/OTP endpoints (real OTP via MSG91 / Twilio / Fast2SMS).

## Troubleshooting

### "UPI app shows: something went wrong, please try again later"
This happens when the UPI ID being used is **not a registered VPA**. The repo
ships with the cafe's real VPA (`9900905159@ybl`) already set in `CAFE.upiId`.
If you ever switch to a different receive-address, set it in **Admin → UPI
Settings** (or `CAFE.upiId` in `js/data.js`) — the app guards against the old
demo placeholder (`brewandbites@upi`) and warns instead of sending customers
into a failing payment.

### Nothing opens when I tap "Pay via UPI App"
Deep links need a phone with UPI apps. The app now handles every case:
- **Desktop browser** → a dialog appears: **Scan UPI QR** (scan with your
  phone's UPI app), **Copy UPI ID** (paste in any UPI app), or **Simulate**.
- **iPhone (Safari)** → Safari blocks `upi://` deep links, so the app does
  NOT fire a dead link; it shows the same **QR / Copy UPI ID** dialog.
- **Android** → the deep link fires (with `mode=02` intent, which GPay /
  PhonePe / Paytm all understand) and opens the app chooser / pay screen.

If the UPI app opens but shows "something went wrong", the VPA in use is not
registered (see above) — update it in **Admin → UPI Settings**.

### Payment never completes automatically
This static app has no server, so it can't watch your bank account. The
customer taps **I've Paid** after finishing the payment, and the admin is
notified. Fully automatic confirmation needs the small webhook backend
described in "Making it real-time" — the UPI apps themselves always work; only
the auto-confirm is manual here.

### Real SMS OTP (instead of the on-screen demo OTP)
**Firebase Phone Auth is implemented** in the app (no server needed — works on
any static host). The app ships in `demo` mode; to go real:

1. console.firebase.google.com → **Add project** (Analytics optional → off).
2. Build → **Authentication** → **Get started** → **Sign-in method** →
   enable **Phone**.
3. Project settings → **Billing** → upgrade to **Blaze** (pay-as-you-go) —
   phone-auth SMS is a paid Firebase feature.
4. Project settings → **Your apps** → **Web app (</>)** → copy the config.
5. In `js/data.js`, fill `CAFE.otp`:
   `mode: "firebase"` and the `firebaseConfig` values (`apiKey`,
   `authDomain`, `projectId`, `appId`).
6. Authentication → **Settings** → **Authorized domains**: add your deployed
   domain (e.g. `brew-and-bites-cafe.onrender.com`) and the preview domain.
7. Deploy. Login now sends a **real 6-digit SMS OTP** (+91 prefix) with an
   invisible reCAPTCHA. Demo mode stays as the fallback — if `firebaseConfig`
   is empty the app shows a clear warning instead of failing.

Notes:
- **India**: phone-auth SMS follows carrier rules — test with your own number
  first; if SMS doesn't arrive, check Firebase Console → Authentication logs.
- Quota: ~10 SMS per number per hour (safety default) — expected during testing.
- reCAPTCHA not loading? Add that domain to Authorized domains (step 6).

### Admin didn't get the notification
- Demo mode: admin and customer must share the same device/browser
  (cross-tab works).
- Different devices: enable Firebase sync (Option A above).
- Browser notifications need permission granted on the admin device.

## Deploy on Render (free)

The app is a plain static site (HTML/CSS/JS, hash-based routing) — Render
serves it directly, no build step, no server.

1. Push this folder to GitHub (see **Git** below).
2. Render dashboard → **New → Static Site** → connect the repo.
3. **Build command:** leave empty (or `echo "static site"`).
4. **Publish directory:** `.` (the repo root — `index.html` lives here).
5. **Create Static Site** → done. Your app is live at `https://<name>.onrender.com` with HTTPS.
6. (Alternative) **New → Blueprint** with this repo — `render.yaml` applies the same config automatically.

Notes:
- Hash routing (`#/menu`, `#/admin`) needs **no URL rewrites**.
- Data lives in each visitor's browser (`localStorage`). For the admin to see
  orders/payments from **other devices**, enable Firebase sync
  (`CAFE.rt` in `js/data.js`, see "Making it real-time").
- Set your real UPI ID in `js/data.js` or Admin → UPI Settings
  (currently `9900905159@ybl`).
- **Real SMS OTP** is built in via Firebase Phone Auth — switch
  `CAFE.otp.mode` from `"demo"` to `"firebase"` and paste your
  `firebaseConfig` (see "Real SMS OTP" in Troubleshooting).
- `nginx.conf` is only used by the Function Compute deployment — Render
  ignores it.

## Git

```bash
git init
git add .
git commit -m "Brew & Bites Cafe — order, UPI pay, live admin"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

## Files

```
nginx.conf     # FC nginx runtime config (listen 9000, /code root)
index.html     # SPA shell
css/styles.css # cafe theme, mobile-first
js/data.js     # menu + config (UPI ID, GST, tables, Firebase rt)
js/app.js      # auth, tables, orders+ETA, billing, UPI, admin dashboard
```
