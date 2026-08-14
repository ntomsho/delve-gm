/**
 * The furniture the six creation steps share.
 *
 * The design plan draws this flow on paper with a hard offset shadow — a sheet
 * lying on the desk, and buttons pressed into it. Tokens are `theme.ts`'s, so
 * the shadow is `--color-ink` rather than a black nobody chose.
 */

import type { ReactNode } from "react";

export const LABEL = "font-display text-[10px] tracking-[0.2em] text-graphite uppercase";
export const MONO_LABEL = "font-mono text-[10px] tracking-[0.16em] text-graphite uppercase";

const BASE =
  "font-display tracking-[0.1em] transition-colors disabled:cursor-not-allowed";

/**
 * Four weights, and they mean four different things:
 *
 * - `primary`   — the one commitment on the screen. Torchlight, and there is
 *                 never more than one visible at a time.
 * - `secondary` — a real action that changes the sheet. Raised off the paper.
 * - `dark`      — forward motion. Ink, flat, no shadow: continuing is not a
 *                 decision, it is just the next page.
 * - `ghost`     — going back, or leaving. Says nothing until you are near it.
 */
export type ButtonTone = "primary" | "secondary" | "dark" | "ghost";

const TONE: Record<ButtonTone, string> = {
  primary:
    "border border-ink bg-torch text-paper font-bold shadow-[3px_3px_0_var(--color-ink)] hover:bg-torch-deep disabled:border-rule disabled:bg-rule disabled:text-pencil disabled:shadow-none",
  secondary:
    "border border-ink bg-paper text-ink shadow-[2px_2px_0_var(--color-ink)] hover:bg-desk disabled:border-rule disabled:text-pencil disabled:shadow-none",
  dark:
    "border border-ink bg-ink text-paper hover:bg-graphite disabled:border-rule disabled:bg-rule disabled:text-pencil",
  ghost:
    "border border-rule bg-transparent text-graphite hover:border-ink hover:text-ink disabled:text-pencil disabled:hover:border-rule disabled:hover:text-pencil",
};

export function Button({
  tone = "secondary",
  className = "",
  ...rest
}: { tone?: ButtonTone } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={`${BASE} ${TONE[tone]} ${className}`} {...rest} />;
}

/** The two-way choice that heads Abilities and Equipment. */
export function Toggle<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex border border-ink">
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className={`font-display text-[12.5px] tracking-[0.1em] px-5 py-2.5 transition-colors ${
            i > 0 ? "border-l border-ink" : ""
          } ${o.value === value ? "bg-ink text-paper" : "bg-paper text-ink hover:bg-desk"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The reroll glyph, everywhere one appears. Disabled means the budget is spent
 * — plainly dead, with the reason on the title, and never a padlock.
 */
export function RerollGlyph({
  onClick,
  disabled,
  title,
  label,
}: {
  onClick: () => void;
  disabled?: boolean;
  title: string;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={label}
      className="font-mono text-[13px] leading-none -m-1 p-1 text-graphite transition-colors hover:text-torch disabled:cursor-not-allowed disabled:text-rule disabled:hover:text-rule"
    >
      ↻
    </button>
  );
}

export function StepHeading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div>
      <h2 className="font-prose text-[38px] font-semibold leading-tight text-ink">{title}</h2>
      {children ? (
        <p className="mt-1.5 max-w-[58ch] font-prose text-[17px] leading-relaxed text-graphite">
          {children}
        </p>
      ) : null}
    </div>
  );
}

/** A signed bonus, the way a sheet writes one. */
export const signed = (n: number) => `${n >= 0 ? "+" : ""}${n}`;
