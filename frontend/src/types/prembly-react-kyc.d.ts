declare module "prembly-react-kyc" {
  interface PremblyWidgetResponse {
    status?: string | boolean;
    code?: string;
    message?: string;
    verification_status?: string;
    data?: Record<string, unknown>;
  }

  interface PremblyWidgetOptions {
    first_name?: string;
    last_name?: string;
    email?: string;
    phone?: string;
    widget_key: string;
    widget_id: string;
    merchant_key?: string;
    config_id?: string;
    metadata?: Record<string, string>;
    user_ref?: string;
    is_test?: string | boolean;
    callback: (response: PremblyWidgetResponse) => void;
  }

  export default function useIdentityPayKYC(options: PremblyWidgetOptions): () => void;
}
