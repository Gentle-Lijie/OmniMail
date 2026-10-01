export function insertFieldToken(
  value: string,
  field: string,
  start = value.length,
  end = start,
) {
  const from = Math.max(0, Math.min(start, value.length));
  const to = Math.max(from, Math.min(end, value.length));
  const token = `{{${field}}}`;
  return {
    value: value.slice(0, from) + token + value.slice(to),
    caret: from + token.length,
  };
}

export function splitFieldText(
  value: string,
): { text: string; field: boolean }[] {
  const segments: { text: string; field: boolean }[] = [];
  let position = 0;
  for (const match of value.matchAll(/{{\s*[^{}]+?\s*}}/g)) {
    if (match.index > position)
      segments.push({ text: value.slice(position, match.index), field: false });
    segments.push({ text: match[0], field: true });
    position = match.index + match[0].length;
  }
  if (position < value.length)
    segments.push({ text: value.slice(position), field: false });
  return segments;
}
