# KiraDuit 💰

A daily spending tracker for iPhone. ShopeePay QR and Apple Pay payments are logged automatically to one dashboard, which installs on your Home Screen like an app.

**Contents:** [Setup](#1-setup) · [Install](#2-install-on-iphone) · [Log payments](#3-log-payments) · [Daily routine](#4-daily-routine) · [Using the app](#5-using-the-app) · [Tips](#tips)

## 1. Setup

Everything is done in the Cloudflare dashboard. No command line is needed.

1. **Create the database.** Go to Storage & databases > D1 > Create and name it `kiraduit`. Open its Console, paste in `schema.sql`, and run it.
2. **Create the site.** Go to Workers & Pages > Create > Pages > Connect to Git and pick this repository. Set the framework to None, leave the build command empty, and set the output directory to `public`.
3. **Connect the database.** In Settings > Bindings, add a D1 database with variable name `DB` and choose `kiraduit`.
4. **Set your access key.** In Settings > Variables and Secrets, add a Secret named `API_TOKEN` with a long random value. Save it in your password manager.
5. **Redeploy.** In Deployments, open the latest one and choose Retry deployment.

Your address is `https://<project>.pages.dev`. Each push to `main` deploys automatically.

To run locally: `npm install`, `npm run db:local`, put `API_TOKEN=anything` in `.dev.vars`, then `npm run dev`.

## 2. Install on iPhone

Open your address in Safari, tap Share, then Add to Home Screen. Open KiraDuit from the new icon and enter your access key.

## 3. Log payments

In every shortcut below, the **Get Contents of URL** action uses:
- Method: POST
- Header: `Authorization` = `Bearer YOUR-ACCESS-KEY`
- Request Body: JSON

### ShopeePay QR (Back Tap)

Create a shortcut named **Log receipt**:

1. **Take Screenshot**
2. **Extract Text from Image** (input: the screenshot)
3. **Get Contents of URL**: `https://YOUR-ADDRESS/api/ingest`, with `source` = `shopeepay_qr` and `text` = the extracted text
4. **Show Notification** (body: Contents of URL)

Then go to Settings > Accessibility > Touch > Back Tap > Double Tap and choose **Log receipt**.

After paying, double-tap the back of your phone on the success screen. Tapping twice on the same receipt won't log it twice.

### Apple Pay (automatic)

In Shortcuts > Automation > New Automation, choose **Wallet** (called **Transaction** before iOS 26). Select your cards and choose **Run Immediately**. Add one action:

- **Get Contents of URL**: `https://YOUR-ADDRESS/api/ingest`, with `source` = `apple_pay`, `amount` = Shortcut Input > Amount, `merchant` = Shortcut Input > Merchant, `card` = Shortcut Input > Card

   To fill these in, insert **Shortcut Input**, tap it, and choose the matching property from its list. Don't type "> Amount" as text.

This runs on in-store taps. In-app or online Apple Pay purchases may need adding by hand.

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

## 4. Daily routine

Create both in Shortcuts > Automation > New Automation > **Time of Day**. Choose **Daily** and **Run Immediately**.

**8:00 am: set today's budget**

1. **Ask for Input**: type Number, prompt "Today's budget?"
2. **Get Contents of URL**: `https://YOUR-ADDRESS/api/budget`, with `amount` = Provided Input
3. **Show Notification** (body: Contents of URL)

**10:30 pm: today's summary**

1. **Get Contents of URL**: `https://YOUR-ADDRESS/api/report`, method **GET**, same `Authorization` header
2. **Show Notification** (body: Contents of URL)

If you skip the 8 am prompt, KiraDuit uses your default budget, or your can-spend-per-day amount if you haven't set one.

## 5. Using the app

- **Budget:** set or change today's budget on the Home screen. The screen turns reddish once today's spending passes it.
- **Receipts:** every logged payment shows a "Logged" notification. If you don't see one, the payment wasn't saved, so add it by hand.
- **Checking:** anything the scan isn't sure about appears as "Tap to check".
- **Categories:** when you change a merchant's category, future purchases there use it.
- **Shortcuts page:** ShopeePay opens directly. For Touch 'n Go eWallet and MAE, create a shortcut with the **Open App** action for each and name them exactly **Open TNG** and **Open MAE**.

## Tips

- Screen text is stored only for receipts marked to check, and is deleted once you save them.
- Your access key is the only lock on your data. If it leaks, set a new `API_TOKEN` secret in Cloudflare, redeploy, and update your shortcuts.
