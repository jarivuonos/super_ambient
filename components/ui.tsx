"use client";

import type { ReactNode } from "react";

export function ErrorBox({ title, message, detail, tone = "error" }: { title: string; message?: string; detail?: unknown; tone?: "error" | "warn" | "info" }) {
  const styles = {
    error: "border-red-300 bg-red-50 text-red-900",
    warn: "border-amber-300 bg-amber-50 text-amber-900",
    info: "border-sky-300 bg-sky-50 text-sky-900",
  }[tone];
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`rounded-md border px-3 py-2 text-sm ${styles}`}>
      <p className="font-medium">{title}</p>
      {message && <p className="mt-0.5 whitespace-pre-wrap">{message}</p>}
      {detail !== undefined && detail !== null && (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs opacity-80">Tekniset lisätiedot</summary>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs">{typeof detail === "string" ? detail : JSON.stringify(detail, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}

export function Badge({ children, tone = "neutral", title }: { children: ReactNode; tone?: "neutral" | "good" | "warn" | "bad" | "info"; title?: string }) {
  const styles = {
    neutral: "bg-zinc-100 text-zinc-700 border-zinc-200",
    good: "bg-emerald-50 text-emerald-800 border-emerald-200",
    warn: "bg-amber-50 text-amber-900 border-amber-200",
    bad: "bg-red-50 text-red-800 border-red-200",
    info: "bg-sky-50 text-sky-800 border-sky-200",
  }[tone];
  return (
    <span title={title} className={`inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-0.5 text-xs font-medium ${styles}`}>
      {children}
    </span>
  );
}

export function Button({
  children,
  onClick,
  disabled,
  variant = "secondary",
  type = "button",
  title,
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  type?: "button" | "submit";
  title?: string;
  className?: string;
}) {
  const styles = {
    primary: "bg-teal-700 text-white hover:bg-teal-800 border-teal-700",
    secondary: "bg-white text-zinc-800 hover:bg-zinc-50 border-zinc-300",
    danger: "bg-white text-red-700 hover:bg-red-50 border-red-300",
    ghost: "bg-transparent text-zinc-700 hover:bg-zinc-100 border-transparent",
  }[variant];
  return (
    <button
      type={type}
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md border px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${styles} ${className}`}
    >
      {children}
    </button>
  );
}

export function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-zinc-900">{title}</h2>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export function JsonDetails({ summary, value }: { summary: string; value: unknown }) {
  return (
    <details className="rounded border border-zinc-200 bg-zinc-50 px-2 py-1 text-xs">
      <summary className="cursor-pointer text-zinc-700">{summary}</summary>
      <pre className="mt-1 max-h-96 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "–";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("fi-FI");
}
