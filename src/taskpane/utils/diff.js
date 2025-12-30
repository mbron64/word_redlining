function tokenize(text) {
  return text.match(/\s+|\S+/g) ?? [];
}

export function diffTokens(original, revised, maxCells = 120000) {
  const left = tokenize(original);
  const right = tokenize(revised);

  if (!left.length && !right.length) {
    return [];
  }

  if (left.length * right.length > maxCells) {
    return null;
  }

  const rows = left.length + 1;
  const cols = right.length + 1;
  const dp = Array.from({ length: rows }, () => Array(cols).fill(0));

  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      if (left[i] === right[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const segments = [];
  let i = 0;
  let j = 0;

  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      segments.push({ type: "equal", text: left[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      segments.push({ type: "delete", text: left[i] });
      i += 1;
    } else {
      segments.push({ type: "insert", text: right[j] });
      j += 1;
    }
  }

  while (i < left.length) {
    segments.push({ type: "delete", text: left[i] });
    i += 1;
  }

  while (j < right.length) {
    segments.push({ type: "insert", text: right[j] });
    j += 1;
  }

  return mergeSegments(segments);
}

function mergeSegments(segments) {
  if (!segments.length) {
    return [];
  }

  const merged = [segments[0]];

  for (let i = 1; i < segments.length; i += 1) {
    const prev = merged[merged.length - 1];
    const current = segments[i];

    if (prev.type === current.type) {
      prev.text += current.text;
    } else {
      merged.push({ ...current });
    }
  }

  return merged;
}

export function formatDiff(segments) {
  if (!segments) {
    return "Diff preview skipped (selection too large).";
  }

  return segments
    .map((segment) => {
      if (segment.type === "equal") {
        return segment.text;
      }
      if (segment.type === "delete") {
        return `[-${segment.text}-]`;
      }
      return `[+${segment.text}+]`;
    })
    .join("");
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

export function formatDiffHtml(segments) {
  if (!segments) {
    return "<em>Diff preview skipped (selection too large).</em>";
  }

  return segments
    .map((segment) => {
      const escaped = escapeHtml(segment.text);
      if (segment.type === "equal") {
        return escaped;
      }
      if (segment.type === "delete") {
        return `<span class="diff-delete">${escaped}</span>`;
      }
      return `<span class="diff-insert">${escaped}</span>`;
    })
    .join("");
}
