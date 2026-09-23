import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

let verifyTransactionWithRetry: typeof import("./flutterwave.js").verifyTransactionWithRetry;
let verifyTransferWithRetry: typeof import("./flutterwave.js").verifyTransferWithRetry;

describe("Flutterwave provider verification", () => {
  beforeAll(async () => {
    process.env.FLUTTERWAVE_SECRET_KEY = "test";
    ({ verifyTransactionWithRetry, verifyTransferWithRetry } = await import("./flutterwave.js"));
  });

  afterEach(() => vi.unstubAllGlobals());

  it("accepts a confirmed NGN checkout transaction", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: "success",
      data: { status: "successful", currency: "NGN", amount: 200, tx_ref: "wallet-1" },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await verifyTransactionWithRetry("123", 3, 0);

    expect(result.settled).toBe(true);
    expect(result.data).toMatchObject({ tx_ref: "wallet-1", amount: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not accept a failed transfer as successful", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: "success",
      data: { status: "failed", complete_message: "Insufficient balance" },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await verifyTransferWithRetry("456", "withdrawal-1", 3, 0);

    expect(result.settled).toBe(false);
    expect(result.status).toBe("failed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("Flutterwave transfer creation failure detail", () => {
  beforeAll(async () => {
    process.env.FLUTTERWAVE_SECRET_KEY = "test";
  });

  afterEach(() => vi.unstubAllGlobals());

  it("throws a FlutterwaveError carrying the full provider response so it can be persisted", async () => {
    const { createLoanDisbursement, FlutterwaveError } = await import("./flutterwave.js");
    const providerBody = { status: "error", code: "TRANSFER_CREATION", message: "Transfer creation failed" };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(providerBody), { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    let caught: unknown;
    try {
      await createLoanDisbursement({
        txRef: "VELO-DISBURSE-test-1",
        amountNaira: 200,
        accountNumber: "9164819320",
        accountBank: "999992",
        beneficiaryName: "Test User",
        narration: "smoke",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FlutterwaveError);
    const fwError = caught as InstanceType<typeof FlutterwaveError>;
    expect(fwError.message).toBe("Transfer creation failed");
    expect(fwError.httpStatus).toBe(400);
    expect(fwError.providerResponse).toMatchObject({ status: "error", message: "Transfer creation failed" });
  });
});
