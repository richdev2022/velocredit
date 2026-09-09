import cors from "cors";
import { randomUUID } from "node:crypto";
import express from "express";
import helmet from "helmet";
import swaggerUi from "swagger-ui-express";
import { assertProductionSecrets, env } from "./config.js";
import { databaseHealth } from "./db.js";
import apiRouter from "./routes.js";
import { openapi } from "./openapi.js";
import {
  verifyFlutterwaveWebhook,
  verifyKudiSignature,
  verifyMetaWebhookSignature,
  verifyPremblyWebhook,
} from "./providers.js";
import { ensureDatabaseSchema } from "./migrate.js";
import { runInvestmentMaturitySweep } from "./investments.js";
import { runRepaymentReminderSweep } from "./reminders.js";
import {
  repayments,
  creditHistory,
  loans,
  payouts,
  investments,
  providerEvents,
  walletTransactions,
  findWallet,
  appendLedger,
  wallets,
} from "./store.js";
import { initializeStore, persistStore, seedInvestmentPlans, seedLoanProducts } from "./store.js";

assertProductionSecrets();

const app = express();
app.disable("x-powered-by");
app.use(helmet());
app.use(cors({ origin: env.API_ORIGIN, credentials: true }));
app.use((req, res, next) => {
  const requestId = randomUUID();
  const startedAt = Date.now();
  res.setHeader("X-Request-ID", requestId);
  console.log(`[API] ${requestId} -> ${req.method} ${req.originalUrl}`);
  res.on("finish", () => {
    console.log(`[API] ${requestId} <- ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - startedAt}ms`);
  });
  next();
});

app.post(
  "/api/v1/webhooks/flutterwave",
  express.raw({ type: "application/json", limit: "1mb" }),
  (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    if (!verifyFlutterwaveWebhook(req.header("verif-hash") ?? undefined, rawBody)) {
      res.status(401).json({ ok: false, error: "Invalid webhook signature" });
      return;
    }
    let event: {
      id?: string;
      event?: string;
      data?: Record<string, unknown>;
    };
    try {
      event = JSON.parse(
        Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "{}"
      );
    } catch {
      res.status(400).json({ ok: false, error: "Invalid webhook payload" });
      return;
    }
    const eventKey = String(
      event.id ??
        `${event.event}:${event.data?.id ?? event.data?.tx_ref ?? event.data?.reference ?? Date.now()}`
    );
    if (!providerEvents.some((item) => item.provider === "flutterwave" && item.eventKey === eventKey)) {
      const record = {
        provider: "flutterwave" as const,
        eventKey,
        event,
        receivedAt: new Date().toISOString(),
      };
      providerEvents.push(record);
      const data = event.data ?? {};
      const txRef = String(data.tx_ref ?? data.reference ?? "");
      const amount = Number(data.amount ?? 0);
      const currency = String(data.currency ?? "NGN");
      const status = String(data.status ?? "").toLowerCase();
      const success = status === "successful" || status === "success";
      const providerReference = String(data.id ?? data.flw_ref ?? txRef);

      if (success) {
        const walletTx = walletTransactions.find((t) => t.txRef === txRef && t.type === "DEPOSIT");
        if (walletTx) {
          if (walletTx.status !== "COMPLETED" && walletTx.status !== "SUCCESSFUL") {
            if (currency === "NGN" && amount > 0) {
              const wallet = wallets.find((w) => w.id === walletTx.walletId);
              if (wallet) {
                const amountMinor = Math.round(amount * 100);
                wallet.pendingDepositMinor = Math.max(0, wallet.pendingDepositMinor - amountMinor);
                appendLedger(wallet, {
                  entryType: "FUNDING",
                  referenceId: walletTx.id,
                  amountMinor,
                  direction: "CREDIT",
                  description: `Wallet funding via Flutterwave ${providerReference}`,
                  metadata: {
                    provider: "flutterwave",
                    providerReference,
                    txRef,
                    eventType: event.event,
                  },
                });
              }
            }
            walletTx.status = "SUCCESSFUL";
            walletTx.providerReference = providerReference;
            walletTx.updatedAt = new Date().toISOString();
          }
        }

        const repayment = repayments.find((p) => p.txRef === txRef);
        if (repayment && repayment.status !== "SUCCESSFUL") {
          repayment.status = "SUCCESSFUL";
          repayment.providerReference = providerReference;
          repayment.verifiedAt = new Date().toISOString();
          repayment.updatedAt = repayment.verifiedAt;
          const loan = loans.find((l) => l.id === repayment.loanId);
          if (loan) {
            const dueAt = loan.dueAt ? new Date(loan.dueAt) : null;
            const onTime = dueAt ? new Date(repayment.verifiedAt) <= dueAt : true;
            repayment.onTime = onTime;
            const principalPortion = Math.min(
              Number(loan.outstandingNaira ?? loan.principalNaira ?? 0),
              Number(repayment.amountNaira)
            );
            const interestPortion = Math.max(
              0,
              Number(repayment.amountNaira) - principalPortion
            );
            repayment.principalNaira = Math.round(principalPortion * 100) / 100;
            repayment.interestNaira = Math.round(interestPortion * 100) / 100;
            loan.outstandingNaira =
              Math.round(
                Math.max(
                  0,
                  Number(loan.outstandingNaira ?? loan.totalRepaymentNaira ?? 0) -
                    Number(repayment.amountNaira)
                ) * 100
              ) / 100;
            if (Number(loan.outstandingNaira) <= 0.01) {
              loan.status = "REPAID";
              loan.paidAt = new Date().toISOString();
              creditHistory.push({
                id: crypto.randomUUID(),
                userId: loan.borrowerId,
                loanId: loan.id,
                repaymentId: repayment.id,
                eventType: "LOAN_REPAID",
                detail: `Loan ${loan.id} fully repaid`,
                occurredAt: new Date().toISOString(),
                createdAt: new Date().toISOString(),
              });
            } else {
              loan.status = onTime ? "ACTIVE" : "PAST_DUE";
            }
            creditHistory.push({
              id: crypto.randomUUID(),
              userId: repayment.borrowerId,
              loanId: repayment.loanId,
              repaymentId: repayment.id,
              eventType: onTime ? "REPAYMENT_VERIFIED" : "REPAYMENT_LATE",
              detail: `Repayment of ₦${Number(repayment.amountNaira).toLocaleString("en-NG")} recorded`,
              occurredAt: new Date().toISOString(),
              createdAt: new Date().toISOString(),
            });
            loan.updatedAt = new Date().toISOString();
          }
        }

        const transferRef = String(data.reference ?? "");
        const transfer = data as { reference?: string; id?: string; flw_ref?: string };
        const disbursementLoan = loans.find(
          (l) =>
            l.providerTransfer &&
            (l.providerTransfer as { data?: { reference?: string } }).data?.reference === transferRef
        );
        if (disbursementLoan) {
          disbursementLoan.status = "DISBURSED";
          disbursementLoan.providerReference = String(transfer.id ?? transfer.flw_ref ?? transferRef);
          disbursementLoan.disbursedAt = new Date().toISOString();
          disbursementLoan.updatedAt = disbursementLoan.disbursedAt;
          creditHistory.push({
            id: crypto.randomUUID(),
            userId: disbursementLoan.borrowerId,
            loanId: disbursementLoan.id,
            eventType: "LOAN_DISBURSED",
            detail: `Disbursement confirmed via provider ${disbursementLoan.providerReference}`,
            occurredAt: new Date().toISOString(),
            createdAt: new Date().toISOString(),
          });
        }
        const payout = payouts.find(
          (p) =>
            p.providerTransfer &&
            (p.providerTransfer as { data?: { reference?: string } }).data?.reference === transferRef
        );
        if (payout) {
          payout.status = "SUCCESSFUL";
          payout.providerReference = String(transfer.id ?? transfer.flw_ref ?? transferRef);
          payout.updatedAt = new Date().toISOString();
          const investment = investments.find((i) => i.id === payout.investmentId);
          if (investment) {
            investment.status = "PAID_OUT";
            investment.updatedAt = new Date().toISOString();
            if (investment.planId || true) {
              const wallet = findWallet(payout.userId);
              const amountMinor = Math.round(Number(payout.amountNaira ?? 0) * 100);
              appendLedger(wallet, {
                entryType: "INVESTMENT_RETURN",
                referenceId: investment.id,
                amountMinor,
                direction: "CREDIT",
                description: `Investment payout ${payout.id}`,
                metadata: {
                  provider: "flutterwave",
                  providerReference: payout.providerReference,
                  payoutType: payout.payoutType,
                },
              });
            }
          }
        }
      } else if (status === "failed") {
        const walletTx = walletTransactions.find((t) => t.txRef === txRef && t.type === "DEPOSIT");
        if (walletTx) {
          walletTx.status = "FAILED";
          walletTx.updatedAt = new Date().toISOString();
          const wallet = wallets.find((w) => w.id === walletTx.walletId);
          if (wallet) {
            const amountMinor = Math.round(Number(amount) * 100);
            wallet.pendingDepositMinor = Math.max(0, wallet.pendingDepositMinor - amountMinor);
          }
        }
        const repayment = repayments.find((p) => p.txRef === txRef);
        if (repayment) {
          repayment.status = "FAILED";
          repayment.updatedAt = new Date().toISOString();
        }
      }
    }
    res.status(202).json({ ok: true, accepted: true, eventKey });
  }
);

app.get("/api/v1/webhooks/prembly", (req, res) => {
  res.status(200).json({ ok: true, service: "Prembly webhook endpoint" });
});
app.post(
  "/api/v1/webhooks/prembly",
  express.raw({ type: "application/json", limit: "1mb" }),
  (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    const signature = req.header("x-prembly-signature") ?? req.header("signature") ?? undefined;
    if (!verifyPremblyWebhook(signature, rawBody)) {
      res.status(401).json({ ok: false, error: "Invalid Prembly webhook signature" });
      return;
    }
    let event: Record<string, unknown>;
    try {
      event = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      event = {};
    }
    providerEvents.push({
      provider: "prembly",
      eventKey: String((event as { id?: string }).id ?? `prembly-${Date.now()}`),
      event,
      receivedAt: new Date().toISOString(),
    });
    res.status(202).json({ ok: true, accepted: true });
  }
);

app.get("/api/v1/webhooks/kudi", (_req, res) => {
  res.status(200).json({ ok: true, service: "Kudi webhook endpoint" });
});
app.post(
  "/api/v1/webhooks/kudi",
  express.raw({ type: "application/json", limit: "1mb" }),
  (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    const signature = req.header("x-kudi-signature") ?? req.header("signature") ?? undefined;
    if (!verifyKudiSignature(signature, rawBody)) {
      res.status(401).json({ ok: false, error: "Invalid Kudi webhook signature" });
      return;
    }
    let event: Record<string, unknown>;
    try {
      event = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      event = {};
    }
    providerEvents.push({
      provider: "kudi",
      eventKey: String((event as { message_id?: string }).message_id ?? `kudi-${Date.now()}`),
      event,
      receivedAt: new Date().toISOString(),
    });
    res.status(202).json({ ok: true, accepted: true });
  }
);

app.get("/api/v1/webhooks/meta-whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (
    mode === "subscribe" &&
    token &&
    token === env.META_WHATSAPP_VERIFY_TOKEN &&
    typeof challenge === "string"
  ) {
    res.status(200).send(challenge);
    return;
  }
  res.status(403).json({ ok: false, error: "Webhook verification failed" });
});
app.post(
  "/api/v1/webhooks/meta-whatsapp",
  express.raw({ type: "application/json", limit: "1mb" }),
  (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    if (!verifyMetaWebhookSignature(req.header("x-hub-signature-256") ?? undefined, rawBody)) {
      res.status(401).json({ ok: false, error: "Invalid webhook signature" });
      return;
    }
    let event: Record<string, unknown>;
    try {
      event = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      event = {};
    }
    providerEvents.push({
      provider: "meta",
      eventKey: `meta-${Date.now()}-${Math.random()}`,
      event,
      receivedAt: new Date().toISOString(),
    });
    res
      .status(202)
      .json({ ok: true, accepted: true, message: "Webhook accepted for idempotent processing" });
  }
);

app.use(express.json({ limit: "1mb" }));

app.get("/health", async (_req, res) => {
  try {
    const database = await databaseHealth();
    res.json({
      ok: true,
      service: "velo-api",
      database,
      time: new Date().toISOString(),
    });
  } catch {
    res.status(503).json({
      ok: false,
      service: "velo-api",
      database: "unreachable",
    });
  }
});

app.get("/api/v1", (_req, res) => {
  res.json({
    ok: true,
    service: "velo-api",
    version: "v1",
    documentation: "/docs",
  });
});
app.use("/docs", swaggerUi.serve, swaggerUi.setup(openapi));
app.get("/openapi.json", (_req, res) => res.json(openapi));
app.use("/api/v1", apiRouter);

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: "Route not found" });
});

async function start(): Promise<void> {
  try {
    console.log("Initializing database schema...");
    const schema = await ensureDatabaseSchema();
    console.log("Loading persisted application state...");
    await initializeStore();
    seedInvestmentPlans();
    seedLoanProducts();
    await persistStore();
    console.log("Database initialization complete.");
    app.listen(env.API_PORT, () => {
      const databaseMessage = schema === "created"
        ? "schema initialized"
        : "schema skipped (DATABASE_URL is not configured)";
      console.log(`Velo API: ${env.API_PUBLIC_URL}/api/v1`);
      console.log(`Swagger UI: ${env.API_PUBLIC_URL}/docs`);
      console.log(`Health check: ${env.API_PUBLIC_URL}/health`);
      console.log(`Database: ${databaseMessage}`);
      void runRepaymentReminderSweep();
      void runInvestmentMaturitySweep();
      setInterval(() => {
        void runRepaymentReminderSweep();
        void runInvestmentMaturitySweep();
      }, 60 * 60 * 1000).unref();
    });
  } catch (error) {
    console.error("Database schema initialization failed", error);
    process.exitCode = 1;
  }
}

void start();
