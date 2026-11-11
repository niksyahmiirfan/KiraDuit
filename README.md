# KiraDuit 💰

A daily spending tracker for iPhone. ShopeePay QR and Apple Pay payments are logged automatically to one dashboard, which installs on your Home Screen like an app.

**Contents:** [Setup](#1-setup) · [Install](#2-install-on-iphone) · [Log payments](#3-log-payments) · [Using the app](#4-using-the-app) · [Tips](#tips)

## 1. Setup

Everything is done in the Cloudflare dashboard. No command line is needed.

1. **Create the database.** Go to Storage & databases > D1 > Create and name it `kiraduit`. Open its Console, paste in `schema.sql`, and run it.
2. **Create the site.** Go to Workers & Pages > Create > Pages > Connect to Git and pick this repository. Set the framework to None, leave the build command empty, and set the output directory to `public`.
3. **Connect the database.** In Settings > Bindings, add a D1 database with variable name `DB` and choose `kiraduit`.
4. **Set your access key.** In Settings > Variables and Secrets, add a Secret named `API_TOKEN` with a long random value. Save it in your password manager.
5. **Optional: switch on AI help.** In Settings > Bindings, add Workers AI with variable name `AI`. This enables Quick add, reading of receipts the app is unsure about, and better categories for unfamiliar shops. Without it, the app works as before.
6. **Redeploy.** In Deployments, open the latest one and choose Retry deployment.

Your address is `https://<project>.pages.dev`. Each push to `main` deploys automatically.

To run locally: `npm install`, `npm run db:local`, put `API_TOKEN=anything` in `.dev.vars`, then `npm run dev`.

## 2. Install on iPhone

Open your address in Safari, tap Share, then Add to Home Screen. Open KiraDuit from the new icon and enter your access key. You stay signed in for 30 days. To sign out sooner, tap **Sign out** on the home screen.

## 3. Log payments

In every shortcut below, the **Get Contents of URL** action uses:
- Method: POST
- Header: `Authorization` = `Bearer YOUR-ACCESS-KEY`
- Request Body: JSON

### QR receipts: ShopeePay, AEON Bank, TNG eWallet (Back Tap)

Create a shortcut named **Log receipt**:

1. **Take Screenshot**
2. **Extract Text from Image** (input: the screenshot)
3. **Get Contents of URL**: `https://YOUR-ADDRESS/api/ingest`, with `source` = `shopeepay_qr` and `text` = the extracted text
4. **Show Notification** (body: Contents of URL)

Then go to Settings > Accessibility > Touch > Back Tap > Double Tap and choose **Log receipt**.

The same shortcut works on the success screen of ShopeePay, AEON Bank and TNG eWallet, and KiraDuit tells them apart from the screen text. The person or shop paid becomes **Where**, and a recipient reference or remark becomes **What**. The app shows as the payment method under **Paid with**. Keep `source` = `shopeepay_qr` for all three.

After paying, double-tap the back of your phone on the success screen. Tapping twice on the same receipt won't log it twice.

### Apple Pay (automatic)

In Shortcuts > Automation > New Automation, choose **Wallet** (called **Transaction** before iOS 26). Select your cards and choose **Run Immediately**. Add one action:

- **Get Contents of URL**: `https://YOUR-ADDRESS/api/ingest`, with `source` = `apple_pay`, `amount` = Shortcut Input > Amount, `merchant` = Shortcut Input > Merchant, `card` = Shortcut Input > Card

   To fill these in, insert **Shortcut Input**, tap it, and choose the matching property from its list. Don't type "> Amount" as text.

This runs on in-store taps. In-app or online Apple Pay purchases may need adding by hand.

**Refunds:** if the automation also runs for a refund, KiraDuit removes the matching purchase, meaning the same merchant and amount within 30 days. It recognises a refund from a minus sign on the amount, or from the word "refund" in the transaction's Name. To pass that on, add a field `name` = Shortcut Input > Name to the request. Partial refunds that don't match a purchase change nothing, so remove or edit those by hand.

### Ask what you bought (optional)

These steps ask what you bought straight after a payment is logged, and save it in the **What** field. The purchase is logged first, so skipping or dismissing the question never loses it.

**Apple Pay:** in the Wallet automation, add these after **Get Contents of URL**:

1. **Ask for Input**: type Text, prompt "What did you buy at Shortcut Input > Merchant?" (insert Merchant as a property, as above)
2. **If** Provided Input **has any value**
3. Inside the If, **Get Contents of URL**: `https://YOUR-ADDRESS/api/transactions/latest/item`, with `source` = `apple_pay` and `item` = Provided Input
4. Inside the If, **Show Notification** (body: Contents of URL)

**ShopeePay QR:** in **Log receipt**, add these after **Show Notification**, before any receipt photo steps:

1. **If** Contents of URL **contains** `logged`
2. Inside the If, **Ask for Input**: type Text, prompt "Contents of URL. What did you buy?"
3. Inside the If, a second **If** Provided Input **has any value**, containing:
   - **Get Contents of URL**: `https://YOUR-ADDRESS/api/transactions/latest/item`, with `source` = `shopeepay_qr` and `item` = Provided Input
   - **Show Notification** (body: Contents of URL)

The first If skips the question when no payment was found on screen. The item goes on the latest purchase from that source in the last 10 minutes.

### Receipt photos (optional)

KiraDuit offers a photo prompt for 30 minutes after a QR purchase, and you can add a photo to any purchase by tapping it. To be asked right after the double-tap instead, add these to the end of **Log receipt**:

1. **Choose from Menu**: prompt "Add a receipt photo?", options **Take photo** and **Skip**
2. Under **Take photo**, add:
   - **Take Photo** (Show Camera Preview on)
   - **Resize Image**: width 1400
   - **Convert Image**: JPEG, quality 70%
   - **Base64 Encode**: Line Breaks = None
   - **Get Contents of URL**: `https://YOUR-ADDRESS/api/receipts/latest`, with `image` = the Base64 result
   - **Show Notification** (body: Contents of URL)

## 4. Using the app

- **Budget:** set or change today's budget on the Home screen. If you don't, KiraDuit uses your default budget, or your can-spend-per-day amount if you haven't set one. The screen turns reddish once today's spending passes it.
- **Receipts:** every logged payment shows a "Logged" notification. If you don't see one, the payment wasn't saved, so add it by hand.
- **Checking:** anything the scan isn't sure about appears as "Tap to check".
- **Categories:** when you change a merchant's category, future purchases there use it.
- **Scanning a receipt:** tap **+**, then **Scan a receipt**, or open a logged purchase and tap **Pick my items from the receipt**. Tick your items, and use + and − for items ordered more than once. Your share includes your part of service charge, SST, discounts and rounding, in proportion to what you ordered. From **+** it logs your share. From a logged purchase you can split the rest with friends or set the purchase to your share. This needs AI help to be switched on.
- **Splitting a bill:** open a purchase and tap **Split this bill**, then add the friends who owe you. Only your share counts as spending, and what friends owe appears under **Owed to you** on Home until you mark it paid. KiraDuit also asks about Food purchases of RM60 or more that are over three times your usual Food purchase.
- **Shortcuts page:** tap **Edit** to add, change, reorder or remove shortcuts, up to 12. A shortcut opens an app link such as `shopeepaymy://`, a website, or an iPhone Shortcut by name. For apps without a link, such as Touch 'n Go eWallet and MAE, make a Shortcut with the **Open App** action named exactly **Open TNG** or **Open MAE**, or whatever name you give it in KiraDuit. Icons are optional, and a letter is shown without one.

## Tips

- Screen text is stored only for receipts marked to check, and is deleted once you save them.
- Your access key is the only lock on your data. If it leaks, set a new `API_TOKEN` secret in Cloudflare, redeploy, and update your shortcuts. This also signs out every browser.
- The app keeps you signed in with a private cookie that scripts on the page cannot read, not with your access key. Your shortcuts still send the key.
- After 5 wrong keys, that device is blocked for 15 minutes. For extra protection, add a Cloudflare rate limiting rule for `/api/*` (Security > WAF > Rate limiting rules).
- Updating from an older version: run `schema.sql` in the D1 Console again. It only adds the new `auth_failures` table and leaves your data alone. Until you do, the 5-attempt limit stays off.
