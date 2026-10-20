# SŌKO COFFEE: QR Table Ordering

Customers scan the QR code on their table, browse the menu, order, and see live status. Staff get live alerts in the admin page.

## Run it
1. Install Node.js 18 or newer (nodejs.org).
2. In this folder:  `npm install`
3. Start:  `ADMIN_PASSWORD="your-strong-password" npm start`   (Windows PowerShell: `$env:ADMIN_PASSWORD="..."; npm start`)
4. Open `http://localhost:3000/admin`, log in, go to **Tables & QR**, set **Settings > Website address** to your public address, then print the QR codes.

## Put it online (needed for real customers)
Deploy to any Node host (Render, Railway, a VPS) with HTTPS. Set `ADMIN_PASSWORD`, optionally `PORT`, and keep the `data/` folder on a **persistent disk** (it holds orders, menu and photos). Back it up regularly.

## Emails (optional)
Install nodemailer (`npm i nodemailer`) and set `SMTP_URL` (e.g. `smtps://user:pass@smtp.gmail.com`) and `MAIL_FROM`. Then new-order emails go to the address in Settings, and customers who type an email get a confirmation.
SMS / WhatsApp need a paid provider and are not included.

## Security notes
- Each table has a secret code in its QR. Orders need an active code; regenerate a code if leaked.
- Prices are always taken from the server, never from the customer's phone.
- A QR code cannot prove someone is physically in the café (anyone could photograph it). To limit misuse use "Regenerate all codes" daily, or ask staff to confirm unfamiliar orders.
- The admin login is rate-limited; change the default password.
