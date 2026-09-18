# BVN / NIN Verification End-to-End Fix Specification

## Problem

Three interrelated bugs affect the BVN and NIN identity verification flow:

1. **"Unable to save information" error after successful verification**
   User clicks verify BVN or NIN → Prembly verification succeeds → OTP is sent to user's phone via SMS/WhatsApp → but instead of the OTP input modal opening, the user sees an error banner "Unable to save information right now. Please try again." The OTP was sent but the flow is broken.

2. **OTP verification modal does not open**
   Even when an OTP has been dispatched, the frontend does not transition to the OTP code-entry modal. The user has no way to enter the 6-digit code they received, so verification cannot be completed.

3. **BVN / NIN input fields are wiped automatically on some devices**
   When a user signs in from a new device (especially mobile / slow-connection devices), the BVN and NIN text inputs spontaneously clear themselves while the user is typing. This happens cross-device but is more noticeable on phones with slower networks.

## Users

- Borrowers and investors completing the KYC section of their loan / investment application.
- Any authenticated user who has not yet completed BVN + NIN verification.

## Goals

- BVN and NIN verification complete successfully end-to-end with no "Unable to save information" errors.
- After OTP dispatch, the OTP entry modal always opens and lets the user submit the 6-digit code.
- BVN and NIN input values persist reliably across all devices and network conditions — input never gets erased while the user is typing.
- Manual and automated unit tests confirm the fixes against the real PostgreSQL database.

## Non-Goals

- Changing the identity provider (Prembly) or its API contract.
- Redesigning the KYC UI or adding new verification methods.
- Changing admin approval rules for manual document uploads.

## Functional Requirements

### FR-1 — Persistence errors must not swallow a successful verification + OTP challenge.

When the Prembly BVN/NIN API returns SUCCESS and an OTP challenge is created, the HTTP response MUST include `otpChallenge` in the response body even if a downstream PostgreSQL persistence error occurs. The persistence error should be logged server-side, but the user-facing verification flow must continue uninterrupted (with a non-blocking note that a background save is retrying).

### FR-2 — All non-rate-limit OTP dispatch errors are surfaced to the handler.

The `try/catch` around `createOtpChallenge` inside `/me/kyc/bvn/verify` and `/me/kyc/nin/verify` MUST catch every `Error`, not only `OtpRateLimitError`. If an OTP cannot be dispatched, the handler MUST either (a) fall back to marking the checklist item complete when no phone ownership proof is strictly required, or (b) return a descriptive error so the user can pick a different channel.

### FR-3 — Missing KYC case columns are preserved across database reloads.

The following fields MUST be included in the `kyc_cases` relational-table upsert (decompose.ts) so they survive store rebuilds:
- `livenessStatus`
- `livenessManualUploaded`
- `identityPhotoUrl` / alias `identityPhoto`
- `selfieImageData` (already present, confirm safe)
- Any other KYC field referenced in code but missing from the upsert columns.

### FR-4 — Frontend `getMyKyc` prefetch must not race user input.

The on-mount `getMyKyc()` effect in `PersonalKycSection.tsx` MUST respect a user-is-typing guard. If the user has modified `bvn`, `nin`, or other form fields since page load, the effect MUST NOT overwrite those fields via `setValue()`. Fields that already have a user-entered value (non-empty after trim) SHALL be preserved.

### FR-5 — Application-state normalize must not clobber user-entered values.

`normalizeApplicationData` inside `ApplicationContext.tsx` and every other path that hydrates form defaults SHALL use an "existing non-empty value wins" merge strategy rather than a shallow-default override. Specifically: if the user already typed 12345 into BVN, the restored draft must keep 12345 instead of resetting to empty string.

### FR-6 — Controlled inputs use a stable synthetic id per mount.

`FormInput.tsx` currently falls back to `Math.random().toString(36).slice(2, 9)` when `id` and `name` are missing. This regenerates on every render in StrictMode / React 18 and can cause controlled-input resets on devices that schedule frequent re-renders. The generated id MUST be memoized across renders (e.g., via `useId` or a `useRef` + lazy-init pattern).

### FR-7 — Unit tests against the real Neon PostgreSQL database.

A test suite connects to the same Neon database configured in `.env` (`DATABASE_URL`) and exercises:
- Register a temp user → verify BVN endpoint with mocked Prembly → confirm response contains `otpChallenge` when persistence returns transient error.
- Update a KYC case with `livenessStatus`, `livenessManualUploaded` → persist → reload from relational tables → confirm fields are preserved.
- Verify no "Unable to save" 503 response is returned when the only failing step is a non-critical background persist (OTP flow continues).

## Non-Functional Requirements

### NFR-1 — Latency
- BVN / NIN verify endpoints return within 20s end-to-end (Prembly timeout already 15s).
- No additional serial database round-trips added to the hot path.

### NFR-2 — Device compatibility
- Input stability tests are validated on:
  - Desktop Chrome (latest)
  - Mobile Safari (iOS 16+)
  - Mobile Chrome (Android 12+)
The form inputs must survive 60 seconds of continuous typing without any value reset.

### NFR-3 — Backwards compatible
- No API contract changes for existing routes. All new behavior is additive (extra fields survive, error codes remain identical, additional fields in success JSON only).

## Constraints, Dependencies, Assumptions

- **Database binding** : `DATABASE_URL` in `.env` points to a live Neon PostgreSQL instance. Tests use this same DB with a dedicated, cleaned-up test user prefix.
- **Prembly API** : Assumed to work as per the current `prembly.ts` wrapper. No Prembly-side fixes are in scope.
- **React version** : Uses React 18 StrictMode. Any id-memoization fix must work correctly with StrictMode double-invocation effects.

## Open Questions

1. Should transient persistence failures raise a non-blocking toast "Saved offline, will retry" instead of totally silent? (Default: yes, a low-severity toast is better UX than invisible.)
2. Is the identity phone ownership proof ever SKIPPABLE for users whose account profile phone already matches government records? (Current code marks ownership proven automatically when there is no identity phone or when normalizedPhone is falsy — leave behavior as is, only fix error surfaces.)

## Acceptance Criteria

Every AC below is typed as either a `rule` (objective binary pass/fail) or a `rubric` (evaluative with threshold).

### rule AC-1 — BVN verify response contains `otpChallenge` after a transient persist error.
**Pass condition**: Inject a fault into `persistStore()` so it throws once during a BVN verify request. The HTTP 200 response body still contains a non-null `otpChallenge.challengeId` and `otpChallenge.requiresPhoneVerification === true` when Prembly returned SUCCESS and a phone OTP was otherwise created.
**Evidence source**: Automated unit test + captured HTTP response body.

### rule AC-2 — NIN verify response contains `otpChallenge` after a transient persist error.
Same as AC-1 but for the NIN verify route.
**Evidence source**: Automated unit test + captured HTTP response body.

### rule AC-3 — No 503 for an otherwise-successful Prembly + OTP creation.
When Prembly returns SUCCESS and `createOtpChallenge` resolves, the endpoint status code MUST be 2xx regardless of a single transient persistStore throw. A 503 is only returned when zero verification state was applied to the in-memory store.
**Evidence source**: Automated unit test.

### rule AC-4 — Non-RateLimit OTP errors are handled consistently.
Throw a generic `Error` inside `createOtpChallenge` during a BVN/NIN verify call. The handler either falls back cleanly (auto-mark checklist complete) OR surfaces a specific error mentioning channel/OTP dispatch — not a generic silent failure without user feedback.
**Evidence source**: Unit test that mocks `createOtpChallenge` to throw `new Error("SMS gateway down")` and asserts on the non-empty handler response.

### rule AC-5 — `livenessStatus` survives full persist → reload cycle.
1. Set `kyc.livenessStatus = "SUCCESS"` and `kyc.livenessManualUploaded = true` on a case.
2. Run `persistStore()`.
3. Clear in-memory state.
4. Run `rebuildFromDatabase(sql)` and `initializeStore()`.
5. The reloaded KYC case MUST report `livenessStatus === "SUCCESS"` and `livenessManualUploaded === true`.
**Evidence source**: Automated database integration test.

### rule AC-6 — `getMyKyc` prefill never overwrites a non-empty user value.
Render `PersonalKycSection` with a user; after mount let the `getMyKyc` call be artificially delayed 3000 ms; programmatically type `"12345678901"` into the BVN field during the delay; once the effect resolves, assert `formState.bvn` still equals `"12345678901"`.
**Evidence source**: Vitest + React Testing Library test with fake timers.

### rule AC-7 — `normalizeApplicationData` keeps typed values.
Create application data with `kyc.bvn = "22222222222"` and `personalInfo.phone = "08012345678"`. Call `normalizeApplicationData({ ...data, kyc: undefined })` (simulating a partial restore from backend). Output still preserves `kyc.bvn = "22222222222"` and `phone = "08012345678"`.
**Evidence source**: Unit test.

### rule AC-8 — `FormInput` generated id is stable across 100 sequential renders.
Mount `FormInput` without `id` or `name` prop; capture the generated `<input id>` from the DOM; force re-render 100 times; final id MUST byte-for-byte equal the first id.
**Evidence source**: Vitest component test.

### rubric AC-9 — Cross-device input stability.
**Dimension**: Input value retention on a throttled 2G mobile simulation while entering 11 digits.
**Scale**: 0 (fails every run) → 1 (intermittent) → 2 (100% success on 3 consecutive simulated sessions per device: desktop Chrome, iOS Safari, Android Chrome).
**Pass threshold**: Score ≥ 2.
**Evidence source**: Playwright or manual QA matrix with network throttling + screenshots of the final input value.

### rubric AC-10 — OTP modal open reliability.
**Dimension**: Percentage of successful Prembly + OTP created scenarios that result in the OTP modal actually opening on the frontend, including 1 injected transient persist fault per 3 scenarios.
**Scale**: 0 (< 50%) → 1 (50%–95%) → 2 (> 95%).
**Pass threshold**: Score ≥ 2.
**Evidence source**: Frontend integration test covering both the nominal path and the fault-injected path (5 runs each = 10 total).
