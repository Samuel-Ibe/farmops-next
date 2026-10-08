import { useSyncExternalStore } from "react";

// Subscription never fires: hydration is a one-way client transition, so a
// constant snapshot is enough (react.dev/learn/you-might-not-need-an-effect).
const emptySubscribe = () => () => {};
const getClientSnapshot = () => true;
const getServerSnapshot = () => false;

/**
 * True after the browser has hydrated the component; false during SSR and the
 * first client render. Use it to gate UI that can only be correct once client
 * state (session, localStorage) is available — without a setState effect.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(emptySubscribe, getClientSnapshot, getServerSnapshot);
}
