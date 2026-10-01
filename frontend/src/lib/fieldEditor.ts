import { escapeHtml } from "./mailMerge";
import { splitFieldText } from "./fieldInsertion";

// Field labels use the same markup and styles as recipient placeholders.
export function fieldEditorHtml(
  value: string,
  removeLabel: string,
  readonly = false,
): string {
  let offset = 0;
  return splitFieldText(value)
    .map((segment) => {
      const start = offset;
      offset += segment.text.length;
      const text = escapeHtml(segment.text);
      if (!segment.field) return text;
      const remove = readonly
        ? ""
        : `<button type="button" class="recipient-token-remove" data-remove-field="${start}" aria-label="${escapeHtml(`${removeLabel} ${segment.text}`)}"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>`;
      return `<span class="recipient-token recipient-token-placeholder" contenteditable="false" data-field-token="${text}"><span class="recipient-token-value">${text}</span>${remove}</span>`;
    })
    .join("");
}

export function fieldEditorText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
  if (node instanceof HTMLElement && node.dataset.fieldToken !== undefined)
    return node.dataset.fieldToken;
  return Array.from(node.childNodes, fieldEditorText).join("");
}

export function fieldEditorSelection(
  root: HTMLElement,
): { start: number; end: number } | undefined {
  const selection = root.ownerDocument.getSelection();
  if (!selection?.rangeCount) return;
  const range = selection.getRangeAt(0);
  if (
    !root.contains(range.startContainer) ||
    !root.contains(range.endContainer)
  )
    return;
  const prefix = range.cloneRange();
  prefix.selectNodeContents(root);
  prefix.setEnd(range.startContainer, range.startOffset);
  const start = prefix.toString().length;
  return { start, end: start + range.toString().length };
}

export function setFieldEditorSelection(
  root: HTMLElement,
  start: number,
  end: number,
) {
  function boundary(position: number): { node: Node; offset: number } {
    let remaining = position;
    function visit(parent: Node): { node: Node; offset: number } | undefined {
      for (const [index, node] of Array.from(parent.childNodes).entries()) {
        if (
          node instanceof HTMLElement &&
          node.dataset.fieldToken !== undefined
        ) {
          const length = node.dataset.fieldToken.length;
          if (remaining <= length)
            return { node: parent, offset: index + (remaining ? 1 : 0) };
          remaining -= length;
        } else if (node.nodeType === Node.TEXT_NODE) {
          const length = node.textContent?.length || 0;
          if (remaining <= length) return { node, offset: remaining };
          remaining -= length;
        } else {
          const found = visit(node);
          if (found) return found;
        }
      }
    }
    return visit(root) || { node: root, offset: root.childNodes.length };
  }
  const from = boundary(Math.max(0, start));
  const to = boundary(Math.max(start, end));
  const range = root.ownerDocument.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  const selection = root.ownerDocument.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}
