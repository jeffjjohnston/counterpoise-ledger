"use client";

import { useState } from "react";
import { formatCurrency } from "@/lib/formatters";
import { Button } from "@/components/ui/Button";
import { apiPost, toMessage } from "@/lib/api-client";
import { useToast } from "@/components/ui/ToastProvider";
import type { PlaidLinkData } from "@/types";

interface PlaidBannerProps {
  plaidData: PlaidLinkData;
  bookId: string;
  transactionId: number;
  onUnlinked: () => void;
}

export function PlaidBanner({
  plaidData,
  bookId,
  transactionId,
  onUnlinked,
}: PlaidBannerProps) {
  const toast = useToast();
  const [expanded, setExpanded] = useState(false);
  const [showRawJson, setShowRawJson] = useState(false);
  const [unlinking, setUnlinking] = useState(false);

  const handleUnlink = async () => {
    if (
      !confirm(
        "Unlink this transaction from Plaid? It will appear as an unmatched Plaid transaction in the Sync page."
      )
    ) {
      return;
    }

    setUnlinking(true);
    try {
      await apiPost(`/api/b/${bookId}/transactions/${transactionId}/plaid/unlink`);
      onUnlinked();
    } catch (err) {
      toast.error(toMessage(err, "Failed to unlink from Plaid"));
    } finally {
      setUnlinking(false);
    }
  };

  const formattedAmount = formatCurrency(Math.abs(plaidData.amountCents));
  const amountDisplay =
    plaidData.amountCents < 0 ? `-${formattedAmount}` : formattedAmount;

  const detailFields: Array<{ label: string; value: string }> = [
    { label: "Name", value: plaidData.name },
    ...(plaidData.merchantName
      ? [{ label: "Merchant", value: plaidData.merchantName }]
      : []),
    { label: "Amount", value: amountDisplay },
    { label: "Date", value: plaidData.date },
    ...(plaidData.authorizedDate
      ? [{ label: "Authorized Date", value: plaidData.authorizedDate }]
      : []),
    { label: "Status", value: plaidData.pending ? "Pending" : "Posted" },
    ...(plaidData.categoryPrimary
      ? [
          {
            label: "Category",
            value: plaidData.categoryDetailed
              ? `${plaidData.categoryPrimary} › ${plaidData.categoryDetailed}`
              : plaidData.categoryPrimary,
          },
        ]
      : []),
    ...(plaidData.isoCurrencyCode
      ? [{ label: "Currency", value: plaidData.isoCurrencyCode }]
      : []),
    ...(plaidData.originalDescription
      ? [
          {
            label: "Original Description",
            value: plaidData.originalDescription,
          },
        ]
      : []),
    {
      label: "Plaid Transaction ID",
      value: plaidData.plaidTransactionId,
    },
  ];

  let prettyJson = plaidData.rawJson;
  try {
    prettyJson = JSON.stringify(JSON.parse(plaidData.rawJson), null, 2);
  } catch {
    // use raw string if not valid JSON
  }

  return (
    <div className="mb-4 rounded-lg border border-green-500/30 bg-green-500/10 p-3">
      <button
        type="button"
        className="flex w-full items-center justify-between"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2 text-sm">
          <span className="inline-block h-2 w-2 rounded-full bg-green-500" />
          <span className="font-medium">Linked to Plaid</span>
          {!expanded && (
            <span className="text-fg-secondary">
              · {plaidData.name} · {amountDisplay}
            </span>
          )}
        </div>
        <span className="text-xs text-fg-secondary">
          {expanded ? "▲ Collapse" : "Details ▼"}
        </span>
      </button>

      {expanded && (
        <div className="mt-3">
          <div className="grid grid-cols-2 gap-x-5 gap-y-2 text-sm">
            {detailFields.map((field) => (
              <div
                key={field.label}
                className={
                  field.label === "Original Description" ||
                  field.label === "Plaid Transaction ID"
                    ? "col-span-2"
                    : ""
                }
              >
                <div className="text-xs text-fg-tertiary">{field.label}</div>
                <div
                  className={
                    field.label === "Plaid Transaction ID"
                      ? "truncate font-mono text-xs"
                      : ""
                  }
                  title={
                    field.label === "Plaid Transaction ID"
                      ? field.value
                      : undefined
                  }
                >
                  {field.value}
                </div>
              </div>
            ))}
          </div>

          {showRawJson && (
            <pre className="mt-3 max-h-48 overflow-auto rounded bg-surface-alt p-2 text-xs">
              {prettyJson}
            </pre>
          )}

          <div className="mt-3 flex gap-2 border-t border-green-500/20 pt-3">
            <Button
              type="button"
              variant="secondary"
              className="text-xs"
              onClick={() => setShowRawJson(!showRawJson)}
            >
              {showRawJson ? "Hide Raw JSON" : "View Raw JSON"}
            </Button>
            <Button
              type="button"
              variant="danger"
              className="text-xs"
              onClick={handleUnlink}
              disabled={unlinking}
            >
              {unlinking ? "Unlinking..." : "Unlink from Plaid"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
