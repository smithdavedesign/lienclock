'use client';
// The browser side of the visit beacon (src/lib/signal.ts). Each piece renders nothing of its own.
import { useEffect, type ReactNode } from 'react';
import { sendSignal } from '@/lib/signal';

/** "visit" on the public pages, once per browser session. In the root layout, so on every page load. */
export function VisitBeacon({ publicPaths }: { publicPaths: readonly string[] }) {
  useEffect(() => {
    if (publicPaths.includes(window.location.pathname)) sendSignal('visit', window);
  }, [publicPaths]);
  return null;
}

/** "activate", once per browser: rendered with the calculator's result, the core action. */
export function ActivateBeacon() {
  useEffect(() => {
    sendSignal('activate', window);
  }, []);
  return null;
}

/** A link to the Stripe Payment Link that sends "checkout" when clicked. */
export function BuyLink({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  return (
    <a href={href} className={className} onClick={() => sendSignal('checkout', window)}>
      {children}
    </a>
  );
}
