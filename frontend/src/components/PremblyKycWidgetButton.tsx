import useIdentityPayKYC from "prembly-react-kyc";
import { useMemo } from "react";
import { completePremblyWidgetVerification } from "../services/apiClient";

interface Props {
  fullName?: string;
  email?: string;
  phone?: string;
  idType: "BVN" | "NIN";
  idNumber: string;
  onResult: (result: { success: boolean; message: string }) => void;
}

export default function PremblyKycWidgetButton({ fullName, email, phone, idType, idNumber, onResult }: Props) {
  const [firstName = "", ...lastNames] = (fullName ?? "").trim().split(/\s+/);
  const widgetId = import.meta.env.VITE_PREMBLY_WIDGET_ID;
  const widgetKey = import.meta.env.VITE_PREMBLY_WIDGET_KEY;
  const verifyWithPrembly = useIdentityPayKYC(useMemo(() => ({
    first_name: firstName,
    last_name: lastNames.join(" "),
    email: email ?? "",
    phone,
    widget_key: widgetKey ?? "",
    widget_id: widgetId ?? "",
    metadata: { id_type: idType, id_number: idNumber },
    callback: (response: { status?: string; code?: string; message?: string; data?: Record<string, unknown> }) => {
      const success = response.status === "success" || response.code === "00";
      void completePremblyWidgetVerification({
        status: success ? "SUCCESS" : "FAILED",
        providerReference: typeof response.data?.reference === "string" ? response.data.reference : undefined,
        rawResponse: response.data,
      }).then(() => onResult({ success, message: success ? "Prembly verification completed." : response.message ?? "Prembly verification was not completed." }))
        .catch((error) => onResult({ success: false, message: error instanceof Error ? error.message : "Unable to save Prembly verification." }));
    },
  }), [email, firstName, idNumber, idType, lastNames, phone, widgetId, widgetKey]));

  if (!widgetId || !widgetKey || !/^\d{11}$/.test(idNumber)) return null;
  return <button type="button" className="btn-secondary text-xs" onClick={verifyWithPrembly}>Verify identity with Prembly camera</button>;
}