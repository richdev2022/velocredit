import { useEffect } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

export default function ResumeApplication() {
  const { user } = useAuth();

  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  if (user) {
    if (user.roles.includes("BORROWER")) {
      return <Navigate to="/apply" replace />;
    }
    if (user.roles.includes("INVESTOR")) {
      return <Navigate to="/investor" replace />;
    }
    return <Navigate to="/" replace />;
  }

  return (
    <Navigate
      to="/account?mode=login&redirect=%2Fapply"
      replace
    />
  );
}
