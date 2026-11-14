import { useEffect, useState, type FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";

type Mode = "login" | "signup" | "forgot";

export default function AuthGate({
  children
}: {
  children: React.ReactNode
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<Mode>("signup");
  const [recovery, setRecovery] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;

    const { data: { subscription } } =
      supabase.auth.onAuthStateChange((event, current) => {
        if (!active) return;
        setSession(current);
        if (event === "PASSWORD_RECOVERY") {
          setRecovery(true);
        }
        if (event === "SIGNED_OUT") {
          setProfileOpen(false);
          setRecovery(false);
        }
        setLoading(false);
      });

    supabase.auth.getSession().then(({ data, error }) => {
      if (!active) return;
      if (error) setError(error.message);
      setSession(data.session);
      setLoading(false);
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get("email") || "").trim();
    const password = String(form.get("password") || "");
    const name = String(form.get("name") || "").trim();

    setBusy(true);
    setMessage("");
    setError("");

    try {
      if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: { full_name: name },
            emailRedirectTo:
              window.location.origin + window.location.pathname,
          },
        });
        if (error) throw error;
        if (!data.session) {
          setMessage(
            "Check your email to confirm your account, then log in."
          );
        } else {
          setMessage("Account created successfully!");
        }
      } else if (mode === "login") {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (error) throw error;
      } else {
        const { error } = await supabase.auth.resetPasswordForEmail(
          email,
          {
            redirectTo:
              window.location.origin + window.location.pathname,
          }
        );
        if (error) throw error;
        setMessage(
          "If this email has an account, a reset link will be sent."
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  const updateProfile = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const name = String(form.get("name") || "").trim();
    if (!name) return;

    setBusy(true);
    setError("");
    try {
      const { error } = await supabase.auth.updateUser({
        data: { full_name: name }
      });
      if (error) throw error;
      setMessage("Profile updated!");
      setProfileOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusy(false);
    }
  };

  const updatePassword = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const password = String(form.get("password") || "");

    setBusy(true);
    setError("");
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      setRecovery(false);
      setMessage("Password updated successfully.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Password update failed");
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <main className="auth-page">Loading OurViaggio...</main>;
  }

  if (recovery && session) {
    return (
      <main className="auth-page">
        <div className="auth-card">
          <h1>Set a new password</h1>
          {error && <p className="auth-error">{error}</p>}
          <form onSubmit={updatePassword}>
            <label>New password
              <input name="password" type="password"
                minLength={8} required autoComplete="new-password" />
            </label>
            <button className="auth-primary" disabled={busy}>
              Update password
            </button>
          </form>
        </div>
      </main>
    );
  }

  if (!session) {
    return (
      <main className="auth-page">
        <div className="auth-card">
          <div className="auth-heading">
            <img src="/ourviaggio-icon.png" alt="" />
            <h1>OurViaggio</h1>
            <p>Your group adventure, all in one place.</p>
          </div>

          <div className="auth-tabs">
            <button className={mode === "signup" ? "chosen" : ""}
              onClick={() => { setMode("signup"); setError(""); setMessage(""); }}>
              Sign up
            </button>
            <button className={mode === "login" ? "chosen" : ""}
              onClick={() => { setMode("login"); setError(""); setMessage(""); }}>
              Log in
            </button>
          </div>

          <h2>
            {mode === "signup" ? "Create your account"
              : mode === "login" ? "Welcome back"
              : "Reset your password"}
          </h2>

          {message && <p className="auth-success">{message}</p>}
          {error && <p className="auth-error">{error}</p>}

          <form onSubmit={submit}>
            {mode === "signup" && (
              <label>Full name
                <input name="name" required
                  maxLength={80} autoComplete="name"
                  placeholder="Your full name" />
              </label>
            )}
            <label>Email
              <input name="email" type="email" required
                autoComplete="email" placeholder="you@example.com" />
            </label>
            {mode !== "forgot" && (
              <label>Password
                <input name="password" type="password" required
                  minLength={mode === "signup" ? 8 : 1}
                  autoComplete={mode === "signup"
                    ? "new-password" : "current-password"}
                  placeholder="Your password" />
              </label>
            )}
            <button className="auth-primary" disabled={busy}>
              {busy ? "Please wait..."
                : mode === "signup" ? "Create account"
                : mode === "login" ? "Log in"
                : "Send reset link"}
            </button>
          </form>

          <button className="auth-link"
            onClick={() => {
              setMode(mode === "forgot" ? "login" : "forgot");
              setError("");
              setMessage("");
            }}>
            {mode === "forgot" ? "Back to login" : "Forgot password?"}
          </button>
        </div>
      </main>
    );
  }

  const user = session.user;
  const displayName =
    String(user.user_metadata?.full_name || user.email || "Traveler");

  return (
    <div className="auth-app">
      <div className="auth-account-bar">
        <span>✈ OurViaggio · {displayName}</span>
        <button onClick={() => {
          setMessage("");
          setError("");
          setProfileOpen(true);
        }}>
          My profile
        </button>
        <button onClick={() => supabase.auth.signOut()}>
          Log out
        </button>
      </div>

      {children}

      {profileOpen && (
        <div className="auth-overlay" onClick={() => setProfileOpen(false)}>
          <div className="auth-card auth-profile"
            role="dialog" aria-modal="true" aria-label="My profile"
            onClick={e => e.stopPropagation()}>
            <button className="auth-close"
              aria-label="Close profile"
              onClick={() => setProfileOpen(false)}>×</button>
            <h2>My profile</h2>
            <p>{user.email}</p>
            {error && <p className="auth-error">{error}</p>}
            <form onSubmit={updateProfile}>
              <label>Display name
                <input name="name" key={displayName}
                  defaultValue={displayName}
                  maxLength={80} required />
              </label>
              <button className="auth-primary" disabled={busy}>
                Save profile
              </button>
            </form>
            <p className="auth-hint">
              Profile photos and contact details are coming next.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
