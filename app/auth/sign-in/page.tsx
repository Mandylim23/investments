"use client";

import { FormEvent, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";

const CONFIRMATION_REDIRECT = "https://investments-five-self.vercel.app/auth/callback?next=/";
const ALLOWED_EMAIL_DOMAIN = "selangorproperties.com.my";

function isAllowedEmail(value: string) {
  const parts = value.trim().toLowerCase().split("@");
  return parts.length === 2 && parts[0].length > 0 && parts[1] === ALLOWED_EMAIL_DOMAIN;
}

export default function SignInPage() {
  const supabase = useMemo(() => createClient(), []);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [busy, setBusy] = useState(false);
  const [showResend, setShowResend] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    setShowResend(false);
    try {
      if (mode === "signup") {
        if (!isAllowedEmail(email)) {
          throw new Error(`Only @${ALLOWED_EMAIL_DOMAIN} email addresses can create an account.`);
        }
        const { error: authError } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: CONFIRMATION_REDIRECT },
        });
        if (authError) throw authError;
        setShowResend(true);
        setMessage("Check your email for a confirmation link. Open it in this browser, then sign in.");
      } else {
        const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
        if (authError) throw authError;
        window.location.assign("/");
      }
    } catch (authError) {
      const text = authError instanceof Error ? authError.message : "Could not authenticate.";
      setError(text);
      if (/not confirmed|confirm your email|email_not_confirmed/i.test(text)) setShowResend(true);
    } finally {
      setBusy(false);
    }
  }

  async function resendConfirmation() {
    if (!isAllowedEmail(email)) {
      setError(`Only @${ALLOWED_EMAIL_DOMAIN} email addresses can create an account.`);
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const { error: authError } = await supabase.auth.resend({
        type: "signup",
        email,
        options: { emailRedirectTo: CONFIRMATION_REDIRECT },
      });
      if (authError) throw authError;
      setMessage("A fresh confirmation link was sent. Open it in this browser, then sign in.");
    } catch (authError) {
      setError(authError instanceof Error ? authError.message : "Could not resend the confirmation email.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-screen">
      <section className="auth-card">
        <a className="brand" href="/">
          <span className="brand-mark">A</span>
          <span><b>Ledger</b><small>OFFSHORE FINANCE</small></span>
        </a>
        <div className="eyebrow">PRIVATE FINANCE WORKSPACE</div>
        <h1>{mode === "signin" ? "Sign in" : "Create your account"}</h1>
        <p className="auth-intro">Your uploaded bank and investment statements are private to your account.</p>
        {error && <div className="alert error"><b>!</b><span>{error}</span></div>}
        {message && <div className="alert success"><b>✓</b><span>{message}</span></div>}
        <form onSubmit={submit}>
          <label>Email address<input type="email" autoComplete="email" required value={email} onChange={event => setEmail(event.target.value)} /></label>
          {mode === "signup" && <p className="auth-intro">Account creation is limited to @{ALLOWED_EMAIL_DOMAIN} email addresses.</p>}
          <label>Password<input type="password" autoComplete={mode === "signin" ? "current-password" : "new-password"} minLength={8} required value={password} onChange={event => setPassword(event.target.value)} /></label>
          <button className="button primary wide" disabled={busy}>{busy ? "Please wait…" : mode === "signin" ? "Sign in" : "Create account"}</button>
        </form>
        {showResend && <button className="auth-switch" disabled={busy || !email} onClick={resendConfirmation}>Resend confirmation email</button>}
        <button className="auth-switch" onClick={() => { setMode(mode === "signin" ? "signup" : "signin"); setError(""); setMessage(""); setShowResend(false); }}>
          {mode === "signin" ? "New to Ledger? Create an account" : "Already registered? Sign in"}
        </button>
        <a className="auth-back" href="/">← Back to statement desk</a>
      </section>
    </main>
  );
}
