import { QuickbooksClient } from "../clients/quickbooks-client.js";
import { ToolResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";

// QBO bill updates are a FULL overwrite (sparse:false): any field omitted from the
// payload is deleted server-side. Callers routinely omit line-level ClassRef and
// TaxCodeRef, which silently strips class/tax tracking and breaks class-based P&L.
// We avoid this by reading the current bill and merging the caller's changes over it.
const DETAIL_KEYS = [
  "AccountBasedExpenseLineDetail",
  "ItemBasedExpenseLineDetail",
] as const;

// Refs we assert survive the round-trip — the silent data loss this handler prevents.
const PRESERVED_REFS = ["ClassRef", "TaxCodeRef"] as const;

function mergeLine(currentLine: any, incomingLine: any): any {
  if (!currentLine) return incomingLine; // no Id match → new line, pass through as-is
  const merged: any = { ...currentLine, ...incomingLine };
  for (const key of DETAIL_KEYS) {
    if (currentLine[key] || incomingLine[key]) {
      // Merge nested detail so unspecified sub-refs (ClassRef/TaxCodeRef/...) survive,
      // while letting the caller override any field it does supply. Spreading an
      // absent side is a harmless no-op ({ ...undefined } === {}).
      merged[key] = { ...currentLine[key], ...incomingLine[key] };
    }
  }
  return merged;
}

function mergeBill(current: any, incoming: any): any {
  // Header: start from current, override only fields the caller supplied. Always write
  // with the freshest SyncToken; a stale caller token would 5010-conflict.
  const merged: any = { ...current, ...incoming, SyncToken: current.SyncToken };

  if (!Array.isArray(incoming.Line)) {
    merged.Line = current.Line; // header-only update — keep the existing lines verbatim
    return merged;
  }

  const currentById = new Map<string, any>();
  for (const line of current.Line) currentById.set(String(line.Id), line);
  merged.Line = incoming.Line.map((line: any) =>
    mergeLine(line.Id != null ? currentById.get(String(line.Id)) : undefined, line)
  );
  return merged;
}

// Any preserved ref that existed on a current line but is missing from the same-Id
// line after the write. Lines the caller intentionally removed are not flagged.
function findDroppedRefs(current: any, updated: any): string[] {
  const updatedById = new Map<string, any>();
  for (const line of updated.Line) updatedById.set(String(line.Id), line);

  const dropped: string[] = [];
  for (const cur of current.Line) {
    const upd = updatedById.get(String(cur.Id));
    if (!upd) continue; // line removed on purpose — not a regression
    for (const detailKey of DETAIL_KEYS) {
      const curDetail = cur[detailKey];
      if (!curDetail) continue;
      const updDetail = upd[detailKey] || {};
      for (const ref of PRESERVED_REFS) {
        if (curDetail[ref] && !updDetail[ref]) {
          dropped.push(`Line ${cur.Id}: ${ref}`);
        }
      }
    }
  }
  return dropped;
}

/**
 * Update a bill in QuickBooks Online using read-merge-write.
 *
 * Steps: (1) fetch the current bill, (2) merge the caller's changes over it so fields
 * they omit — notably line-level ClassRef/TaxCodeRef — survive the full overwrite,
 * (3) write, (4) verify no preserved ref was dropped, returning an error rather than a
 * misleading success if one was. Pass bill.Id plus only the fields to change.
 */
export async function updateQuickbooksBill(bill: any): Promise<ToolResponse<any>> {
  try {
    const quickbooks = await QuickbooksClient.getInstance();

    if (!bill?.Id) {
      return { result: null, isError: true, error: "update-bill requires bill.Id" };
    }

    const current = await new Promise<any>((resolve, reject) => {
      quickbooks.getBill(String(bill.Id), (err: any, b: any) =>
        err ? reject(err) : resolve(b)
      );
    });

    const merged = mergeBill(current, bill);

    const updated = await new Promise<any>((resolve, reject) => {
      quickbooks.updateBill(merged, (err: any, b: any) =>
        err ? reject(err) : resolve(b)
      );
    });

    const dropped = findDroppedRefs(current, updated);
    if (dropped.length > 0) {
      return {
        result: updated,
        isError: true,
        error:
          `Bill ${bill.Id} was updated but QuickBooks dropped these tracking fields: ` +
          `${dropped.join(", ")}. The bill's class/tax coding may now be wrong — ` +
          `investigate before relying on it.`,
      };
    }

    return { result: updated, isError: false, error: null };
  } catch (error) {
    return { result: null, isError: true, error: formatError(error) };
  }
}
