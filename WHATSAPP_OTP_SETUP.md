# WhatsApp OTP production setup

This project sends WhatsApp OTPs through the Meta WhatsApp Business Platform (Cloud API). Credentials belong to the backend only; do not add them to `VITE_*` variables, the frontend, Git, screenshots, or issue comments.

## 1. Create or prepare the Meta business account

1. Sign in to [Meta for Developers](https://developers.facebook.com/) with the business administrator account.
2. Create a Meta app using the **Business** app type, or open the existing Velo Finance app.
3. Add the **WhatsApp** product.
4. In **WhatsApp > API Setup**, select or create the Velo WhatsApp Business Account (WABA).
5. Use the temporary test number first. Add test recipient numbers under **API Setup > To** and send a test message before requesting production access.

For production, the business will need a verified Meta Business Portfolio, an approved WhatsApp Business Account, and a phone number that is not already registered in another WhatsApp or WhatsApp Business app. Complete any business verification and display-name review requested by Meta.

## 2. Create the production credentials

Collect these values from the Meta dashboards. Keep a record in the deployment secret manager, not in this repository.

| Project variable | Where to get it | Purpose |
| --- | --- | --- |
| `META_WHATSAPP_ACCESS_TOKEN` | Meta Business Settings > **Users > System Users**: create a system user, assign the WABA and phone number assets, then generate a token with `whatsapp_business_messaging` and `whatsapp_business_management` as required | Server authorization for Graph API requests |
| `META_WHATSAPP_APP_SECRET` | Meta for Developers > **App settings > Basic > App Secret** | Verifies the `X-Hub-Signature-256` on incoming webhooks |
| `META_WHATSAPP_VERIFY_TOKEN` | Generate a long random value yourself | Shared secret used only when Meta verifies the webhook URL |
| `META_WHATSAPP_BUSINESS_ACCOUNT_ID` | Meta **WhatsApp > API Setup**, or Business Settings > Accounts > WhatsApp Accounts | Identifies the WABA |
| `META_WHATSAPP_PHONE_NUMBER_ID` | Meta **WhatsApp > API Setup** beside the registered sending number | Selects the sending phone number in Graph API requests |
| `META_GRAPH_API_VERSION` | Use the current Graph API version supported by the app; the project default is `v21.0` | Graph API URL version |

The access token must be a system-user token for production. Do not use the short-lived token shown on the initial API Setup screen after the test phase.

## 3. Register and verify the sending number

1. In **WhatsApp > API Setup**, choose **Add phone number**.
2. Enter the business display name, category, country, and phone number.
3. Complete SMS or voice verification.
4. Confirm that the number is attached to the intended WABA and that its quality/status is active.
5. Confirm that the system user has access to that WABA and phone-number asset.

Do not reuse a number that is currently active in the consumer WhatsApp app or WhatsApp Business mobile app unless it has been migrated using Meta's supported process.

## 4. Create the OTP message template

Business-initiated OTP messages must use an approved WhatsApp **Authentication** template. A normal text message is not a production substitute when the user has not recently messaged the business.

Create a template in **WhatsApp Manager > Message templates** with:

- Category: **Authentication**
- Language: the language code used by the backend, currently `en_US` unless changed
- A short OTP code variable
- Meta's required authentication/security wording and copy-code button options, where applicable
- No BVN, NIN, password, account number, or other sensitive data

Record the approved template name and language. The application must pass that template name to `sendWhatsAppTemplate`; template approval alone does not make the API credential valid.

## 5. Configure the webhook

The backend already exposes these routes:

```text
GET  https://<API_PUBLIC_HOST>/api/v1/webhooks/meta-whatsapp
POST https://<API_PUBLIC_HOST>/api/v1/webhooks/meta-whatsapp
```

Set `API_PUBLIC_URL` to the public HTTPS API origin, then in **Meta for Developers > WhatsApp > Configuration**:

1. Enter the GET URL above as the **Callback URL**.
2. Enter the exact `META_WHATSAPP_VERIFY_TOKEN` value as the **Verify token**.
3. Click **Verify and save**.
4. Subscribe the WABA to message and message-status webhooks. At minimum, subscribe to `messages` so the app can receive inbound messages and delivery/status events.

The GET route returns Meta's challenge only when the verify token matches. The POST route validates `X-Hub-Signature-256` with `META_WHATSAPP_APP_SECRET` and rejects invalid signatures.

Meta will not deliver normal production traffic while the app remains unpublished. Complete App Review/business verification as required, then switch the app to **Live** before production testing.

## 6. Add the backend environment variables

Set these on the API deployment (for example, the server environment in Vercel or the hosting provider), not on the frontend:

```env
API_PUBLIC_URL=https://api.example.com
META_GRAPH_API_VERSION=v21.0
META_WHATSAPP_ACCESS_TOKEN=<system-user-token>
META_WHATSAPP_APP_SECRET=<meta-app-secret>
META_WHATSAPP_VERIFY_TOKEN=<random-webhook-verify-token>
META_WHATSAPP_BUSINESS_ACCOUNT_ID=<waba-id>
META_WHATSAPP_PHONE_NUMBER_ID=<phone-number-id>
```

Use the real API hostname in `API_PUBLIC_URL`; it must be reachable from Meta over HTTPS. Restart or redeploy the API after changing secrets. Never expose these values through `VITE_` variables.

## 7. Production acceptance checklist

- [ ] Meta business verification and WhatsApp display-name review are complete.
- [ ] Production phone number is registered and active on the intended WABA.
- [ ] System-user token is generated with the required WhatsApp permissions and stored in the deployment secret manager.
- [ ] OTP Authentication template is approved, and its exact name/language are recorded in application configuration.
- [ ] Webhook GET verification succeeds with the configured verify token.
- [ ] Webhook POST requests are accepted only with a valid Meta signature.
- [ ] Test OTP reaches an opted-in Nigerian number in E.164 format, such as `2348012345678`.
- [ ] Delivery, failure, and provider message IDs are captured without logging the OTP value.
- [ ] OTP remains short-lived, single-use, rate-limited, and limited by verification attempts.
- [ ] App is Live/published before testing with real customer traffic.

## Required application follow-up before production

The current OTP flow in `backend/server/auth.ts` sends WhatsApp OTP content through `sendWhatsAppText`. Before production, route WhatsApp OTP through `sendWhatsAppTemplate` in `backend/server/providers/meta.ts`, using the approved Authentication template name and language. Keep the SMS and email paths unchanged, and do not fall back to a WhatsApp text message for business-initiated OTP.

## Current project mapping

- Environment schema: `backend/server/config.ts`
- Meta request adapter: `backend/server/providers/meta.ts`
- Webhook verification and ingestion: `backend/server/index.ts`
- Shared signature helper: `backend/server/providers.ts`
- Existing platform requirement: `INVESTOR_AND_PLATFORM_REQUIREMENTS.md`, section 12

If Meta asks for a certificate, it is optional for this setup unless the selected Meta product or account configuration explicitly requires mutual TLS. The webhook URL, verify token, app secret, access token, WABA ID, and phone-number ID are the required project values.
