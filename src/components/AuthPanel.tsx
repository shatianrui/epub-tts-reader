"use client";

import { useState, useEffect } from "react";
import { useAuth } from "@/lib/auth";

interface AuthPanelProps {
  open: boolean;
  onClose: () => void;
  initialMode?: "login" | "signup";
}

type Mode = "login" | "signup" | "forgot";

export function AuthPanel({
  open,
  onClose,
  initialMode = "login",
}: AuthPanelProps) {
  const { signIn, signUp, resetPassword, isLoading: authLoading, configured } =
    useAuth();
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
      if (!configured) {
        setError("未配置云端（缺少 Supabase 环境变量）");
        return;
      }

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
          setMessage("注册成功！请查收邮件确认账号后再登录。");
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
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败，请重试");
    } finally {
      setSubmitting(false);
    }
  }

  const title =
    mode === "login" ? "登录" : mode === "signup" ? "注册账号" : "重置密码";

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal auth-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-title"
      >
        <button
          type="button"
          className="modal-close"
          onClick={onClose}
          aria-label="关闭"
        >
          ×
        </button>
        <h2 id="auth-title">{title}</h2>
        <p className="auth-hint">
          登录后，电子书、阅读进度与 MiniMax 设置将同步到云端。
        </p>

        <form onSubmit={(e) => void handleSubmit(e)} className="auth-form">
          <div className="form-group">
            <label htmlFor="auth-email">邮箱</label>
            <input
              id="auth-email"
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
              <label htmlFor="auth-password">密码</label>
              <input
                id="auth-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === "signup" ? "至少 6 位" : "请输入密码"}
                required
                disabled={submitting}
                autoComplete={
                  mode === "login" ? "current-password" : "new-password"
                }
              />
            </div>
          )}

          {mode === "signup" && (
            <div className="form-group">
              <label htmlFor="auth-confirm">确认密码</label>
              <input
                id="auth-confirm"
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

          <button
            type="submit"
            className="btn-primary btn-full"
            disabled={submitting || authLoading}
          >
            {submitting
              ? "处理中…"
              : mode === "login"
                ? "登录"
                : mode === "signup"
                  ? "注册"
                  : "发送重置链接"}
          </button>
        </form>

        <div className="auth-footer">
          {mode === "login" && (
            <>
              <button
                type="button"
                className="link-btn"
                onClick={() => setMode("forgot")}
              >
                忘记密码？
              </button>
              <span>
                还没有账号？{" "}
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => setMode("signup")}
                >
                  立即注册
                </button>
              </span>
            </>
          )}
          {mode === "signup" && (
            <span>
              已有账号？{" "}
              <button
                type="button"
                className="link-btn"
                onClick={() => setMode("login")}
              >
                去登录
              </button>
            </span>
          )}
          {mode === "forgot" && (
            <button
              type="button"
              className="link-btn"
              onClick={() => setMode("login")}
            >
              返回登录
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
