"use client";

import { useEffect } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
const MAX_VALUE_LENGTH = 512;

function trim(value: string | undefined): string | undefined {
  return value?.slice(0, MAX_VALUE_LENGTH);
}

export function CSPDiagnostics(): null {
  useEffect(() => {
    const report = (event: SecurityPolicyViolationEvent) => {
      const payload = {
        "csp-report": {
          "document-uri": trim(event.documentURI),
          "violated-directive": trim(event.violatedDirective),
          "effective-directive": trim(event.effectiveDirective),
          "original-policy": trim(event.originalPolicy),
          "blocked-uri": trim(event.blockedURI),
          "source-file": trim(event.sourceFile),
          "line-number": event.lineNumber,
          "column-number": event.columnNumber,
          disposition: "enforce",
        },
      };
      const body = JSON.stringify(payload);
      const endpoint = `${API_URL}/api/v1/csp-report`;

      if (navigator.sendBeacon) {
        navigator.sendBeacon(endpoint, new Blob([body], { type: "application/csp-report" }));
      } else {
        void fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/csp-report" },
          body,
          keepalive: true,
        }).catch(() => undefined);
      }
    };

    document.addEventListener("securitypolicyviolation", report);
    return () => document.removeEventListener("securitypolicyviolation", report);
  }, []);

  return null;
}
