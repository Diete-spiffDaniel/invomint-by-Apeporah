# InvoMint

**Create. Send. Get Paid.**

InvoMint is an account-free invoice and receipt workspace for small businesses, freelancers, and entrepreneurs. It runs in a browser and can be installed as a mobile-friendly web app. No login, registration, subscription, or cloud account is required.

## Run locally

From this folder, start a static HTTP server with Python:

```powershell
py -m http.server 8000
```

Open <http://localhost:8000/>. A local HTTP server is needed for IndexedDB, service-worker caching, and install support; opening `index.html` directly is not supported.

## Main features

- Dashboard with invoice totals, paid/unpaid/overdue counts, recent documents, and revenue chart.
- Create, preview, edit, duplicate, print, and save invoices. Create, preview, print, download, and share receipts.
- Customer and product/service records that can be reused in invoice and receipt forms.
- Business profile with contact information, logo, tax ID, default currency, and signature/payment instructions.
- Document templates, dark/light/system theme, and invoice numbering prefix.
- Searchable document and customer lists, invoice payment status, WhatsApp sharing, and document duplication.
- JSON backup and restore, with validation before an existing workspace is replaced.
- Responsive layouts and an installable PWA shell with offline access to the app interface.

## Data, privacy, and offline use

Business records are stored in IndexedDB on this device. Editor drafts may also be kept in the browser's local storage. InvoMint does not send records to an InvoMint server and does not require an account. Sharing through WhatsApp or the device share sheet sends content to the selected third-party app.

Download a backup regularly. Clearing browser/site data or uninstalling the app may erase local records. The app interface and saved data are local, but receipt image/PDF downloads use html2canvas and jsPDF from a CDN and need an internet connection the first time those libraries are needed. Printing invoices or receipts through the browser remains an alternative.

For installation on Android, serve the app over HTTPS (or use `localhost` during development), then choose **Install app** when offered or use the browser menu's **Install app / Add to Home Screen** action.

## Project structure

- `index.html`, `styles.css`, and `app.js` — InvoMint dashboard, navigation, local data, backup/restore, and editor integration.
- `manifest.webmanifest`, `service-worker.js`, `icon.svg`, and `icon.png` — install and offline app shell.
- `invoice-generator/` — invoice editor, preview, calculations, and print workflow.
- `receipt-generator/` — receipt editor, templates, calculations, print, PDF, and image workflow.
- `workspace-embed.js` — shared embedded-editor behavior.
