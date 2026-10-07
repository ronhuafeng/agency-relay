import { useLayoutEffect, useState } from "react";

export function useEnhanced(): boolean {
  const [enhanced, setEnhanced] = useState(false);
  useLayoutEffect(() => setEnhanced(true), []);
  return enhanced;
}
