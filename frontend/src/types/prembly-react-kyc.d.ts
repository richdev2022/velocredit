declare module "prembly-react-kyc" {
  interface PremblyWidgetResponse {
    status?: string;
    code?: string;
    message?: string;
    data?: Record<string, unknown>;
  }

  interface PremblyWidgetOptions {
    first_name?: string;
    last_name?: string;
    email: string;
    phone?: string;
    widget_key: string;
    widget_id: string;
    metadata?: Record<string, string>;
    user_ref?: string;
    is_test?: string | boolean;
    callback: (response: PremblyWidgetResponse) => void;
  }

  export default function useIdentityPayKYC(options: PremblyWidgetOptions): () => void;
}
