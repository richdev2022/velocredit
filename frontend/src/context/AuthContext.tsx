import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  clearAccessToken,
  getAccessToken,
  getCurrentUser,
  login as apiLogin,
  register as apiRegister,
  addUserRole as apiAddUserRole,
  requestPasswordReset as apiRequestPasswordReset,
  confirmPasswordReset as apiConfirmPasswordReset,
  type Role,
  type RegisterInput,
  type RegistrationResponse,
  type SessionUser,
  verifyRegistrationOtp as apiVerifyRegistrationOtp,
  loginStepUpVerifyOtp as apiLoginStepUpVerifyOtp,
  type LoginOtpRequired,
  type LoginStepUpRequired,
} from "../services/apiClient";

type LoginResult = SessionUser | LoginOtpRequired | LoginStepUpRequired;

interface AuthContextValue {
  user: SessionUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<LoginResult>;
  register: (input: Omit<RegisterInput, "consents"> & { consents?: RegisterInput["consents"] }) => Promise<RegistrationResponse>;
  verifyRegistrationOtp: (input: { userId: string; challengeId: string; code: string }) => Promise<SessionUser>;
  completeLoginOtp: (challengeId: string, code: string) => Promise<SessionUser>;
  logout: () => void;
  addUserRole: (role: Exclude<Role, "ADMIN">) => Promise<SessionUser>;
  requestPasswordReset: (email: string) => Promise<{ ok: true; resetId?: string; message: string }>;
  confirmPasswordReset: (resetId: string, token: string, newPassword: string) => Promise<{ ok: true }>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(Boolean(getAccessToken()));

  useEffect(() => {
    if (!getAccessToken()) {
      setLoading(false);
      return;
    }
    getCurrentUser()
      .then((response) => setUser(response.user))
      .catch(clearAccessToken)
      .finally(() => setLoading(false));
  }, []);

  async function refreshUser() {
    if (!getAccessToken()) return;
    try {
      const response = await getCurrentUser();
      setUser(response.user);
    } catch {
      clearAccessToken();
      setUser(null);
    }
  }

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      async login(email, password) {
        const response = await apiLogin({ email, password });
        if ("requiresOtp" in response && response.requiresOtp) return response as LoginOtpRequired | LoginStepUpRequired;
        const success = response as { user: SessionUser };
        setUser(success.user);
        return success.user;
      },
      async register(input) {
        const consents = input.consents ?? {
          terms: true,
          privacy: true,
          identityVerification: true,
          electronicCommunications: true,
        };
        return apiRegister({
          email: input.email,
          phone: input.phone,
          fullName: input.fullName,
          password: input.password,
          role: input.role,
          preferredOtpChannel: input.preferredOtpChannel,
          consents,
        });
      },
      async verifyRegistrationOtp(input) {
        const response = await apiVerifyRegistrationOtp(input);
        setUser(response.user);
        return response.user;
      },
      async completeLoginOtp(challengeId, code) {
        const response = await apiLoginStepUpVerifyOtp(challengeId, code);
        setUser(response.user);
        return response.user;
      },
      logout() {
        clearAccessToken();
        setUser(null);
      },
      async addUserRole(role) {
        const response = await apiAddUserRole(role);
        setUser(response.user);
        return response.user;
      },
      async requestPasswordReset(email) {
        return apiRequestPasswordReset(email);
      },
      async confirmPasswordReset(resetId, token, newPassword) {
        return apiConfirmPasswordReset(resetId, token, newPassword);
      },
      refreshUser,
    }),
    [loading, user]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}
