"use client";

import { useState, useEffect } from "react";
import { useAuth } from "@/lib/auth";

interface AuthModalProps {
  open: boolean;
  onClose: () => void;
  initialMode?: "login" | "signup";
}

type Mode = "login" | "signup" | "forgot";

export function AuthModal({ open, onClose, initialMode = "login" }: AuthModalProps) {
  const { signIn, signUp, signInWithProvider, resetPassword, isLoading: authLoading } = useAuth();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setMode(initialMode);
      setEmail("");
      setPassword("");
      setConfirmPassword("");
      setError("");
      setMessage("");
    }
  }, [open, initialMode]);

  if (!open) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setMessage("");
    setSubmitting(true);

    try {
      if (mode === "login") {
        const result = await signIn(email, password);
        if (result.error) {
          setError(result.error);
        } else {
          onClose();
        }
      } else if (mode === "signup") {
        if (password !== confirmPassword) {
          setError("两次输入的密码不一致");
          return;
        }
        if (password.length < 6) {
          setError("密码至少需要 6 位");
          return;
        }
        const result = await signUp(email, password);
        if (result.error) {
          setError(result.error);
        } else if (result.needsConfirmation) {
          setMessage("注册成功！请查收邮件确认您的账号。");
        } else {
          onClose();
        }
      } else if (mode === "forgot") {
        const result = await resetPassword(email);
        if (result.error) {
          setError(result.error);
        } else {
          setMessage("重置密码链接已发送到您的邮箱，请查收。");
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败，请重试");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleProviderLogin(provider: "github" | "google") {
    setError("");
    try {
      await signInWithProvider(provider);
    } catch (e) {
      setError(e instanceof Error ? e.message : "登录失败");
    }
  }

  const title =
    mode === "login" ? "登录" : mode === "signup" ? "注册账号" : "重置密码";

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal auth-modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="关闭">
          ×
        </button>
        <h2>{title}</h2>

        {mode !== "forgot" && (
          <div className="auth-providers">
            <button
              type="button"
              className="btn-provider"
              onClick={() => void handleProviderLogin("github")}
              disabled={submitting}
            >
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
                <path
                  fill="currentColor"
                  d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"
                />
              </svg>
              使用 GitHub 登录
            </button>
            <button
              type="button"
              className="btn-provider"
              onClick={() => void handleProviderLogin("google")}
              disabled={submitting}
            >
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
                <path
                  fill="#EA4335"
                  d="M12 10.2v3.9h5.5c-.2 1.4-1.6 4.1-5.5 4.1-3.3 0-6-2.7-6-6.1s2.7-6.1 6-6.1c1.9 0 3.2.8 3.9 1.5l2.7-2.6C16.9 3.2 14.7 2.2 12 2.2 6.5 2.2 2 6.7 2 12.1s4.5 9.9 10 9.9c5.8 0 9.6-4.1 9.6-9.8 0-.7-.1-1.2-.2-1.7H12z"
                />
              </svg>
              使用 Google 登录
            </button>
          </div>
        )}

        {mode !== "forgot" && (
          <div className="auth-divider">
            <span>或使用邮箱</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="auth-form">
          <div className="form-group">
            <label htmlFor="email">邮箱</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="your@email.com"
              required
              disabled={submitting}
              autoComplete="email"
            />
          </div>

          {mode !== "forgot" && (
            <div className="form-group">
              <label htmlFor="password">密码</label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === "signup" ? "至少 6 位" : "请输入密码"}
                required
                disabled={submitting}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
              />
            </div>
          )}

          {mode === "signup" && (
            <div className="form-group">
              <label htmlFor="confirmPassword">确认密码</label>
              <input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="再次输入密码"
                required
                disabled={submitting}
                autoComplete="new-password"
              />
            </div>
          )}

          {error && <p className="form-error">{error}</p>}
          {message && <p className="form-success">{message}</p>}

          <button type="submit" className="btn-primary btn-full" disabled={submitting || authLoading}>
            {submitting ? "处理中…" : mode === "login" ? "登录" : mode === "signup" ? "注册" : "发送重置链接"}
          </button>
        </form>

        <div className="auth-footer">
          {mode === "login" && (
            <>
              <button type="button" className="link-btn" onClick={() => setMode("forgot")}>
                忘记密码？
              </button>
              <span>
                还没有账号？{" "}
                <button type="button" className="link-btn" onClick={() => setMode("signup")}>
                  立即注册
                </button>
              </span>
            </>
          )}
          {mode === "signup" && (
            <span>
              已有账号？{" "}
              <button type="button" className="link-btn" onClick={() => setMode("login")}>
                去登录
              </button>
            </span>
          )}
          {mode === "forgot" && (
            <button type="button" className="link-btn" onClick={() => setMode("login")}>
              返回登录
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
