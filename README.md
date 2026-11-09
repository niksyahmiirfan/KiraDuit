# KiraDuit

A personal daily spending tracker for iPhone. ShopeePay QR and Apple Pay payments feed one dashboard, which installs to your Home Screen like an app.

## 1. Put it online (Cloudflare Pages)

All of this is in the Cloudflare dashboard. No command line needed.

1. **Create the database.** Go to Storage & databases > D1 > Create, and name it `kiraduit`. Open its Console, paste in the contents of `schema.sql`, and run it.
2. **Create the site.** Go to Workers & Pages > Create > Pages > Connect to Git, and pick this repository. Leave the framework preset as None and the build command empty. Set the build output directory to `public`. Deploy.
3. **Connect the database.** In the Pages project, go to Settings > Bindings > Add > D1 database. Set the variable name to `DB` and choose `kiraduit`.
4. **Set your access key.** In Settings > Variables and Secrets, add a **Secret** named `API_TOKEN`. Use a long random value and save it in your password manager.
5. **Redeploy.** Go to Deployments, open the latest one, and choose Retry deployment so the two settings above apply.

Your address is `https://<project>.pages.dev`. Every push to `main` deploys automatically.

To run it locally: `npm install`, `npm run db:local`, put `API_TOKEN=anything` in `.dev.vars`, then `npm run dev`.

## 2. Install it on your iPhone

Open your address in Safari, tap Share, then Add to Home Screen. Open KiraDuit from the new icon and enter your access key.

## 3. Capture ShopeePay QR with Back Tap

In the Shortcuts app, create a shortcut named **Log receipt** with these actions:

1. **Take Screenshot**
2. **Extract Text from Image** (input: the screenshot)
3. **Get Contents of URL**
   - URL: `https://YOUR-ADDRESS/api/ingest`
   - Method: POST
   - Header: `Authorization` = `Bearer YOUR-ACCESS-KEY`
   - Request Body: JSON, with `source` = `shopeepay_qr` and `text` = the extracted text
4. **Show Notification** (body: Contents of URL)

Then go to Settings > Accessibility > Touch > Back Tap > Double Tap and choose **Log receipt**.

After paying, double-tap the back of your phone while the success screen is showing. Tapping twice on the same receipt won't log it twice.

## 4. Capture Apple Pay automatically

In Shortcuts > Automation > New Automation, choose **Wallet** (called **Transaction** before iOS 26). Select your cards and choose **Run Immediately**. Then add:

1. **Get Contents of URL**
   - URL, method and header as above
   - Request Body: JSON, with `source` = `apple_pay`, `amount` = Shortcut Input > Amount, `merchant` = Shortcut Input > Merchant, `card` = Shortcut Input > Card

Wallet automations run on in-store taps. Pay-in-app or online Apple Pay purchases may need adding by hand.

## 5. Get a daily report

In Shortcuts > Automation > New Automation, choose **Time of Day** (for example 9:30 pm), then **Run Immediately**:

1. **Get Contents of URL**: `https://YOUR-ADDRESS/api/report`, method GET, same `Authorization` header
2. **Show Notification** (body: Contents of URL)

## Good to know

- Anything the scan isn't sure about appears as "Tap to check".
- When you change a merchant's category, future purchases there use it.
- Screen text is stored only for receipts marked to check, and is deleted once you save them.
- Your access key is the only lock on your data. If it leaks, run `npx wrangler secret put API_TOKEN` again and update your shortcuts.
