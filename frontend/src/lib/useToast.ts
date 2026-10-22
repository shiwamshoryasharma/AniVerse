import { createContext, useContext } from 'react';

export interface Toast {
  id: number;
  level: 'info' | 'success' | 'warn' | 'error';
  message: string;
  action?: { label: string; run: () => void };
  sticky?: boolean;
}

export interface ToastApi {
  push(t: Omit<Toast, 'id'>): number;
  dismiss(id: number): void;
}

export const ToastContext = createContext<ToastApi>({ push: () => 0, dismiss: () => undefined });

export const useToast = () => useContext(ToastContext);
