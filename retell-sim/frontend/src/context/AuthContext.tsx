import { createContext, useContext } from "react";
import type { AuthUser } from "../api";

export interface AuthState {
  user: AuthUser | null;
  signOut: () => void;
}

export const AuthContext = createContext<AuthState>({ user: null, signOut: () => {} });
export const useAuth = () => useContext(AuthContext);
