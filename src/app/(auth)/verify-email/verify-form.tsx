"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { MailCheck, Loader2, AlertCircle, CheckCircle2, RefreshCw } from "lucide-react";

const SIX_DIGITS = /^[0-9]{6}$/;

interface VerifyEmailFormProps {
  email?: string;
  /**
   * Only ever populated by the register route's local-dev fallback, which
   * itself only runs when SMTP is missing outside production. Prefilling it
   * spares a developer a second round-trip; it never carries a live code.
   */
  initialCode?: string;
}

export default function VerifyEmailForm({
  email: initialEmail = "",
  initialCode = "",
}: VerifyEmailFormProps) {
  const router = useRouter();
  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState(initialCode);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [resendNote, setResendNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess("");

    if (!SIX_DIGITS.test(code)) {
      setError("Enter the 6-digit code from your email");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/auth/verify-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code }),
      });

      const data: { error?: string; message?: string } = await res.json();

      if (!res.ok) {
        setError(data.error || "Verification failed. Please try again.");
        return;
      }

      setSuccess(data.message || "Email verified. You can sign in now.");
      setTimeout(() => router.push("/login"), 1200);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    setError("");
    setSuccess("");
    setResendNote("");
    setResending(true);

    try {
      const res = await fetch("/api/auth/resend-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      const data: { error?: string; message?: string; devCode?: string } =
        await res.json();

      if (!res.ok) {
        setError(data.error || "Could not send a new code. Please try again.");
        return;
      }

      // Server only includes `devCode` when SMTP is unavailable outside
      // production — surface it so a local sign-up isn't stranded.
      if (data.devCode) {
        setCode(data.devCode);
        setResendNote(`No SMTP configured, so your code is: ${data.devCode}`);
      } else {
        setResendNote(data.message ?? "");
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setResending(false);
    }
  };

  return (
    <Card>
      <CardHeader className="text-center">
        <div className="flex justify-center mb-2">
          <MailCheck className="h-10 w-10 text-green-600" />
        </div>
        <CardTitle className="text-2xl">Verify your email</CardTitle>
        <CardDescription>
          Enter the 6-digit code we sent to activate your account.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleVerify} className="space-y-4">
          {error && (
            <div
              role="alert"
              className="flex items-center gap-2 rounded-md bg-red-50 dark:bg-red-950 p-3 text-sm text-red-600 dark:text-red-400"
            >
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          {success && (
            <div
              role="status"
              className="flex items-center gap-2 rounded-md bg-green-50 dark:bg-green-950 p-3 text-sm text-green-600 dark:text-green-400"
            >
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              {success}
            </div>
          )}

          {resendNote && (
            <div className="rounded-md bg-muted p-3 text-sm text-muted-foreground">
              {resendNote}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="code">Verification code</Label>
            <Input
              id="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="000000"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, "").slice(0, 6))}
              className="text-center font-mono tracking-[0.5em]"
              required
            />
          </div>

          <Button type="submit" className="w-full" disabled={loading || success !== ""}>
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Verifying...
              </>
            ) : (
              "Verify email"
            )}
          </Button>

          <div className="flex items-center justify-between text-sm">
            <button
              type="button"
              onClick={handleResend}
              disabled={resending}
              className="inline-flex items-center gap-1 text-green-600 hover:underline disabled:opacity-50"
            >
              {resending ? (
                <RefreshCw className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
              Send a new code
            </button>

            <Link href="/login" className="text-muted-foreground hover:underline">
              Back to sign in
            </Link>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
