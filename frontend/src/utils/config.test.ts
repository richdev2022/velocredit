import { describe, expect, it } from "vitest";
import { getEffectiveConfig } from "./config";

describe("loan configuration", () => {
  it("propagates global transaction limits to every loan program", () => {
    const config = getEffectiveConfig({
      loanLimits: { min: 200000, max: 12000000, defaultAmount: 750000 },
      loanPrograms: {
        PERSONAL: { loanLimits: { min: 1, max: 2, defaultAmount: 1 } },
        BUSINESS: { loanLimits: { min: 3, max: 4, defaultAmount: 3 } },
      },
    });

    expect(config.loanLimits).toEqual({ min: 200000, max: 12000000, defaultAmount: 750000 });
    expect(config.loanPrograms.PERSONAL.loanLimits).toEqual(config.loanLimits);
    expect(config.loanPrograms.BUSINESS.loanLimits).toEqual(config.loanLimits);
  });

  it("keeps per-program fee overrides independent", () => {
    const config = getEffectiveConfig({
      fees: { interest: { value: 4 } },
      loanPrograms: {
        PERSONAL: { fees: { interest: { value: 6 } } },
        BUSINESS: { fees: { interest: { value: 8 } } },
      },
    });

    expect(config.loanPrograms.PERSONAL.fees.interest.value).toBe(6);
    expect(config.loanPrograms.BUSINESS.fees.interest.value).toBe(8);
  });
});
